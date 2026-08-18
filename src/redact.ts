import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assertRedactionBudget,
  auditRedactedSlice,
  BEARER,
  EMAIL,
  isPreservedObjectKey,
  isSchemaMapPath,
  OPAQUE_KEYS,
  REDACTION_PLACEHOLDER,
  SENSITIVE_KEY,
  stringDisposition,
  TOKEN,
  type AliasKind,
  type TextKind,
} from './redaction-policy.js'
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

/** Apply the default share-safe redaction profile to a causal slice. */
export function redactSlice(slice: SliceResult): RedactedSlice {
  const redactor = new StableRedactor()

  // Seed aliases in bundle order so identifiers never depend on object traversal.
  for (const session of slice.sessions) redactor.seedAlias('session', session.header.id)
  for (const session of slice.sessions) {
    if (session.header.parentSession !== undefined) redactor.seedAlias('session', session.header.parentSession)
  }
  const omittedAttachments: RedactedAttachment[] = []
  for (const attachment of [...slice.source.attachments].sort((a, b) => compareCodePoints(a.sourcePath, b.sourcePath))) {
    const rawId = attachmentIdFromPath(attachment.sourcePath)
    omittedAttachments.push({
      id: redactor.alias('attachment', rawId),
      bytes: attachment.size,
      reason: attachment.reason,
    })
  }

  const sessions = slice.sessions.map(session => redactSession(session, redactor))
  const targetEventType = redactor.value(slice.target.eventType, ['eventType'], undefined)
  if (typeof targetEventType !== 'string') throw new TypeError('redacted target event type must remain a string')
  const result: RedactedSlice = {
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
      eventType: targetEventType,
    },
    sessions,
    counts: redactor.counts(),
  }
  auditRedactedSlice(result)
  return result
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
  assertRedactionBudget(event)
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

  seedAlias(kind: AliasKind, raw: string): void {
    this.aliasValue(kind, raw)
  }

  alias(kind: AliasKind, raw: string): string {
    this.identifierOccurrences += 1
    return this.aliasValue(kind, raw)
  }

  private aliasValue(kind: AliasKind, raw: string): string {
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

    const result = Object.create(null) as Record<string, unknown>
    for (const key of Object.keys(value)) {
      const child = value[key]
      if (child === undefined) continue
      const schemaMap = isSchemaMapPath(path)
      const keyKind = SENSITIVE_KEY.test(key) && !schemaMap ? 'secret-key' : 'key'
      const outputKey = isPreservedObjectKey(key, path) ? key : this.text(keyKind, key)
      if (OPAQUE_KEYS.has(key)) {
        result[outputKey] = this.text('opaque', canonicalStringify(child))
      } else if (SENSITIVE_KEY.test(key) && !schemaMap) {
        result[outputKey] = this.text('secret', canonicalStringify(child))
      } else {
        result[outputKey] = this.value(child, [...path, outputKey], value)
      }
    }
    return result
  }

  private string(raw: string, path: readonly string[], parent: Record<string, unknown> | undefined): string {
    const disposition = stringDisposition(raw, path, parent)
    if (disposition.kind === 'alias') return this.alias(disposition.aliasKind, raw)
    if (disposition.kind === 'text') return this.text(disposition.textKind, raw)
    return this.scrubMetadata(raw)
  }

  private scrubMetadata(raw: string): string {
    REDACTION_PLACEHOLDER.lastIndex = 0
    let result = raw.replace(REDACTION_PLACEHOLDER, value => this.text('text', value))
    result = result.replace(BEARER, value => this.text('secret', value))
    result = result.replace(TOKEN, value => this.text('secret', value))
    result = result.replace(EMAIL, value => this.text('email', value.toLowerCase()))
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(result)) return this.text('url', result)
    return result
  }
}

function attachmentIdFromPath(path: string): string {
  const filename = path.split('/').at(-1) ?? path
  const extension = filename.lastIndexOf('.')
  return extension > 0 ? filename.slice(0, extension) : filename
}

function compareCodePoints(left: string, right: string): number {
  const leftIterator = left[Symbol.iterator]()
  const rightIterator = right[Symbol.iterator]()
  for (;;) {
    const leftPoint = leftIterator.next()
    const rightPoint = rightIterator.next()
    if (leftPoint.done || rightPoint.done) {
      if (leftPoint.done && rightPoint.done) return 0
      return leftPoint.done ? -1 : 1
    }
    const leftValue = leftPoint.value.codePointAt(0) as number
    const rightValue = rightPoint.value.codePointAt(0) as number
    if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1
  }
}
