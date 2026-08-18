import { readFile, stat } from 'node:fs/promises'
import { isJsonValue, type SessionEvent } from '@deepseek-ai/dsh-session'
import { foldSurface } from '@deepseek-ai/dsh-session/surface'
import { unzipSync } from 'fflate'
import { REDACTION_NOTICE, renderReport } from './bundle.js'
import { ReproError } from './errors.js'
import { decodeUtf8Strict, parseJsonStrict } from './json.js'
import { auditRedactedSlice, ShareSafePolicyError } from './redaction-policy.js'
import {
  BUNDLE_FORMAT_VERSION,
  SUPPORTED_SESSION_FORMAT_VERSION,
  type BundleFileRecord,
  type BundleManifest,
  type BundleSessionRecord,
  type RedactedSession,
  type RedactedSlice,
  type SessionHeaderRecord,
  type VerifyResult,
} from './types.js'
import { isRecord, sha256Hex, utf8 } from './utils.js'

const MAX_BUNDLE_BYTES = 64 * 1024 * 1024
const MAX_ENTRY_BYTES = 32 * 1024 * 1024
const MAX_TOTAL_BYTES = 128 * 1024 * 1024
const MAX_ENTRIES = 256
const SAFE_BUNDLE_PATH = /^(?:manifest\.json|REPORT\.md|sessions\/session-\d+\.jsonl)$/
const SESSION_ALIAS = /^session-\d+$/
const SEMVER = /^\d+\.\d+\.\d+(?:-[\dA-Za-z.-]+)?(?:\+[\dA-Za-z.-]+)?$/
const PATH_PLACEHOLDER = /^<redacted-path-\d+ chars=\d+>$/
const TEXT_PLACEHOLDER = /^<redacted-text-\d+ chars=\d+>$/
const EVENT_KEYS = new Set(['type', 'seq', 'time', 'data', 'surfaceOp', 'sourceEventSeqs', 'ignorable'])
const HEADER_KEYS = new Set([
  'type', 'version', 'id', 'createdAt', 'cwd', 'parentSession', 'seedLength', 'origin', 'delegationDepth', 'agentPreset',
])
const SURFACE_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])

/** Verify checksums and all v1 structural invariants in a reproduction bundle. */
export async function verifyBundle(input: string | Uint8Array): Promise<VerifyResult> {
  const bytes = typeof input === 'string' ? await readBundleFile(input) : input
  if (bytes.byteLength > MAX_BUNDLE_BYTES) {
    throw new ReproError('INPUT_TOO_LARGE', `bundle exceeds ${MAX_BUNDLE_BYTES} bytes`)
  }
  const files = unzipBundle(bytes)
  const manifestBytes = ownFile(files, 'manifest.json')
  if (manifestBytes.byteLength > 2 * 1024 * 1024) {
    throw new ReproError('INVALID_BUNDLE', 'manifest.json exceeds 2 MiB')
  }
  const manifest = parseJsonStrict<unknown>(decodeUtf8Strict(manifestBytes, 'manifest.json'), 'manifest.json')
  assertManifest(manifest)
  verifyPayloadSet(files, manifest)
  verifyPayloadHashes(files, manifest.files)
  const sessions = verifySessions(files, manifest)
  const slice = reconstructedSlice(manifest, sessions)
  try {
    auditRedactedSlice(slice)
  } catch (error: unknown) {
    if (error instanceof ShareSafePolicyError) invalid(`share-safe-v1 policy violation: ${error.message}`)
    throw error
  }
  verifyCanonicalReport(ownFile(files, 'REPORT.md'), slice, manifest.selection.outputSeq)
  return {
    valid: true,
    authenticity: 'not-verified',
    checks: {
      payloadIntegrity: 'verified',
      harnessStructure: 'verified',
      redactionPolicy: 'verified',
      canonicalReport: 'verified',
    },
    manifest,
    verifiedFiles: manifest.files.length,
    verifiedSessions: manifest.sessions.length,
  }
}

