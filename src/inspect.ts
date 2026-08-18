import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { InspectResult, LoadedExport } from './types.js'
import { isRecord } from './utils.js'

/** Summarize a loaded export without exposing message or tool payloads. */
export function inspectExport(source: LoadedExport): InspectResult {
  return {
    kind: source.kind,
    sourceSha256: source.sourceSha256,
    sourceBytes: source.sourceBytes,
    sessions: source.sessions.map(session => ({
      id: session.header.id,
      sourcePath: session.sourcePath,
      ...(session.header.parentSession === undefined ? {} : { parentSession: session.header.parentSession }),
      delegationDepth: session.header.delegationDepth,
      eventCount: session.events.length,
      ...(session.events.length === 0 ? {} : {
        firstSeq: session.events[0]!.seq,
        lastSeq: session.events.at(-1)!.seq,
      }),
      errorCount: session.events.filter(eventLooksLikeError).length,
    })),
    omittedAttachments: source.attachments.length,
  }
}

function eventLooksLikeError(event: SessionEvent): boolean {
  const raw = event as unknown as Record<string, unknown>
  const data = isRecord(raw.data) ? raw.data : undefined
  if (event.type.endsWith('/error')) return true
  if (event.type === 'turn/end') return isRecord(data?.reason) && data.reason.kind === 'error'
  if (event.type === 'tool/result') {
    if (data?.error !== undefined) return true
    const message = data?.message
    return isRecord(message) && Array.isArray(message.content) && message.content.some(block => (
      isRecord(block) && block.type === 'tool-result' && block.isError === true
    ))
  }
  if (event.type !== 'assistant/chunk') return false
  const chunk = data?.chunk
  return isRecord(chunk) && (chunk.type === 'error' || isRecord(chunk.reason) && chunk.reason.kind === 'error')
}
