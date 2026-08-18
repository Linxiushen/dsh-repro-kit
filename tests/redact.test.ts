import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { redactSlice } from '../src/redact.js'
import type { LoadedExport, SliceResult } from '../src/types.js'

function fixture(): SliceResult {
  const events = [
    {
      type: 'request/header',
      seq: 0,
      time: 1_005,
      data: {
        header: {
          config: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-very-secret-value' },
          system: 'private system',
        },
        reason: 'initial',
      },
    },
    {
      type: 'assistant/message',
      seq: 1,
      time: 1_006,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'assistant-message',
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'real-call', name: 'shell', arguments: '{"cmd":"whoami"}' }],
          source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
        },
      },
      sourceEventSeqs: [],
      surfaceOp: 'append',
    },
    {
      type: 'tool/call',
      seq: 2,
      time: 1_007,
      data: { turn: 1, step: 1, callId: 'real-call', name: 'shell', arguments: '{"cmd":"whoami"}' },
    },
    {
      type: 'tool/result',
      seq: 3,
      time: 1_009,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'real-message',
          role: 'user',
          content: [{ type: 'text', text: 'alice@example.com C:\\Users\\alice' }],
          source: { kind: 'tool', callId: 'real-call' },
        },
        error: { name: 'ToolError', code: 'E_FAIL' },
        meta: { token: 'never-emit-me' },
      },
      sourceEventSeqs: [2],
      surfaceOp: 'append',
    },
  ] as unknown as SessionEvent[]
  const source: LoadedExport = {
    kind: 'zip',
    sourceSha256: 'a'.repeat(64),
    sourceBytes: 42,
    sessions: [],
    attachments: [{ sourcePath: 'media/private-id.png', size: 12, compressedSize: 9, reason: 'privacy-default' }],
  }
  return {
    source,
    requestedTarget: {
      kind: 'tool-call',
      callId: 'real-selector-call',
      sessionId: 'real-selector-session',
    },
    target: { kind: 'tool-call', sessionId: 'real-session', originalSeq: 2, eventType: 'tool/result' },
    sessions: [{
      sourcePath: 'session.jsonl',
      header: {
        type: 'session',
        version: 0,
        id: 'real-session',
        createdAt: 1_000,
        cwd: 'C:\\secret\\project',
        delegationDepth: 0,
      },
      events,
      originalSeqs: [3, 4, 5, 6],
      lineageOnly: false,
    }],
  }
}

