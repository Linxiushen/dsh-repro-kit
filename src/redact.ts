import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  RedactedAttachment,
  RedactedSession,
  RedactedSlice,
  RedactionCounts,
  SessionHeaderRecord,
  SliceResult,
  SlicedSession,
} from './types.js'
import { canonicalStringify, isRecord } from './utils.js'

type AliasKind = 'session' | 'call' | 'run' | 'message' | 'attachment'
type TextKind = 'text' | 'opaque' | 'path' | 'secret' | 'email' | 'url'

const PRESERVED_STRING_KEYS = new Set([
  'type',
  'kind',
  'role',
  'source',
  'form',
  'status',
  'reason',
  'provider',
  'model',
  'name',
  'code',
  'finishReason',
  'mimeType',
  'surfaceOp',
  'op',
])

const CONTENT_KEYS = new Set([
  'system',
  'text',
  'reasoning',
  'arguments',
  'argumentsDelta',
  'prompt',
  'output',
  'result',
  'message',
  'summary',
  'description',
  'instructions',
  'objective',
])

const OPAQUE_KEYS = new Set(['meta', 'replayState', 'raw', 'body', 'headers'])
const PATH_KEYS = new Set(['cwd', 'path', 'file', 'filename', 'directory', 'root', 'workingDirectory'])
const SENSITIVE_KEY = /(?:^|_)(?:api[-_]?key|secret|token|password|passwd|authorization|cookie|credential)(?:$|_)/i
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const TOKEN = /\b(?:AKIA[0-9A-Z]{16}|(?:sk|gh[opusr]|github_pat|xox[baprs])[-_A-Za-z0-9]{8,})\b/g
const BEARER = /\bBearer\s+[^\s,;]+/gi
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/

/** Apply the default share-safe redaction profile to a causal slice. */
export function redactSlice(slice: SliceResult): RedactedSlice {
  const redactor = new StableRedactor()

  // Seed aliases in bundle order so identifiers never depend on object traversal.
  for (const session of slice.sessions) redactor.alias('session', session.header.id)
  for (const session of slice.sessions) {
    if (session.header.parentSession !== undefined) redactor.alias('session', session.header.parentSession)
  }
  const omittedAttachments: RedactedAttachment[] = []
  for (const attachment of [...slice.source.attachments].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath))) {
    const rawId = attachmentIdFromPath(attachment.sourcePath)
    omittedAttachments.push({
      id: redactor.alias('attachment', rawId),
      bytes: attachment.size,
      reason: attachment.reason,
    })
  }

  const sessions = slice.sessions.map(session => redactSession(session, redactor))
  return {
    source: {
      kind: slice.source.kind,
      bytes: slice.source.sourceBytes,
      sessionCount: slice.source.sessions.length,
      omittedAttachments,
    },
    requestedTarget: { kind: slice.requestedTarget.kind },
    target: {
      ...slice.target,
      sessionId: redactor.alias('session', slice.target.sessionId),
    },
    sessions,
    counts: redactor.counts(),
  }
}

function redactSession(session: SlicedSession, redactor: StableRedactor): RedactedSession {
  const baseTime = session.header.createdAt
  const header: SessionHeaderRecord = {
    type: 'session',
    version: session.header.version,
    id: redactor.alias('session', session.header.id),
    createdAt: 0,
    ...(session.header.cwd === undefined ? {} : { cwd: redactor.text('path', session.header.cwd) }),
    ...(session.header.parentSession === undefined
      ? {}
      : { parentSession: redactor.alias('session', session.header.parentSession) }),
    ...(session.header.seedLength === undefined ? {} : { seedLength: session.header.seedLength }),
    ...(session.header.origin === undefined ? {} : { origin: session.header.origin }),
    delegationDepth: session.header.delegationDepth,
    ...(session.header.agentPreset === undefined
      ? {}
      : { agentPreset: redactor.text('text', session.header.agentPreset) }),
  }
  const events = session.events.map(event => redactEvent(event, baseTime, redactor))
  return {
    header,
    events,
    originalSeqs: session.originalSeqs,
    lineageOnly: session.lineageOnly,
  }
}

function redactEvent(event: SessionEvent, baseTime: number, redactor: StableRedactor): SessionEvent {
  const eventRecord = event as unknown as Record<string, unknown>
  const transformed = redactor.value(eventRecord, [], undefined)
  if (!isRecord(transformed)) throw new TypeError('redacted event must remain an object')
  transformed.time = Number.isSafeInteger(event.time - baseTime) ? event.time - baseTime : 0
  return transformed as unknown as SessionEvent
}

