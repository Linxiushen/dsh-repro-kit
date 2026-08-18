import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { ReproError } from '../src/errors.js'
import { sliceExport } from '../src/slice.js'
import type { LoadedExport, ParsedSession, SessionHeaderRecord } from '../src/types.js'

function event(
  type: string,
  seq: number,
  time: number,
  data: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): SessionEvent {
  return { type, seq, time, data, ...extra } as unknown as SessionEvent
}

function header(
  id: string,
  options: { readonly parentSession?: string; readonly seedLength?: number; readonly depth?: number } = {},
): SessionHeaderRecord {
  return {
    type: 'session',
    version: 0,
    id,
    createdAt: 1,
    delegationDepth: options.depth ?? 0,
    ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession, origin: 'subagent' }),
    ...(options.seedLength === undefined ? {} : { seedLength: options.seedLength }),
  }
}

function session(
  id: string,
  sourcePath: string,
  events: readonly SessionEvent[],
  options?: Parameters<typeof header>[1],
): ParsedSession {
  return {
    sourcePath,
    header: header(id, options),
    events,
    sourceSha256: `sha-${id}`,
    sourceBytes: 1,
  }
}

function loaded(...sessions: ParsedSession[]): LoadedExport {
  return {
    kind: sessions.length === 1 ? 'jsonl' : 'zip',
    sourceSha256: 'source-sha',
    sourceBytes: 10,
    sessions,
    attachments: [],
  }
}

function toolResult(
  callId: string,
  error?: Record<string, unknown>,
  isError = false,
): Record<string, unknown> {
  return {
    turn: 1,
    step: 1,
    message: {
      id: `result-${callId}`,
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        content: [{ type: 'text', text: 'done' }],
        ...(isError ? { isError: true } : {}),
      }],
      source: { kind: 'tool', callId },
    },
    ...(error === undefined ? {} : { error }),
  }
}

describe('slice target resolution', () => {
  it.each([
    ['turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'failed', code: 'E' } } }],
    ['tool/result', toolResult('call-error', { name: 'Error', code: 'E' })],
    ['tool/result', toolResult('call-surface-error', undefined, true)],
    ['command/done', { commandId: 'command-error', kind: 'error', text: 'command failed' }],
    ['compaction/end', { compactionId: 'compact-error', turn: null, error: 'compaction failed' }],
    ['tool/code-dispatch', {
      rootCallId: 'root', parentCallId: 'parent', subCallId: 'child', name: 'read', arguments: {},
      content: [], isError: true,
    }],
    ['tool-workflow/agent-end', { runId: 'run', seq: 1, outcome: 'failed' }],
    ['tool-workflow/run-end', { runId: 'run', stopReason: 'error' }],
    ['hook/error', { message: 'hook failed' }],
    ['assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'finish', reason: { kind: 'error', failure: { message: 'failed', code: 'E' } } },
    }],
  ])('recognizes %s as a last-error candidate', (type, data) => {
    const source = loaded(session('only', 'only.jsonl', [event(type, 0, 10, data)]))
    expect(sliceExport(source, { kind: 'last-error' }).target).toMatchObject({
      sessionId: 'only',
      originalSeq: 0,
      eventType: type,
    })
  })

  it('uses seq within a session even when its event clock moves backwards', () => {
    const source = loaded(session('only', 'only.jsonl', [
      event('command/done', 0, 500, { commandId: 'first', kind: 'error', text: 'first' }),
      event('compaction/end', 1, 10, { compactionId: 'second', turn: null, error: 'second' }),
    ]))

    expect(sliceExport(source, { kind: 'last-error' }).target).toMatchObject({
      sessionId: 'only', originalSeq: 1, eventType: 'compaction/end',
    })
  })

  it('uses epoch time across sessions and stable identity for equal timestamps', () => {
    const earlyPath = session('a', 'a/session.jsonl', [event('hook/error', 0, 500, {})])
    const latePath = session('z', 'z/session.jsonl', [event('hook/error', 0, 10, {})])

    for (const source of [loaded(earlyPath, latePath), loaded(latePath, earlyPath)]) {
      expect(sliceExport(source, { kind: 'last-error' }).target).toMatchObject({
        sessionId: 'a', originalSeq: 0,
      })
    }

    const tiedA = session('a', 'a/session.jsonl', [event('hook/error', 0, 10, {})])
    const tiedZ = session('z', 'z/session.jsonl', [event('hook/error', 0, 10, {})])
    for (const source of [loaded(tiedA, tiedZ), loaded(tiedZ, tiedA)]) {
      expect(sliceExport(source, { kind: 'last-error' }).target.sessionId).toBe('z')
    }
  })

  it('reports ambiguous seq and tool-call selectors with stable details', () => {
    const first = session('first', 'first.jsonl', [
      event('tool/call', 0, 1, { turn: 1, step: 1, callId: 'shared', name: 'read', arguments: '{}' }),
    ])
    const second = session('second', 'second.jsonl', [
      event('tool/call', 0, 2, { turn: 1, step: 1, callId: 'shared', name: 'read', arguments: '{}' }),
    ])
    const source = loaded(first, second)

    for (const target of [{ kind: 'seq', seq: 0 }, { kind: 'tool-call', callId: 'shared' }] as const) {
      let thrown: unknown
      try {
        sliceExport(source, target)
      } catch (error: unknown) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(ReproError)
      expect(thrown).toMatchObject({
        code: 'TARGET_NOT_FOUND',
        details: { reason: 'ambiguous', matchCount: 2 },
      })
      expect((thrown as ReproError).details['candidates']).toHaveLength(2)
    }

    expect(sliceExport(source, { kind: 'tool-call', callId: 'shared', sessionId: 'second' }).target)
      .toMatchObject({ sessionId: 'second', originalSeq: 0 })
  })
})