describe('redactSlice', () => {
  it('removes sensitive values while preserving diagnostic structure and relationships', () => {
    const result = redactSlice(fixture())
    const serialized = JSON.stringify(result)

    expect(serialized).not.toContain('private system')
    expect(serialized).not.toContain('very-secret')
    expect(serialized).not.toContain('whoami')
    expect(serialized).not.toContain('alice@example.com')
    expect(serialized).not.toContain('never-emit-me')
    expect(serialized).not.toContain('real-session')
    expect(serialized).not.toContain('real-call')
    expect(serialized).not.toContain('real-message')
    expect(serialized).not.toContain('real-selector-call')
    expect(serialized).not.toContain('real-selector-session')
    expect(serialized).not.toContain('media/private-id.png')
    expect(serialized).not.toContain('session.jsonl')
    expect(serialized).not.toContain('a'.repeat(64))
    expect(serialized).toContain('deepseek-chat')
    expect(serialized).toContain('shell')
    expect(serialized).toContain('E_FAIL')

    const session = result.sessions[0]!
    expect(session.header.id).toBe('session-001')
    expect(session.header.createdAt).toBe(0)
    expect(session.events.map(event => event.time)).toEqual([5, 6, 7, 9])
    const assistantCall = (session.events[1] as unknown as {
      data: { message: { content: [{ id: string }] } }
    }).data.message.content[0].id
    const call = (session.events[2] as unknown as { data: { callId: string } }).data.callId
    const resultCall = (session.events[3] as unknown as { data: { message: { source: { callId: string } } } })
      .data.message.source.callId
    expect(call).toBe('call-001')
    expect(assistantCall).toBe(call)
    expect(resultCall).toBe(call)
    expect(result.requestedTarget).toEqual({ kind: 'tool-call' })
    expect(result.source).toEqual({
      kind: 'zip',
      bytes: 42,
      sessionCount: 0,
      omittedAttachments: [{ id: 'attachment-001', bytes: 12, reason: 'privacy-default' }],
    })
    expect(result.sessions[0]).not.toHaveProperty('sourcePath')
  })

  it('is byte-stable for the same input and does not use raw-value hashes', () => {
    const first = redactSlice(fixture())
    const second = redactSlice(fixture())
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(JSON.stringify(first)).not.toMatch(/[a-f\d]{32,64}/)
  })

  it('assigns attachment aliases in locale-independent code-point order', () => {
    type AttachmentEntry = readonly [sourcePath: string, size: number]
    const paths: readonly AttachmentEntry[] = [
      ['media/\u{1F600}.png', 4],
      ['media/\uE000.png', 3],
      ['media/\u00E4.png', 2],
      ['media/z.png', 1],
    ] as const
    const slice = fixture()
    const withAttachments = (entries: readonly AttachmentEntry[]): SliceResult => ({
      ...slice,
      source: {
        ...slice.source,
        attachments: entries.map(([sourcePath, size]) => ({
          sourcePath,
          size,
          compressedSize: size,
          reason: 'privacy-default' as const,
        })),
      },
    })

    const forward = redactSlice(withAttachments(paths)).source.omittedAttachments
    const reversed = redactSlice(withAttachments([...paths].reverse())).source.omittedAttachments

    expect(forward).toEqual([
      { id: 'attachment-001', bytes: 1, reason: 'privacy-default' },
      { id: 'attachment-002', bytes: 2, reason: 'privacy-default' },
      { id: 'attachment-003', bytes: 3, reason: 'privacy-default' },
      { id: 'attachment-004', bytes: 4, reason: 'privacy-default' },
    ])
    expect(reversed).toEqual(forward)
  })

  it('preserves official cross-event and cross-session identifier relationships', () => {
    const base = fixture()
    const root = base.sessions[0]!
    const linkedEvents = [
      {
        type: 'tool-workflow/agent-start', seq: 4, time: 1_010,
        data: { runId: 'raw-run', seq: 1, label: 'private label', childId: 'raw-child' },
      },
      {
        type: 'tool/code-dispatch', seq: 5, time: 1_011,
        data: {
          rootCallId: 'real-call', parentCallId: 'real-call', subCallId: 'raw-sub-call',
          name: 'read', arguments: {}, content: [], isError: false,
        },
      },
      { type: 'command/run', seq: 6, time: 1_012, data: { commandId: 'raw-command' } },
      {
        type: 'command/done', seq: 7, time: 1_013,
        data: { commandId: 'raw-command', sourceCommandId: 'raw-command', kind: 'success' },
      },
    ] as unknown as SessionEvent[]
    const result = redactSlice({
      ...base,
      sessions: [
        { ...root, events: [...root.events, ...linkedEvents], originalSeqs: [...root.originalSeqs, 7, 8, 9, 10] },
        {
          sourcePath: 'child.jsonl',
          header: {
            type: 'session', version: 0, id: 'raw-child', createdAt: 1_000,
            parentSession: 'real-session', origin: 'subagent', delegationDepth: 1,
          },
          events: [],
          originalSeqs: [],
          lineageOnly: true,
        },
      ],
    })

    const workflow = result.sessions[0]!.events[4] as unknown as {
      data: { runId: string; childId: string }
    }
    const dispatch = result.sessions[0]!.events[5] as unknown as {
      data: { rootCallId: string; parentCallId: string; subCallId: string }
    }
    const commandRun = result.sessions[0]!.events[6] as unknown as { data: { commandId: string } }
    const commandDone = result.sessions[0]!.events[7] as unknown as {
      data: { commandId: string; sourceCommandId: string }
    }
    expect(workflow.data.childId).toBe(result.sessions[1]!.header.id)
    expect(result.sessions[1]!.header.parentSession).toBe(result.sessions[0]!.header.id)
    expect(workflow.data.runId).toBe('run-001')
    expect(dispatch.data.rootCallId).toBe('call-001')
    expect(dispatch.data.parentCallId).toBe(dispatch.data.rootCallId)
    expect(dispatch.data.subCallId).toBe('call-002')
    expect(commandDone.data.commandId).toBe(commandRun.data.commandId)
    expect(commandDone.data.sourceCommandId).toBe(commandRun.data.commandId)
  })

  it('rejects excessive event depth before recursive redaction', () => {
    const base = fixture()
    const root = base.sessions[0]!
    const deep = { type: 'plugin/event', seq: 4, time: 1_010, data: {} as Record<string, unknown> }
    let nested = deep.data
    for (let depth = 0; depth < 200; depth += 1) {
      const child: Record<string, unknown> = {}
      nested['child'] = child
      nested = child
    }
    expect(() => redactSlice({
      ...base,
      sessions: [{ ...root, events: [...root.events, deep as unknown as SessionEvent], originalSeqs: [...root.originalSeqs, 7] }],
    })).toThrow(/depth budget/)
  })
})
