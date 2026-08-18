import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { zipSync, type Zippable } from 'fflate'
import { ReproError } from './errors.js'
import {
  BUNDLE_FORMAT_VERSION,
  type BundleArtifact,
  type BundleFileRecord,
  type BundleManifest,
  type BundleSessionRecord,
  type RedactedSession,
  type RedactedSlice,
} from './types.js'
import { canonicalStringify, sha256Hex, utf8 } from './utils.js'
import { TOOL_NAME, TOOL_VERSION } from './version.js'

const FIXED_ZIP_TIME = new Date('1980-01-01T00:00:00.000Z')
const REGULAR_FILE_MODE = (0o100644 * 0x1_0000) >>> 0
const REDACTION_NOTICE = 'Automated redaction reduces disclosure risk but cannot guarantee removal of all sensitive information. Review before sharing.'

/** Build a byte-for-byte deterministic reproduction ZIP from a redacted slice. */
export function buildBundle(slice: RedactedSlice): BundleArtifact {
  const sessionPayloads = new Map<string, Uint8Array>()
  const sessionRecords: BundleSessionRecord[] = []
  for (const session of slice.sessions) {
    const file = `sessions/${session.header.id}.jsonl`
    const bytes = serializeSession(session)
    sessionPayloads.set(file, bytes)
    sessionRecords.push({
      id: session.header.id,
      ...(session.header.parentSession === undefined ? {} : { parentSession: session.header.parentSession }),
      file,
      eventCount: session.events.length,
      originalSeqs: session.originalSeqs,
      lineageOnly: session.lineageOnly,
    })
  }

  const targetSession = slice.sessions.find(session => session.header.id === slice.target.sessionId)
  const targetIndex = targetSession?.originalSeqs.indexOf(slice.target.originalSeq) ?? -1
  const outputSeq = targetIndex < 0 ? undefined : targetSession?.events[targetIndex]?.seq
  if (outputSeq === undefined) {
    throw new ReproError('INVALID_SESSION', 'the resolved target is absent from the redacted slice')
  }

  const report = renderReport(slice, outputSeq)
  const reportBytes = utf8(report)
  const payloads = new Map<string, Uint8Array>([['REPORT.md', reportBytes], ...sessionPayloads])
  const fileRecords = [...payloads]
    .map(([path, bytes]): BundleFileRecord => ({ path, bytes: bytes.byteLength, sha256: sha256Hex(bytes) }))
    .sort((a, b) => a.path.localeCompare(b.path))

  const omittedAttachments = [...slice.source.omittedAttachments]
    .sort((a, b) => a.id.localeCompare(b.id))

  const manifest: BundleManifest = {
    format: 'dsh-repro',
    version: BUNDLE_FORMAT_VERSION,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    source: {
      kind: slice.source.kind,
      bytes: slice.source.bytes,
      sessionCount: slice.source.sessionCount,
      omittedAttachmentCount: slice.source.omittedAttachments.length,
    },
    selection: {
      kind: slice.requestedTarget.kind,
      sessionId: slice.target.sessionId,
      originalSeq: slice.target.originalSeq,
      outputSeq,
      eventType: slice.target.eventType,
      policy: 'enclosing-turn+causal-sources+tool-pairs+lineage',
    },
    redaction: {
      profile: 'share-safe-v1',
      counts: slice.counts,
      notice: REDACTION_NOTICE,
    },
    sessions: sessionRecords,
    omittedAttachments,
    files: fileRecords,
  }

  const manifestBytes = utf8(`${canonicalStringify(manifest, 2)}\n`)
  const archiveFiles: Zippable = {}
  archiveFiles['manifest.json'] = zipFile(manifestBytes)
  archiveFiles['REPORT.md'] = zipFile(reportBytes)
  for (const [path, bytes] of [...sessionPayloads].sort(([a], [b]) => a.localeCompare(b))) {
    archiveFiles[path] = zipFile(bytes)
  }
  const bytes = zipSync(archiveFiles, { level: 9, mtime: FIXED_ZIP_TIME, attrs: REGULAR_FILE_MODE })
  return { bytes, manifest, report }
}

function zipFile(bytes: Uint8Array): [Uint8Array, { level: 9; mtime: Date; attrs: number }] {
  return [bytes, { level: 9, mtime: FIXED_ZIP_TIME, attrs: REGULAR_FILE_MODE }]
}

function serializeSession(session: RedactedSession): Uint8Array {
  const lines = [session.header, ...session.events].map(value => canonicalStringify(value))
  return utf8(`${lines.join('\n')}\n`)
}

function renderReport(slice: RedactedSlice, outputSeq: number): string {
  const lines = [
    '# DeepSeek Harness reproduction bundle',
    '',
    `> ${REDACTION_NOTICE}`,
    '',
    '## Target',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Selector | ${inlineCode(slice.requestedTarget.kind)} |`,
    `| Session | ${inlineCode(slice.target.sessionId)} |`,
    `| Event | ${inlineCode(slice.target.eventType)} |`,
    `| Original seq | ${slice.target.originalSeq} |`,
    `| Bundle seq | ${outputSeq} |`,
    '',
    '## Sessions',
    '',
    '| Session | Parent | Events | Role |',
    '| --- | --- | ---: | --- |',
    ...slice.sessions.map(session => (
      `| ${inlineCode(session.header.id)} | ${session.header.parentSession === undefined ? '-' : inlineCode(session.header.parentSession)} | ${session.events.length} | ${session.lineageOnly ? 'lineage' : 'evidence'} |`
    )),
    '',
    '## Timeline',
    '',
    '| Session | Seq | Original seq | Relative time | Event |',
    '| --- | ---: | ---: | ---: | --- |',
    ...timelineRows(slice),
    '',
    '## Redaction',
    '',
    `Identifiers replaced: ${slice.counts.identifiers}`,
    '',
    `Text values replaced: ${slice.counts.textValues}`,
    '',
    `Secrets replaced: ${slice.counts.secrets}`,
    '',
    `Paths replaced: ${slice.counts.paths}`,
    '',
    `Attachments omitted: ${slice.source.omittedAttachments.length}`,
    '',
    '## Verification',
    '',
    '```console',
    'dsh-repro verify <bundle.repro.zip>',
    '```',
    '',
  ]
  return lines.join('\n')
}

function timelineRows(slice: RedactedSlice): string[] {
  const rows: string[] = []
  for (const session of slice.sessions) {
    session.events.forEach((event: SessionEvent, index) => {
      rows.push(
        `| ${inlineCode(session.header.id)} | ${event.seq} | ${session.originalSeqs[index] ?? '-'} | +${event.time} ms | ${inlineCode(event.type)} |`,
      )
    })
  }
  return rows.length === 0 ? ['| - | - | - | - | lineage only |'] : rows
}

function inlineCode(value: string): string {
  return `\`${value.replaceAll('`', '\\`').replace(/[\r\n|]/g, ' ')}\``
}
