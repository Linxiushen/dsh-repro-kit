import { isFailureEvent } from './failure.js'
import type { InspectResult, LoadedExport } from './types.js'

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
      errorCount: session.events.filter(isFailureEvent).length,
    })),
    omittedAttachments: source.attachments.length,
  }
}
