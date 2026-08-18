import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildBundle } from '../src/bundle.js'
import { ReproError } from '../src/errors.js'
import type { RedactedSlice } from '../src/types.js'
import { sha256Hex } from '../src/utils.js'
import { verifyBundle } from '../src/verify.js'

function fixture(): RedactedSlice {
  const context = { type: 'fixture/context', seq: 0, time: 3, data: { lossy: 0 } } as unknown as SessionEvent
  const target = {
    type: 'turn/end', seq: 1, time: 4, data: { turn: 1, reason: { kind: 'error', error: { code: 'FAIL' } } },
  } as unknown as SessionEvent
  return {
    source: {
      kind: 'jsonl',
      bytes: 10,
      sessionCount: 1,
      omittedAttachments: [],
    },
    requestedTarget: { kind: 'last-error' },
    target: { kind: 'last-error', sessionId: 'session-001', originalSeq: 7, eventType: 'turn/end' },
    sessions: [{
      header: { type: 'session', version: 0, id: 'session-001', createdAt: 0, delegationDepth: 0 },
      events: [context, target],
      originalSeqs: [6, 7],
      lineageOnly: false,
    }],
    counts: { identifiers: 2, textValues: 0, secrets: 0, paths: 0 },
  }
}

type JsonObject = Record<string, unknown>

function rewriteManifest(bytes: Uint8Array, mutate: (manifest: JsonObject) => void): Uint8Array {
  const files = unzipSync(bytes)
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as JsonObject
  mutate(manifest)
  files['manifest.json'] = new TextEncoder().encode(`${JSON.stringify(manifest)}\n`)
  return zipSync(files)
}

function rewriteFirstSession(bytes: Uint8Array, mutate: (text: string) => string): Uint8Array {
  const files = unzipSync(bytes)
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as JsonObject
  const session = (manifest['sessions'] as JsonObject[])[0] as JsonObject
  const path = session['file'] as string
  const payload = new TextEncoder().encode(mutate(new TextDecoder().decode(files[path])))
  files[path] = payload
  const file = (manifest['files'] as JsonObject[]).find(item => item['path'] === path) as JsonObject
  file['bytes'] = payload.byteLength
  file['sha256'] = sha256Hex(payload)
  files['manifest.json'] = new TextEncoder().encode(`${JSON.stringify(manifest)}\n`)
  return zipSync(files)
}

function rewriteReport(bytes: Uint8Array, report: string): Uint8Array {
  const files = unzipSync(bytes)
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as JsonObject
  const payload = new TextEncoder().encode(report)
  files['REPORT.md'] = payload
  const file = (manifest['files'] as JsonObject[]).find(item => item['path'] === 'REPORT.md') as JsonObject
  file['bytes'] = payload.byteLength
  file['sha256'] = sha256Hex(payload)
  files['manifest.json'] = new TextEncoder().encode(`${JSON.stringify(manifest)}\n`)
  return zipSync(files)
}

describe('verifyBundle', () => {
  it('verifies a generated bundle', async () => {
    const artifact = buildBundle(fixture())
    await expect(verifyBundle(artifact.bytes)).resolves.toMatchObject({
      valid: true,
      authenticity: 'not-verified',
      checks: {
        payloadIntegrity: 'verified',
        harnessStructure: 'verified',
        redactionPolicy: 'verified',
        canonicalReport: 'verified',
      },
      verifiedFiles: 2,
      verifiedSessions: 1,
    })
  })

  it('detects payload tampering', async () => {
    const files = unzipSync(buildBundle(fixture()).bytes)
    const report = files['REPORT.md']!
    report[0] = (report[0] ?? 0) ^ 1
    const tampered = zipSync(files)
    await expect(verifyBundle(tampered)).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' } satisfies Partial<ReproError>)
  })

  it('rejects unmanifested entries', async () => {
    const files = unzipSync(buildBundle(fixture()).bytes)
    const extra = zipSync({ ...files, 'sessions/session-999.jsonl': new Uint8Array() })
    await expect(verifyBundle(extra)).rejects.toMatchObject({ code: 'INVALID_BUNDLE' } satisfies Partial<ReproError>)
  })

  it('rejects raw sensitive values even when the session hash is updated', async () => {
    const forged = rewriteFirstSession(
      buildBundle(fixture()).bytes,
      text => text.replace('"lossy":0', '"apiKey":"sk-private-token-12345678","lossy":0,"prompt":"private prompt"'),
    )
    await expect(verifyBundle(forged)).rejects.toMatchObject({ code: 'INVALID_BUNDLE' } satisfies Partial<ReproError>)
  })

  it('rejects forged redaction counts', async () => {
    const forged = rewriteManifest(buildBundle(fixture()).bytes, (manifest) => {
      const counts = (manifest['redaction'] as JsonObject)['counts'] as JsonObject
      counts['identifiers'] = 999
    })
    await expect(verifyBundle(forged)).rejects.toMatchObject({ code: 'INVALID_BUNDLE' } satisfies Partial<ReproError>)
  })

  it('rejects a rehashed non-canonical report', async () => {
    const forged = rewriteReport(buildBundle(fixture()).bytes, '# private report\n\nsk-private-token-12345678\n')
    await expect(verifyBundle(forged)).rejects.toMatchObject({ code: 'INVALID_BUNDLE' } satisfies Partial<ReproError>)
  })

  it.each([
    ['a non-alias selection sessionId', (manifest: JsonObject) => {
      (manifest['selection'] as JsonObject)['sessionId'] = 'raw-session-id'
    }],
    ['an empty selection eventType', (manifest: JsonObject) => {
      (manifest['selection'] as JsonObject)['eventType'] = ''
    }],
    ['an empty redaction notice', (manifest: JsonObject) => {
      (manifest['redaction'] as JsonObject)['notice'] = ''
    }],
    ['a non-alias parentSession', (manifest: JsonObject) => {
      ((manifest['sessions'] as JsonObject[])[0] as JsonObject)['parentSession'] = 'raw-parent-id'
    }],
  ])('rejects manifest schema violation: %s', async (_label, mutate) => {
    const malformed = rewriteManifest(buildBundle(fixture()).bytes, mutate)
    await expect(verifyBundle(malformed)).rejects.toMatchObject({ code: 'INVALID_BUNDLE' } satisfies Partial<ReproError>)
  })

  it('rejects an empty non-target event type', async () => {
    const malformed = rewriteFirstSession(
      buildBundle(fixture()).bytes,
      text => text.replace('"type":"fixture/context"', '"type":""'),
    )
    await expect(verifyBundle(malformed)).rejects.toMatchObject({ code: 'INVALID_BUNDLE' } satisfies Partial<ReproError>)
  })

  it.each(['-0', '1e400'])('rejects non-lossless event JSON number %s', async (literal) => {
    const malformed = rewriteFirstSession(
      buildBundle(fixture()).bytes,
      text => text.replace('"lossy":0', `"lossy":${literal}`),
    )
    await expect(verifyBundle(malformed)).rejects.toMatchObject({ code: 'INVALID_BUNDLE' } satisfies Partial<ReproError>)
  })
})