async function readBundleFile(path: string): Promise<Uint8Array> {
  let metadata
  try {
    metadata = await stat(path)
  } catch (error) {
    throw new ReproError('INPUT_NOT_FOUND', `bundle not found: ${path}`, { path }, { cause: error })
  }
  if (!metadata.isFile()) throw new ReproError('INVALID_BUNDLE', `bundle is not a regular file: ${path}`)
  if (metadata.size > MAX_BUNDLE_BYTES) {
    throw new ReproError('INPUT_TOO_LARGE', `bundle exceeds ${MAX_BUNDLE_BYTES} bytes`, { bytes: metadata.size })
  }
  return readFile(path)
}

function unzipBundle(bytes: Uint8Array): Record<string, Uint8Array> {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4B) throw new ReproError('INVALID_BUNDLE', 'input is not a ZIP archive')
  const names = new Set<string>()
  let entries = 0
  let totalBytes = 0
  try {
    return unzipSync(bytes, {
      filter(info) {
        entries += 1
        if (entries > MAX_ENTRIES) throw new ReproError('UNSAFE_ARCHIVE', 'bundle has too many ZIP entries')
        assertSafeEntryName(info.name)
        if (names.has(info.name)) throw new ReproError('UNSAFE_ARCHIVE', `duplicate ZIP entry: ${info.name}`)
        names.add(info.name)
        if (info.originalSize > MAX_ENTRY_BYTES) {
          throw new ReproError('UNSAFE_ARCHIVE', `ZIP entry is too large: ${info.name}`)
        }
        totalBytes += info.originalSize
        if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) {
          throw new ReproError('UNSAFE_ARCHIVE', 'bundle uncompressed size exceeds the safety limit')
        }
        if (info.compression !== 0 && info.compression !== 8) {
          throw new ReproError('UNSAFE_ARCHIVE', `unsupported ZIP compression method ${info.compression}`)
        }
        return true
      },
    })
  } catch (error) {
    if (error instanceof ReproError) throw error
    throw new ReproError('INVALID_BUNDLE', 'unable to decode bundle ZIP', {}, { cause: error })
  }
}

function assertSafeEntryName(name: string): void {
  if (!SAFE_BUNDLE_PATH.test(name) || name.includes('\\') || name.includes('\0')) {
    throw new ReproError('UNSAFE_ARCHIVE', `unexpected or unsafe bundle path: ${JSON.stringify(name)}`)
  }
}

