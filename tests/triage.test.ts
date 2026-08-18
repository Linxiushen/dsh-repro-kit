import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { inspectExport } from '../src/inspect.js'
import { sliceExport } from '../src/slice.js'
import { triageExport } from '../src/triage.js'
import type { LoadedExport, ParsedSession } from '../src/types.js'

function event(
  type: string,
  seq: number,
  time: number,
  data: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): SessionEvent {
  return { type, seq, time, data, ...extra } as unknown as SessionEvent
}

function session(id: string, path: string, events: readonly SessionEvent[]): ParsedSession {
  return {
    sourcePath: path,
    header: { type: 'session', version: 0, id, createdAt: 0, delegationDepth: 0 },
    events,
    sourceSha256: `sha-${id}`,
    sourceBytes: 1,
  }
}

function loaded(...sessions: ParsedSession[]): LoadedExport {
  return {
    kind: sessions.length === 1 ? 'jsonl' : 'zip',
    sourceSha256: 'source',
    sourceBytes: 100,
    sessions,
    attachments: [],
  }
}

function failedTurn(secret: string, offset = 0): SessionEvent[] {
  return [
    event('request/header', offset, 10, {
      reason: 'initial',
      header: { config: { provider: 'deepseek', model: 'deepseek-chat' }, system: secret },
    }),
    event('request/context', offset + 1, 11, { provider: 'deepseek', model: 'deepseek-chat' }),
    event('turn/start', offset + 2, 12, { turn: 1 }),
    event('step/start', offset + 3, 13, { turn: 1, step: 1 }),
    event('tool/call', offset + 4, 14, {
      turn: 1, step: 1, callId: `private-call-${secret}`, name: 'read_file', arguments: secret,
    }),
    event('tool/result', offset + 5, 15, {
      turn: 1,
      step: 1,
      message: {
        id: `message-${secret}`,
        role: 'user',
        source: { kind: 'tool', callId: `private-call-${secret}` },
        content: [{
          type: 'tool-result', toolCallId: `private-call-${secret}`,
          content: [{ type: 'text', text: secret }], isError: true,
        }],
      },
      error: { name: 'PermissionError', code: 'EACCES', message: secret },
    }, { surfaceOp: 'append', sourceEventSeqs: [offset + 4] }),
    event('assistant/chunk', offset + 6, 16, {
      turn: 1, step: 1,
      chunk: { type: 'finish', reason: { kind: 'error', failure: { name: 'PermissionError', code: 'EACCES', message: secret } } },
    }),
    event('step/end', offset + 7, 17, { turn: 1, step: 1 }),
    event('turn/end', offset + 8, 18, {
      turn: 1, reason: { kind: 'error', error: { name: 'PermissionError', code: 'EACCES', message: secret } },
    }),
  ]
}

