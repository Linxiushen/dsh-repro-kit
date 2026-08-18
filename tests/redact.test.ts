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
})