function assertManifest(value: unknown): asserts value is BundleManifest {
  if (!isRecord(value) || !hasExactKeys(value, [
    'format', 'version', 'tool', 'source', 'selection', 'redaction', 'sessions', 'omittedAttachments', 'files',
  ])) invalid('manifest has an unexpected top-level shape')
  if (value.format !== 'dsh-repro' || value.version !== BUNDLE_FORMAT_VERSION) {
    invalid(`unsupported bundle format/version: ${String(value.format)}/${String(value.version)}`)
  }
  if (!isRecord(value.tool) || !hasExactKeys(value.tool, ['name', 'version'])
    || value.tool.name !== 'dsh-repro-kit' || typeof value.tool.version !== 'string'
    || !SEMVER.test(value.tool.version)) invalid('invalid tool metadata')
  if (!isRecord(value.source) || !hasExactKeys(value.source, [
    'kind', 'bytes', 'sessionCount', 'omittedAttachmentCount',
  ]) || (value.source.kind !== 'zip' && value.source.kind !== 'jsonl')
    || !isNonNegativeInteger(value.source.bytes)
    || !isNonNegativeInteger(value.source.sessionCount)
    || !isNonNegativeInteger(value.source.omittedAttachmentCount)) invalid('invalid source summary')
  if (!isRecord(value.selection) || !hasExactKeys(value.selection, [
    'kind', 'sessionId', 'originalSeq', 'outputSeq', 'eventType', 'policy',
  ]) || !['last-error', 'seq', 'tool-call'].includes(String(value.selection.kind))
    || typeof value.selection.sessionId !== 'string' || !SESSION_ALIAS.test(value.selection.sessionId)
    || !isNonNegativeInteger(value.selection.originalSeq)
    || !isNonNegativeInteger(value.selection.outputSeq)
    || typeof value.selection.eventType !== 'string' || value.selection.eventType.length === 0
    || value.selection.policy !== 'enclosing-turn+causal-sources+tool-pairs+lineage') invalid('invalid selection metadata')
  if (!isRecord(value.redaction) || !hasExactKeys(value.redaction, ['profile', 'counts', 'notice'])
    || value.redaction.profile !== 'share-safe-v1'
    || value.redaction.notice !== REDACTION_NOTICE
    || !isCounts(value.redaction.counts)) invalid('invalid redaction metadata')
  if (!Array.isArray(value.sessions) || !Array.isArray(value.omittedAttachments) || !Array.isArray(value.files)) {
    invalid('manifest collections must be arrays')
  }
  const sessions = value.sessions as unknown[]
  const attachments = value.omittedAttachments as unknown[]
  const files = value.files as unknown[]
  sessions.forEach(assertSessionRecord)
  attachments.forEach(assertAttachmentRecord)
  files.forEach(assertFileRecord)
  if (sessions.length === 0) invalid('bundle must contain at least one session')
  if (value.source.sessionCount < sessions.length) invalid('bundle cannot contain more sessions than its source')
  if (value.source.omittedAttachmentCount !== attachments.length) invalid('attachment count does not match source summary')
  assertUnique(sessions.map(item => (item as BundleSessionRecord).id), 'session id')
  assertUnique(sessions.map(item => (item as BundleSessionRecord).file), 'session file')
  assertUnique(files.map(item => (item as BundleFileRecord).path), 'payload path')
}

function assertSessionRecord(value: unknown): void {
  if (!isRecord(value)) invalid('session manifest entry must be an object')
  const required = ['id', 'file', 'eventCount', 'originalSeqs', 'lineageOnly']
  const allowed = new Set([...required, 'parentSession'])
  if (!required.every(key => Object.hasOwn(value, key)) || Object.keys(value).some(key => !allowed.has(key))
    || typeof value.id !== 'string' || !SESSION_ALIAS.test(value.id)
    || value.file !== `sessions/${value.id}.jsonl`
    || !isNonNegativeInteger(value.eventCount)
    || !Array.isArray(value.originalSeqs)
    || value.originalSeqs.some(seq => !isNonNegativeInteger(seq))
    || value.originalSeqs.length !== value.eventCount
    || !strictlyIncreasing(value.originalSeqs as number[])
    || typeof value.lineageOnly !== 'boolean'
    || value.lineageOnly && value.eventCount !== 0
    || value.parentSession !== undefined
      && (typeof value.parentSession !== 'string' || !SESSION_ALIAS.test(value.parentSession))) {
    invalid('invalid session manifest entry')
  }
}

function assertAttachmentRecord(value: unknown): void {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'bytes', 'reason'])
    || typeof value.id !== 'string' || !/^attachment-\d+$/.test(value.id)
    || !isNonNegativeInteger(value.bytes) || value.reason !== 'privacy-default') invalid('invalid omitted attachment entry')
}

function assertFileRecord(value: unknown): void {
  if (!isRecord(value) || !hasExactKeys(value, ['path', 'bytes', 'sha256'])
    || typeof value.path !== 'string' || value.path === 'manifest.json' || !SAFE_BUNDLE_PATH.test(value.path)
    || !isNonNegativeInteger(value.bytes)
    || typeof value.sha256 !== 'string' || !/^[a-f\d]{64}$/.test(value.sha256)) invalid('invalid payload file entry')
}

function isCounts(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['identifiers', 'textValues', 'secrets', 'paths'])
    && Object.values(value).every(isNonNegativeInteger)
}