class StableRedactor {
  private readonly aliases = new Map<AliasKind, Map<string, string>>()
  private readonly texts = new Map<TextKind, Map<string, string>>()
  private identifierOccurrences = 0
  private textOccurrences = 0
  private secretOccurrences = 0
  private pathOccurrences = 0

  alias(kind: AliasKind, raw: string): string {
    this.identifierOccurrences += 1
    let values = this.aliases.get(kind)
    if (values === undefined) {
      values = new Map()
      this.aliases.set(kind, values)
    }
    const present = values.get(raw)
    if (present !== undefined) return present
    const value = `${kind}-${String(values.size + 1).padStart(3, '0')}`
    values.set(raw, value)
    return value
  }

  text(kind: TextKind, raw: string): string {
    if (kind === 'path') this.pathOccurrences += 1
    else if (kind === 'secret') this.secretOccurrences += 1
    else this.textOccurrences += 1
    let values = this.texts.get(kind)
    if (values === undefined) {
      values = new Map()
      this.texts.set(kind, values)
    }
    const present = values.get(raw)
    if (present !== undefined) return present
    const label = kind === 'opaque' ? 'data' : kind
    const value = `<redacted-${label}-${String(values.size + 1).padStart(3, '0')} chars=${[...raw].length}>`
    values.set(raw, value)
    return value
  }

  counts(): RedactionCounts {
    return {
      identifiers: this.identifierOccurrences,
      textValues: this.textOccurrences,
      secrets: this.secretOccurrences,
      paths: this.pathOccurrences,
    }
  }

  value(value: unknown, path: readonly string[], parent: Record<string, unknown> | undefined): unknown {
    if (typeof value === 'string') return this.string(value, path, parent)
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
    if (Array.isArray(value)) return value.map((item, index) => this.value(item, [...path, String(index)], undefined))
    if (!isRecord(value)) return this.text('opaque', String(value))

    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      const child = value[key]
      if (child === undefined) continue
      if (OPAQUE_KEYS.has(key)) {
        result[key] = this.text('opaque', canonicalStringify(child))
      } else if (SENSITIVE_KEY.test(key)) {
        result[key] = this.text('secret', canonicalStringify(child))
      } else {
        result[key] = this.value(child, [...path, key], value)
      }
    }
    return result
  }

  private string(raw: string, path: readonly string[], parent: Record<string, unknown> | undefined): string {
    const key = path.at(-1) ?? ''
    const aliasKind = identifierKind(key, path, parent)
    if (aliasKind !== undefined) return this.alias(aliasKind, raw)
    if (PATH_KEYS.has(key) || ABSOLUTE_PATH.test(raw)) return this.text('path', raw)
    if (SENSITIVE_KEY.test(key)) return this.text('secret', raw)
    if (CONTENT_KEYS.has(key) || key === 'content' || key === 'data' && path.includes('content')) {
      return this.text('text', raw)
    }
    if (!PRESERVED_STRING_KEYS.has(key)) return this.text('text', raw)
    return this.scrubMetadata(raw)
  }

  private scrubMetadata(raw: string): string {
    let result = raw.replace(BEARER, value => this.text('secret', value))
    result = result.replace(TOKEN, value => this.text('secret', value))
    result = result.replace(EMAIL, value => this.text('email', value.toLowerCase()))
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(result)) return this.text('url', result)
    return result
  }
}

function identifierKind(
  key: string,
  path: readonly string[],
  parent: Record<string, unknown> | undefined,
): AliasKind | undefined {
  if (key === 'sessionId' || key === 'parentSession' || key === 'parentSessionId') return 'session'
  if (key === 'callId' || key === 'toolCallId') return 'call'
  if (key === 'runId') return 'run'
  if (key === 'messageId') return 'message'
  if (key === 'attachmentId') return 'attachment'
  if (key !== 'id') return undefined
  if (parent?.type === 'tool-call' || parent?.type === 'tool-call-delta') return 'call'
  if (parent?.type === 'image' || path.includes('attachment')) return 'attachment'
  if (path.at(-2) === 'message') return 'message'
  return undefined
}

function attachmentIdFromPath(path: string): string {
  const filename = path.split('/').at(-1) ?? path
  const extension = filename.lastIndexOf('.')
  return extension > 0 ? filename.slice(0, extension) : filename
}
