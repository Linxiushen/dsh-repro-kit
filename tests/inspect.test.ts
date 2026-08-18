import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { inspectExport } from '../src/inspect.js'
import type { LoadedExport } from '../src/types.js'

describe('inspectExport', () => {
  it('summarizes errors without returning event content', () => {
    const events = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'error', error: { message: 'secret' } } } },
    ] as unknown as SessionEvent[]
    const source: LoadedExport = {
      kind: 'jsonl',
      sourceSha256: 'a'.repeat(64),
      sourceBytes: 10,
      sessions: [{
        sourcePath: 'session.jsonl',
        header: { type: 'session', version: 0, id: 'root', createdAt: 1, delegationDepth: 0 },
        events,
        sourceSha256: 'b'.repeat(64),
        sourceBytes: 10,
      }],
      attachments: [],
    }
    expect(inspectExport(source)).toMatchObject({
      sessions: [{ id: 'root', eventCount: 2, firstSeq: 0, lastSeq: 1, errorCount: 1 }],
    })
    expect(JSON.stringify(inspectExport(source))).not.toContain('secret')
  })

  it('recognizes hook, tool surface, and assistant stream failures', () => {
    const events = [
      { type: 'hook/error', seq: 0, time: 1, data: {} },
      {
        type: 'tool/result',
        seq: 1,
        time: 2,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'm',
            role: 'user',
            content: [{ type: 'tool-result', toolCallId: 'c', content: [], isError: true }],
            source: { kind: 'tool', callId: 'c' },
          },
        },
        surfaceOp: 'append',
      },
      {
        type: 'assistant/chunk',
        seq: 2,
        time: 3,
        data: { turn: 1, step: 1, chunk: { type: 'error' } },
      },
    ] as unknown as SessionEvent[]
    const source: LoadedExport = {
      kind: 'zip',
      sourceSha256: 'a',
      sourceBytes: 2,
      sessions: [{
        sourcePath: 'session.jsonl',
        header: {
          type: 'session', version: 0, id: 'child', createdAt: 0,
          parentSession: 'root', origin: 'subagent', delegationDepth: 1,
        },
        events,
        sourceSha256: 'b',
        sourceBytes: 1,
      }],
      attachments: [{ sourcePath: 'media/a.png', size: 1, compressedSize: 1, reason: 'privacy-default' }],
    }
    expect(inspectExport(source)).toMatchObject({
      omittedAttachments: 1,
      sessions: [{ parentSession: 'root', errorCount: 3 }],
    })
  })
})