function verifyPayloadSet(files: Record<string, Uint8Array>, manifest: BundleManifest): void {
  const expected = new Set(['manifest.json', ...manifest.files.map(file => file.path)])
  const actual = Object.keys(files)
  if (actual.length !== expected.size || actual.some(path => !expected.has(path))) {
    throw new ReproError('INVALID_BUNDLE', 'ZIP entries do not exactly match the manifest payload set')
  }
  if (!manifest.files.some(file => file.path === 'REPORT.md')) invalid('manifest does not cover REPORT.md')
  const expectedPayloads = new Set(['REPORT.md', ...manifest.sessions.map(session => session.file)])
  const declaredPayloads = new Set(manifest.files.map(file => file.path))
  if (expectedPayloads.size !== declaredPayloads.size
    || [...expectedPayloads].some(path => !declaredPayloads.has(path))) {
    invalid('manifest payloads must be exactly REPORT.md and the declared session files')
  }
}

function verifyPayloadHashes(files: Record<string, Uint8Array>, records: readonly BundleFileRecord[]): void {
  for (const record of records) {
    const bytes = ownFile(files, record.path)
    if (bytes.byteLength !== record.bytes || sha256Hex(bytes) !== record.sha256) {
      throw new ReproError('INTEGRITY_MISMATCH', `payload integrity mismatch: ${record.path}`, { path: record.path })
    }
  }
}

function verifySessions(files: Record<string, Uint8Array>, manifest: BundleManifest): RedactedSession[] {
  const parsed = new Map<string, Record<string, unknown>[]>()
  const sessions: RedactedSession[] = []
  for (const record of manifest.sessions) {
    const text = decodeUtf8Strict(ownFile(files, record.file), record.file)
    if (!text.endsWith('\n')) invalid(`${record.file} must end with a newline`)
    const lines = text.slice(0, -1).split('\n')
    if (lines.some(line => line.length === 0)) invalid(`${record.file} contains an empty JSONL record`)
    const values = lines.map((line, index) => parseJsonStrict<unknown>(line, `${record.file}:${index + 1}`))
    const header = values[0]
    assertSessionHeader(header, record)
    if (header.parentSession !== record.parentSession) invalid(`${record.file} parentSession disagrees with manifest`)
    const events = values.slice(1)
    if (events.length !== record.eventCount) invalid(`${record.file} event count disagrees with manifest`)
    events.forEach((event, seq) => assertEvent(event, seq, record.file))
    try {
      foldSurface(events as SessionEvent[])
    } catch (error: unknown) {
      throw new ReproError(
        'INVALID_BUNDLE',
        `${record.file} violates DeepSeek Harness surface invariants`,
        { file: record.file },
        { cause: error },
      )
    }
    parsed.set(record.id, events as Record<string, unknown>[])
    sessions.push({
      header: header as unknown as SessionHeaderRecord,
      events: events as SessionEvent[],
      originalSeqs: record.originalSeqs,
      lineageOnly: record.lineageOnly,
    })
  }
  const targetEvents = parsed.get(manifest.selection.sessionId)
  const target = targetEvents?.[manifest.selection.outputSeq]
  if (target === undefined || target.type !== manifest.selection.eventType) {
    invalid('selection target does not resolve to the declared event')
  }
  const targetSession = manifest.sessions.find(session => session.id === manifest.selection.sessionId)
  if (targetSession?.originalSeqs[manifest.selection.outputSeq] !== manifest.selection.originalSeq) {
    invalid('selection originalSeq does not match the target session mapping')
  }
  return sessions
}

function reconstructedSlice(manifest: BundleManifest, sessions: readonly RedactedSession[]): RedactedSlice {
  return {
    source: {
      kind: manifest.source.kind,
      bytes: manifest.source.bytes,
      sessionCount: manifest.source.sessionCount,
      omittedAttachments: manifest.omittedAttachments,
    },
    requestedTarget: { kind: manifest.selection.kind },
    target: {
      kind: manifest.selection.kind,
      sessionId: manifest.selection.sessionId,
      originalSeq: manifest.selection.originalSeq,
      eventType: manifest.selection.eventType,
    },
    sessions,
    counts: manifest.redaction.counts,
  }
}

