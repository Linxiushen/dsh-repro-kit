import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildBundle } from '../src/bundle.js'
import { ReproError } from '../src/errors.js'
import type { RedactedSlice } from '../src/types.js'
import { sha256Hex } from '../src/utils.js'

const TIMEZONE_CHILD = 'DSH_REPRO_TIMEZONE_CHILD'
const TIMEZONE_DIGEST_MARKER = 'DSH_REPRO_BUNDLE_SHA256='
const TIMEZONE_DIGEST_TEST = 'emits a bundle digest for timezone comparison'

function fixture(): RedactedSlice {
  const event = {
    type: 'turn/end',
    seq: 0,
    time: 12,
    data: { turn: 4, reason: { kind: 'error', error: { name: 'LlmError', code: 'RATE_LIMIT' } } },
  } as unknown as SessionEvent
  return {
    source: {
      kind: 'zip',
      bytes: 1_234,
      sessionCount: 1,
      omittedAttachments: [{ id: 'attachment-001', bytes: 99, reason: 'privacy-default' }],
    },
    requestedTarget: { kind: 'last-error' },
    target: { kind: 'last-error', sessionId: 'session-001', originalSeq: 9, eventType: 'turn/end' },
    sessions: [{
      header: { type: 'session', version: 0, id: 'session-001', createdAt: 0, delegationDepth: 0 },
      events: [event],
      originalSeqs: [9],
      lineageOnly: false,
    }],
    counts: { identifiers: 3, textValues: 0, secrets: 0, paths: 0 },
  }
}

function bundleDigestInTimezone(timezone: string): string {
  const vitestCli = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
  const testFile = fileURLToPath(import.meta.url)
  const output = execFileSync(
    process.execPath,
    [vitestCli, 'run', testFile, '-t', TIMEZONE_DIGEST_TEST, '--reporter=verbose'],
    {
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0', TZ: timezone, [TIMEZONE_CHILD]: '1' },
    },
  )
  const digest = output.match(new RegExp(`${TIMEZONE_DIGEST_MARKER}([a-f0-9]{64})`))?.[1]
  if (digest === undefined) throw new Error(`timezone child did not emit a bundle digest:\n${output}`)
  return digest
}

describe('buildBundle', () => {
  it('produces identical bytes for identical input', () => {
    const first = buildBundle(fixture())
    const second = buildBundle(fixture())
    expect(sha256Hex(first.bytes)).toBe(sha256Hex(second.bytes))
    expect(first.bytes).toEqual(second.bytes)
  })

  it('contains only redacted payloads with valid hashes', () => {
    const artifact = buildBundle(fixture())
    const files = unzipSync(artifact.bytes)
    expect(Object.keys(files)).toEqual(['manifest.json', 'REPORT.md', 'sessions/session-001.jsonl'])

    const manifestText = new TextDecoder().decode(files['manifest.json'])
    expect(manifestText).toContain('attachment-001')
    for (const record of artifact.manifest.files) {
      expect(sha256Hex(files[record.path]!)).toBe(record.sha256)
    }
  })

  it('rejects a structurally forged RedactedSlice containing raw sensitive values', () => {
    const forged = structuredClone(fixture()) as unknown as {
      sessions: { events: { data: Record<string, unknown> }[] }[]
    }
    forged.sessions[0]!.events[0]!.data['prompt'] = 'private prompt'
    forged.sessions[0]!.events[0]!.data['apiKey'] = 'sk-private-token-12345678'
    expect(() => buildBundle(forged as unknown as RedactedSlice)).toThrowError(ReproError)
    try {
      buildBundle(forged as unknown as RedactedSlice)
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'INVALID_SESSION' })
      expect(String(error)).not.toContain('private prompt')
      expect(String(error)).not.toContain('sk-private-token')
    }
  })

  it('rejects excessive JSON depth before serialization', () => {
    const forged = structuredClone(fixture()) as unknown as {
      sessions: { events: { data: Record<string, unknown> }[] }[]
    }
    let nested: Record<string, unknown> = {}
    forged.sessions[0]!.events[0]!.data['nested'] = nested
    for (let depth = 0; depth < 200; depth += 1) {
      const child: Record<string, unknown> = {}
      nested['child'] = child
      nested = child
    }
    expect(() => buildBundle(forged as unknown as RedactedSlice)).toThrowError(/depth budget/)
  })

  if (process.env[TIMEZONE_CHILD] === '1') {
    it(TIMEZONE_DIGEST_TEST, () => {
      process.stdout.write(`${TIMEZONE_DIGEST_MARKER}${sha256Hex(buildBundle(fixture()).bytes)}\n`)
    })
  } else {
    it('produces identical ZIP bytes in UTC and Asia/Shanghai', () => {
      expect(bundleDigestInTimezone('UTC')).toBe(bundleDigestInTimezone('Asia/Shanghai'))
    })
  }
})