describe('causal slice closure', () => {
  it('closes and remaps command and compaction summary sequence references', () => {
    const events = [
      event('todo/write', 0, 0, { todos: [{ content: 'unrelated-0', status: 'pending' }] }),
      event('user/message', 1, 1, {
        id: 'first', role: 'user', content: [{ type: 'text', text: 'first' }], source: { kind: 'user' },
      }, { surfaceOp: 'append' }),
      event('todo/write', 2, 2, { todos: [{ content: 'unrelated-2', status: 'pending' }] }),
      event('user/message', 3, 3, {
        id: 'second', role: 'user', content: [{ type: 'text', text: 'second' }], source: { kind: 'user' },
      }, { surfaceOp: 'append' }),
      event('compaction/summary', 4, 4, {
        compactionId: 'compact-1', summary: [{ type: 'text', text: 'summary' }],
        shadowedRange: { start: 1, end: 3 }, shadowedSeqs: [1, 3], shadowedTokenCount: 2,
        provider: 'deepseek', model: 'deepseek-chat',
      }),
      event('command/done', 5, 5, {
        commandId: 'command-1', kind: 'success', sourceEventSeq: 4,
      }),
    ]

    const sliced = sliceExport(loaded(session('root', 'root.jsonl', events)), { kind: 'seq', seq: 5 }).sessions[0]
    expect(sliced?.originalSeqs).toEqual([1, 3, 4, 5])
    expect(sliced?.events[2]).toMatchObject({
      type: 'compaction/summary',
      data: { shadowedRange: { start: 0, end: 1 }, shadowedSeqs: [0, 1] },
    })
    expect(sliced?.events[3]).toMatchObject({
      type: 'command/done', data: { sourceEventSeq: 2 },
    })
    expect(JSON.stringify(sliced?.events)).not.toContain('unrelated')
  })

  it('preserves surface order when a prune range starts above its numeric end', () => {
    const events = [
      event('user/message', 0, 0, {
        id: 'first', role: 'user', content: [{ type: 'text', text: 'first' }], source: { kind: 'user' },
      }, { surfaceOp: 'append' }),
      event('todo/write', 1, 1, { todos: [{ content: 'gap-1', status: 'pending' }] }),
      event('user/message', 2, 2, {
        id: 'last', role: 'user', content: [{ type: 'text', text: 'last' }], source: { kind: 'user' },
      }, { surfaceOp: 'append' }),
      event('todo/write', 3, 3, { todos: [{ content: 'gap-3', status: 'pending' }] }),
      event('user/message', 4, 4, {
        id: 'last-replacement', role: 'user', content: [{ type: 'text', text: 'last replacement' }],
        source: { kind: 'user' },
      }, { surfaceOp: { op: 'replace', start: 2, end: 2 }, sourceEventSeqs: [2] }),
      event('todo/write', 5, 5, { todos: [{ content: 'gap-5', status: 'pending' }] }),
      event('user/message', 6, 6, {
        id: 'first-replacement', role: 'user', content: [{ type: 'text', text: 'first replacement' }],
        source: { kind: 'user' },
      }, { surfaceOp: { op: 'replace', start: 0, end: 0 }, sourceEventSeqs: [0] }),
      event('compaction/prune', 7, 7, {
        shadowedRange: { start: 6, end: 4 }, shadowedSeqs: [6, 4], shadowedTokenCount: 2,
      }),
    ]

    const sliced = sliceExport(loaded(session('root', 'root.jsonl', events)), { kind: 'seq', seq: 7 }).sessions[0]
    expect(sliced?.originalSeqs).toEqual([0, 2, 4, 6, 7])
    expect(sliced?.events[4]).toMatchObject({
      type: 'compaction/prune',
      data: { shadowedRange: { start: 3, end: 2 }, shadowedSeqs: [3, 2] },
    })
    expect(JSON.stringify(sliced?.events)).not.toContain('gap-')
  })

  it('includes the target turn, recursive sources and boundaries, and rewrites surface references', () => {
    const events = [
      event('turn/start', 0, 0, { turn: 1 }),
      event('step/start', 1, 1, { turn: 1, step: 1 }),
      event('todo/write', 2, 2, { todos: [{ content: 'unrelated', status: 'pending' }] }),
      event('assistant/chunk', 3, 3, {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'call' },
      }),
      event('assistant/message', 4, 4, {
        turn: 1,
        step: 1,
        message: {
          id: 'assistant-1',
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' }],
          source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
        },
      }, { surfaceOp: 'append', sourceEventSeqs: [3] }),
      event('tool/call', 5, 5, { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{}' }),
      event('tool/result', 6, 6, toolResult('call-1'), { surfaceOp: 'append', sourceEventSeqs: [5] }),
      event('step/end', 7, 7, { turn: 1, step: 1 }),
      event('turn/end', 8, 8, { turn: 1, reason: { kind: 'completed' } }),
      event('turn/start', 9, 9, { turn: 2 }),
      event('step/start', 10, 10, { turn: 2, step: 1 }),
      event('user/message', 11, 11, {
        id: 'summary',
        role: 'user',
        content: [{ type: 'text', text: 'summary' }],
        source: { kind: 'user' },
      }, { surfaceOp: { op: 'replace', start: 4, end: 6 }, sourceEventSeqs: [4, 6] }),
      event('step/end', 12, 12, { turn: 2, step: 1 }),
      event('turn/end', 13, 13, { turn: 2, reason: { kind: 'completed' } }),
    ]
    const result = sliceExport(loaded(session('root', 'root.jsonl', events)), { kind: 'seq', seq: 11 })
    const sliced = result.sessions[0]

    expect(sliced?.originalSeqs).toEqual([0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
    expect(sliced?.events.map(item => item.seq)).toEqual([...Array(13).keys()])
    expect(sliced?.events[3]).toMatchObject({ sourceEventSeqs: [2] })
    expect(sliced?.events[5]).toMatchObject({ sourceEventSeqs: [4] })
    expect(sliced?.events[10]).toMatchObject({
      sourceEventSeqs: [3, 5],
      surfaceOp: { op: 'replace', start: 3, end: 5 },
    })
    expect(JSON.stringify(sliced?.events)).not.toContain('unrelated')
  })

  it('adds nearest request state, maps seed length, and emits loaded ancestors as lineage-only', () => {
    const childEvents = [
      event('turn/start', 0, 0, { turn: 1 }),
      event('step/start', 1, 1, { turn: 1, step: 1 }),
      event('request/header', 2, 2, {
        reason: 'initial',
        header: { config: { provider: 'deepseek', model: 'deepseek-chat' } },
      }),
      event('request/context', 3, 3, { provider: 'deepseek', model: 'deepseek-chat' }),
      event('assistant/chunk', 4, 4, {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'old' },
      }),
      event('assistant/message', 5, 5, {
        turn: 1,
        step: 1,
        message: {
          id: 'old', role: 'assistant', content: [{ type: 'text', text: 'old' }],
          source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
        },
      }, { surfaceOp: 'append', sourceEventSeqs: [4] }),
      event('step/end', 6, 6, { turn: 1, step: 1 }),
      event('turn/end', 7, 7, { turn: 1, reason: { kind: 'completed' } }),
      event('turn/start', 8, 8, { turn: 2 }),
      event('step/start', 9, 9, { turn: 2, step: 1 }),
      event('assistant/chunk', 10, 10, {
        turn: 2,
        step: 1,
        chunk: { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'E' } } },
      }),
      event('step/end', 11, 11, { turn: 2, step: 1 }),
      event('turn/end', 12, 12, {
        turn: 2,
        reason: { kind: 'error', error: { message: 'boom', code: 'E' } },
      }),
    ]
    const root = session('root', 'root.jsonl', [], { seedLength: 20 })
    const parent = session('parent', 'parent.jsonl', [], {
      parentSession: 'root', seedLength: 10, depth: 1,
    })
    const child = session('child', 'child.jsonl', childEvents, {
      parentSession: 'parent', seedLength: 9, depth: 2,
    })
    const result = sliceExport(loaded(child, root, parent), { kind: 'last-error' })

    expect(result.sessions.map(item => [item.header.id, item.lineageOnly, item.header.seedLength])).toEqual([
      ['root', true, 0],
      ['parent', true, 0],
      ['child', false, 7],
    ])
    const sliced = result.sessions[2]
    expect(sliced?.originalSeqs).toEqual([0, 1, 2, 3, 6, 7, 8, 9, 10, 11, 12])
    expect(sliced?.events.map(item => item.type)).toContain('request/header')
    expect(sliced?.events.map(item => item.type)).toContain('request/context')
    expect(JSON.stringify(sliced?.events)).not.toContain('"old"')
  })

  it('drops dangling provenance while preserving an explicitly empty assistant source list', () => {
    const events = [
      event('turn/start', 0, 0, { turn: 1 }),
      event('step/start', 1, 1, { turn: 1, step: 1 }),
      event('assistant/message', 2, 2, {
        turn: 1,
        step: 1,
        message: {
          id: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'done' }],
          source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
        },
      }, { surfaceOp: 'append', sourceEventSeqs: [99] }),
      event('assistant/message', 3, 3, {
        turn: 1,
        step: 1,
        message: {
          id: 'empty', role: 'assistant', content: [],
          source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
        },
      }, { surfaceOp: 'append', sourceEventSeqs: [] }),
      event('step/end', 4, 4, { turn: 1, step: 1 }),
      event('turn/end', 5, 5, { turn: 1, reason: { kind: 'completed' } }),
    ]
    const sliced = sliceExport(loaded(session('root', 'root.jsonl', events)), { kind: 'seq', seq: 2 }).sessions[0]
    expect(sliced?.events[2]).toMatchObject({ sourceEventSeqs: [] })
    expect(sliced?.events[3]).toMatchObject({ sourceEventSeqs: [] })
  })

  it('pairs tool records within their turn and step when call ids are reused', () => {
    const toolTurn = (start: number, turn: number): SessionEvent[] => [
      event('turn/start', start, start, { turn }),
      event('step/start', start + 1, start + 1, { turn, step: 1 }),
      event('assistant/chunk', start + 2, start + 2, {
        turn,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: `turn-${turn}` },
      }),
      event('assistant/message', start + 3, start + 3, {
        turn,
        step: 1,
        message: {
          id: `assistant-${turn}`,
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'reused', name: 'read', arguments: '{}' }],
          source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
        },
      }, { surfaceOp: 'append', sourceEventSeqs: [start + 2] }),
      event('tool/call', start + 4, start + 4, {
        turn, step: 1, callId: 'reused', name: 'read', arguments: '{}',
      }),
      event('tool/result', start + 5, start + 5, {
        ...toolResult('reused'), turn, step: 1,
      }, { surfaceOp: 'append', sourceEventSeqs: [start + 4] }),
      event('step/end', start + 6, start + 6, { turn, step: 1 }),
      event('turn/end', start + 7, start + 7, { turn, reason: { kind: 'completed' } }),
    ]
    const events = [
      ...toolTurn(0, 1),
      ...toolTurn(8, 2),
      event('turn/start', 16, 16, { turn: 3 }),
      event('step/start', 17, 17, { turn: 3, step: 1 }),
      event('user/message', 18, 18, {
        id: 'summary', role: 'user', content: [{ type: 'text', text: 'summary' }], source: { kind: 'user' },
      }, { surfaceOp: { op: 'replace', start: 5, end: 5 }, sourceEventSeqs: [5] }),
      event('step/end', 19, 19, { turn: 3, step: 1 }),
      event('turn/end', 20, 20, { turn: 3, reason: { kind: 'completed' } }),
    ]

    const sliced = sliceExport(loaded(session('root', 'root.jsonl', events)), { kind: 'seq', seq: 18 }).sessions[0]
    expect(sliced?.originalSeqs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20])
    expect(JSON.stringify(sliced?.events)).not.toContain('turn-2')
  })
})