function verifyCanonicalReport(bytes: Uint8Array, slice: RedactedSlice, outputSeq: number): void {
  const expected = utf8(renderReport(slice, outputSeq))
  if (bytes.byteLength !== expected.byteLength
    || bytes.some((value, index) => value !== expected[index])) {
    invalid('REPORT.md is not the canonical report for the verified payload')
  }
}

function assertEvent(value: unknown, expectedSeq: number, file: string): void {
  if (!isRecord(value) || Object.keys(value).some(key => !EVENT_KEYS.has(key))
    || typeof value.type !== 'string' || value.type.length === 0 || value.type === 'session'
    || value.seq !== expectedSeq || !Number.isSafeInteger(value.time)
    || !isRecord(value.data)
    || !isJsonValue(value)
    || value.ignorable !== undefined && value.ignorable !== true) {
    invalid(`${file} has an invalid event at seq ${expectedSeq}`)
  }
  if (value.sourceEventSeqs !== undefined) {
    if (!Array.isArray(value.sourceEventSeqs)
      || value.sourceEventSeqs.some(source => !isNonNegativeInteger(source) || source >= expectedSeq)
      || new Set(value.sourceEventSeqs).size !== value.sourceEventSeqs.length
      || value.sourceEventSeqs.length === 0 && value.type !== 'assistant/message'
      || !SURFACE_EVENT_TYPES.has(value.type)) {
      invalid(`${file} has invalid sourceEventSeqs at seq ${expectedSeq}`)
    }
  }
  if (value.surfaceOp !== undefined) {
    if (!SURFACE_EVENT_TYPES.has(value.type)) invalid(`${file} has surfaceOp on a non-surface event at seq ${expectedSeq}`)
    if (value.surfaceOp !== 'append') {
      if (!isRecord(value.surfaceOp) || !hasExactKeys(value.surfaceOp, ['op', 'start', 'end'])
        || value.surfaceOp.op !== 'replace'
        || !isNonNegativeInteger(value.surfaceOp.start) || value.surfaceOp.start >= expectedSeq
        || !isNonNegativeInteger(value.surfaceOp.end) || value.surfaceOp.end >= expectedSeq
        || value.surfaceOp.start > value.surfaceOp.end
        || !Array.isArray(value.sourceEventSeqs)
        || !value.sourceEventSeqs.includes(value.surfaceOp.start)
        || !value.sourceEventSeqs.includes(value.surfaceOp.end)) {
        invalid(`${file} has invalid replacement surfaceOp at seq ${expectedSeq}`)
      }
    }
  }
}

function assertSessionHeader(value: unknown, record: BundleSessionRecord): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some(key => !HEADER_KEYS.has(key))
    || value.type !== 'session' || value.version !== SUPPORTED_SESSION_FORMAT_VERSION
    || value.id !== record.id || value.createdAt !== 0
    || !isNonNegativeInteger(value.delegationDepth)
    || value.cwd !== undefined && (typeof value.cwd !== 'string' || !PATH_PLACEHOLDER.test(value.cwd))
    || value.parentSession !== undefined && (typeof value.parentSession !== 'string' || !SESSION_ALIAS.test(value.parentSession))
    || value.seedLength !== undefined && (!isNonNegativeInteger(value.seedLength) || value.seedLength > record.eventCount)
    || value.origin !== undefined && value.origin !== 'subagent'
    || value.agentPreset !== undefined && (typeof value.agentPreset !== 'string' || !TEXT_PLACEHOLDER.test(value.agentPreset))) {
    invalid(`${record.file} has an invalid redacted session header`)
  }
}

function ownFile(files: Record<string, Uint8Array>, path: string): Uint8Array {
  if (!Object.hasOwn(files, path)) throw new ReproError('INVALID_BUNDLE', `missing bundle entry: ${path}`)
  return files[path] as Uint8Array
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && !Object.is(value, -0)
}

function strictlyIncreasing(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || value > (values[index - 1] as number))
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`duplicate ${label} in manifest`)
}

function invalid(message: string): never {
  throw new ReproError('INVALID_BUNDLE', message)
}