describe('triageExport', () => {
  it('correlates one failed turn and chooses the most specific first evidence', () => {
    const source = loaded(session('root-private', 'root.jsonl', failedTurn('do-not-return-this')))
    const result = triageExport(source)

    expect(result).toMatchObject({ version: 1, incidentCount: 1 })
    expect(result.incidents[0]).toMatchObject({
      sessionId: 'root-private',
      selector: { kind: 'seq', seq: 5, sessionId: 'root-private' },
      primaryEvidence: {
        seq: 5,
        eventType: 'tool/result',
        kind: 'tool',
        provider: 'deepseek',
        model: 'deepseek-chat',
        toolName: 'read_file',
        errorName: 'PermissionError',
        errorCode: 'EACCES',
      },
      relatedSeqs: [5, 6, 8],
      failedStepCount: 1,
    })
    expect(result.incidents[0]?.fingerprint).toMatch(/^dsh-failure-v1:[a-f\d]{64}$/)
    expect(result.incidents[0]?.evidence.map(item => item.eventType)).toEqual([
      'tool/result', 'assistant/chunk', 'turn/end',
    ])

    const sliced = sliceExport(source, result.incidents[0]!.selector)
    expect(sliced.target).toMatchObject({ originalSeq: 5, eventType: 'tool/result' })
    expect(JSON.stringify(result)).not.toContain('do-not-return-this')
    expect(JSON.stringify(result)).not.toContain('private-call')
  })

  it('uses one shared classifier for inspect, triage, and last-error', () => {
    const events = [
      event('command/done', 0, 1, { commandId: 'c', kind: 'error', text: 'private command text' }),
      event('compaction/end', 1, 2, { compactionId: 'p', turn: null, error: 'private compaction text' }),
      event('tool/code-dispatch', 2, 3, {
        rootCallId: 'root-call', parentCallId: 'parent-call', subCallId: 'sub-call',
        name: 'read', arguments: { secret: 'private' }, content: [], isError: true,
      }),
      event('tool-workflow/agent-end', 3, 4, { runId: 'run-private', seq: 1, outcome: 'failed' }),
      event('tool-workflow/run-end', 4, 5, { runId: 'run-private', stopReason: 'error' }),
      event('hook/error', 5, 6, { message: 'private hook text' }),
    ]
    const source = loaded(session('root', 'root.jsonl', events))

    expect(inspectExport(source).sessions[0]?.errorCount).toBe(6)
    expect(triageExport(source).incidentCount).toBe(5)
    expect(sliceExport(source, { kind: 'last-error' }).target).toMatchObject({
      originalSeq: 5, eventType: 'hook/error',
    })
    const serialized = JSON.stringify(triageExport(source))
    expect(serialized).not.toContain('private command text')
    expect(serialized).not.toContain('private compaction text')
    expect(serialized).not.toContain('private hook text')
  })

  it('correlates reused call ids and workflow runs with the latest eligible call', () => {
    const events = [
      event('tool/call', 0, 1, {
        turn: 1, step: 1, callId: 'shared', name: 'old_read', arguments: '{}',
      }),
      event('tool/result', 1, 2, { turn: 1, step: 1, callId: 'shared' }),
      event('tool/call', 2, 3, {
        turn: 2, step: 1, callId: 'shared', name: 'current_read', arguments: '{}',
      }),
      event('tool/result', 3, 4, {
        turn: 2, step: 1, callId: 'shared', error: { code: 'E_CURRENT' },
      }),
      event('tool/call', 4, 5, {
        turn: 3, step: 1, callId: 'outer', name: 'workflow', arguments: '{}',
      }),
      event('tool/call', 5, 6, {
        turn: 3, step: 1, callId: 'inner', name: 'nested_read', arguments: '{}',
      }),
      event('tool/result', 6, 7, { turn: 3, step: 1, callId: 'inner' }),
      event('tool-workflow/run-start', 7, 8, { runId: 'run' }),
      event('tool-workflow/agent-end', 8, 9, { runId: 'run', outcome: 'failed' }),
    ]
    const result = triageExport(loaded(session('root', 'root.jsonl', events)))

    expect(result.incidentCount).toBe(2)
    expect(result.incidents.find(incident => incident.primaryEvidence.seq === 3)?.primaryEvidence)
      .toMatchObject({ turn: 2, step: 1, toolName: 'current_read', errorCode: 'E_CURRENT' })
    expect(result.incidents.find(incident => incident.primaryEvidence.seq === 8)?.primaryEvidence)
      .toMatchObject({ turn: 3, step: 1, toolName: 'workflow' })
  })

  it('keeps fingerprints stable across ids, clocks, paths, sequence offsets, and message text', () => {
    const first = triageExport(loaded(session('first-id', 'z/private.jsonl', failedTurn('first-secret'))))
    const shifted = failedTurn('second-secret', 10).map(item => ({ ...item, time: item.time + 50_000 })) as SessionEvent[]
    const second = triageExport(loaded(session('second-id', 'a/other.jsonl', shifted)))

    expect(first.incidents[0]?.fingerprint).toBe(second.incidents[0]?.fingerprint)
    expect(first.incidents[0]?.selector.seq).not.toBe(second.incidents[0]?.selector.seq)
  })

  it('orders cross-session incidents by epoch time with stable identity ties', () => {
    const earlier = session('earlier', 'z.jsonl', [event('hook/error', 0, 10, {})])
    const later = session('later', 'a.jsonl', [event('hook/error', 0, 20, {})])
    expect(triageExport(loaded(earlier, later)).incidents.map(item => item.sessionId)).toEqual(['later', 'earlier'])

    const tiedA = session('a', 'a.jsonl', [event('hook/error', 0, 20, {})])
    const tiedZ = session('z', 'z.jsonl', [event('hook/error', 0, 20, {})])
    const forward = triageExport(loaded(tiedZ, tiedA)).incidents.map(item => item.sessionId)
    const reverse = triageExport(loaded(tiedA, tiedZ)).incidents.map(item => item.sessionId)
    expect(forward).toEqual(reverse)
  })

  it('redacts suspicious diagnostic metadata and handles a clean export', () => {
    const risky = loaded(session('root', 'root.jsonl', [
      event('request/context', 0, 1, { provider: 'sk-private-provider-token', model: 'https://private.example' }),
      event('turn/end', 1, 2, {
        turn: 1,
        reason: { kind: 'error', error: { name: 'alice@example.com', code: 'E_PRIVATE' } },
      }),
    ]))
    expect(triageExport(risky).incidents[0]?.primaryEvidence).toMatchObject({
      provider: '<redacted-metadata>',
      model: '<redacted-metadata>',
      errorName: '<redacted-metadata>',
      errorCode: 'E_PRIVATE',
    })

    const clean = triageExport(loaded(session('clean', 'clean.jsonl', [
      event('turn/end', 0, 1, { turn: 1, reason: { kind: 'completed' } }),
    ])))
    expect(clean).toMatchObject({ incidentCount: 0, incidents: [] })

    const unsafeType = triageExport(loaded(session('root', 'root.jsonl', [
      event('plugin\u001B[31m/error', 0, 1, { message: 'private terminal text' }),
    ])))
    expect(unsafeType.incidents[0]?.primaryEvidence.eventType).toBe('<redacted-metadata>')
    expect(JSON.stringify(unsafeType)).not.toContain('\u001B')
  })
})
