import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildBundle } from '../src/bundle.js'
import type { RedactedSlice } from '../src/types.js'
import { sha256Hex } from '../src/utils.js'

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
    counts: { identifiers: 1, textValues: 2, secrets: 3, paths: 4 },
  }
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
})
