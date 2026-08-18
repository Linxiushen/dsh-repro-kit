import type { RedactedSlice, RedactionCounts } from './types.js'
import { isRecord } from './utils.js'

export type AliasKind =
  | 'attachment'
  | 'call'
  | 'command'
  | 'compaction'
  | 'handler'
  | 'message'
  | 'retry'
  | 'run'
  | 'session'

export type TextKind =
  | 'text'
  | 'opaque'
  | 'path'
  | 'secret'
  | 'email'
  | 'url'
  | 'key'
  | 'secret-key'

export const OPAQUE_KEYS = new Set(['meta', 'replayState', 'raw', 'body', 'headers'])
export const PATH_KEYS = new Set(['cwd', 'path', 'file', 'filename', 'directory', 'root', 'workingDirectory'])
export const SENSITIVE_KEY = /(?:^|_)(?:api[-_]?key|secret|token|password|passwd|authorization|cookie|credential)(?:$|_)/i
export const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
export const TOKEN = /\b(?:AKIA[0-9A-Z]{16}|(?:sk|gh[opusr]|github_pat|xox[baprs])[-_A-Za-z0-9]{8,})\b/g
export const BEARER = /\bBearer\s+[^\s,;]+/gi

const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/
const SAFE_OBJECT_KEY = /^[A-Za-z][A-Za-z\d_-]{0,63}$/
// Fixed schema vocabulary is safe to retain; arbitrary `$...` keys remain a data channel.
const SAFE_JSON_SCHEMA_KEYS = new Set([
  '$anchor',
  '$comment',
  '$defs',
  '$dynamicAnchor',
  '$dynamicRef',
  '$id',
  '$recursiveAnchor',
  '$recursiveRef',
  '$ref',
  '$schema',
  '$vocabulary',
])
const SCHEMA_MAP_KEYS = new Set([
  '$defs',
  'definitions',
  'dependentRequired',
  'dependentSchemas',
  'patternProperties',
  'properties',
])
export const REDACTION_PLACEHOLDER = /<redacted-(text|data|path|secret|email|url|key|secret-key)-(\d+) chars=(\d+)>/g
const FULL_PLACEHOLDER = /^<redacted-(text|data|path|secret|email|url|key)-(\d+) chars=(\d+)>$/
const FULL_KEY_PLACEHOLDER = /^<redacted-(?:secret-)?key-(\d+) chars=(\d+)>$/
const FULL_SECRET_KEY_PLACEHOLDER = /^<redacted-secret-key-\d+ chars=\d+>$/
const MAX_JSON_DEPTH = 128
const MAX_JSON_NODES = 1_000_000

const PRESERVED_STRING_KEYS = new Set([
  'type',
  'eventType',
  'kind',
  'role',
  'source',
  'form',
  'status',
  'reason',
  'origin',
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

export type StringDisposition =
  | { readonly kind: 'alias'; readonly aliasKind: AliasKind }
  | { readonly kind: 'text'; readonly textKind: TextKind }
  | { readonly kind: 'preserve' }

/** Decide how one string position is transformed by share-safe-v1. */
export function stringDisposition(
  raw: string,
  path: readonly string[],
  parent: Record<string, unknown> | undefined,
): StringDisposition {
  const key = path.at(-1) ?? ''
  const aliasKind = identifierKind(key, path, parent)
  if (aliasKind !== undefined) return { kind: 'alias', aliasKind }
  if (FULL_SECRET_KEY_PLACEHOLDER.test(key)) return { kind: 'text', textKind: 'secret' }
  if (isSchemaKeyValue(path)) return { kind: 'text', textKind: 'key' }
  if (OPAQUE_KEYS.has(key)) return { kind: 'text', textKind: 'opaque' }
  if (PATH_KEYS.has(key) || ABSOLUTE_PATH.test(raw)) return { kind: 'text', textKind: 'path' }
  if (SENSITIVE_KEY.test(key)) return { kind: 'text', textKind: 'secret' }
  if (CONTENT_KEYS.has(key) || key === 'content' || key === 'data' && path.includes('content')) {
    return { kind: 'text', textKind: 'text' }
  }
  if (!PRESERVED_STRING_KEYS.has(key)) return { kind: 'text', textKind: 'text' }
  if (raw.length > 256 || hasUnsafeDisplayCharacter(raw)) {
    return { kind: 'text', textKind: 'text' }
  }
  return { kind: 'preserve' }
}

/** Reject pathological graphs before recursive redaction or canonical serialization. */
export function assertRedactionBudget(value: unknown): void {
  type Frame = { readonly value: unknown; readonly depth: number; readonly exit?: boolean }
  const stack: Frame[] = [{ value, depth: 0 }]
  const active = new WeakSet<object>()
  let nodes = 0
  while (stack.length > 0) {
    const frame = stack.pop() as Frame
    if (frame.exit) {
      active.delete(frame.value as object)
      continue
    }
    nodes += 1
    if (nodes > MAX_JSON_NODES) throw new ShareSafePolicyError('redaction input exceeds the JSON node budget')
    if (frame.depth > MAX_JSON_DEPTH) throw new ShareSafePolicyError('redaction input exceeds the JSON depth budget')
    if (frame.value === null || typeof frame.value !== 'object') continue
    if (active.has(frame.value)) throw new ShareSafePolicyError('redaction input contains a circular reference')
    active.add(frame.value)
    stack.push({ ...frame, exit: true })
    const children = Array.isArray(frame.value) ? frame.value : Object.values(frame.value)
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ value: children[index], depth: frame.depth + 1 })
    }
  }
}

/** Recompute and enforce the share-safe-v1 payload policy from final redacted values. */
export function auditRedactedSlice(slice: RedactedSlice): RedactionCounts {
  const payload = {
    source: slice.source,
    requestedTarget: slice.requestedTarget,
    target: slice.target,
    sessions: slice.sessions,
  }
  assertRedactionBudget(payload)
  const counts: MutableCounts = { identifiers: 0, textValues: 0, secrets: 0, paths: 0 }
  auditValue(payload, counts)
  if (!sameCounts(counts, slice.counts)) {
    throw new ShareSafePolicyError(
      `declared redaction counts do not match the final payload (declared ${formatCounts(slice.counts)}; `
      + `recomputed ${formatCounts(counts)})`,
    )
  }
  return counts
}

export class ShareSafePolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ShareSafePolicyError'
  }
}

interface MutableCounts {
  identifiers: number
  textValues: number
  secrets: number
  paths: number
}

function auditValue(root: unknown, counts: MutableCounts): void {
  interface Frame {
    readonly value: unknown
    readonly path: readonly string[]
    readonly parent?: Record<string, unknown>
  }
  const stack: Frame[] = [{ value: root, path: [] }]
  while (stack.length > 0) {
    const { value, path, parent } = stack.pop() as Frame
    if (typeof value === 'string') {
      auditString(value, path, parent, counts)
      continue
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') continue
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: value[index], path: [...path, String(index)] })
      }
      continue
    }
    if (!isRecord(value)) throw new ShareSafePolicyError(`non-JSON value at ${formatPath(path)}`)
    const keys = Object.keys(value)
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index] as string
      if (!isPreservedObjectKey(key, path)) {
        if (!FULL_KEY_PLACEHOLDER.test(key)) {
          throw new ShareSafePolicyError(`unsafe object key under ${formatPath(path)}`)
        }
        counts.textValues += 1
      }
      stack.push({ value: value[key], path: [...path, key], parent: value })
    }
  }
}

export function isSchemaMapPath(path: readonly string[]): boolean {
  return SCHEMA_MAP_KEYS.has(path.at(-1) ?? '')
}

export function isPreservedObjectKey(key: string, parentPath: readonly string[]): boolean {
  return !isSchemaMapPath(parentPath) && (SAFE_OBJECT_KEY.test(key) || SAFE_JSON_SCHEMA_KEYS.has(key))
}

function isSchemaKeyValue(path: readonly string[]): boolean {
  const key = path.at(-1) ?? ''
  if (!/^\d+$/.test(key)) return false
  return path.at(-2) === 'required' || path.includes('dependentRequired')
}

function auditString(
  value: string,
  path: readonly string[],
  parent: Record<string, unknown> | undefined,
  counts: MutableCounts,
): void {
  const disposition = stringDisposition(value, path, parent)
  if (disposition.kind === 'alias') {
    const expected = new RegExp(`^${disposition.aliasKind}-\\d+$`)
    if (!expected.test(value)) throw new ShareSafePolicyError(`unredacted identifier at ${formatPath(path)}`)
    counts.identifiers += 1
    return
  }
  if (disposition.kind === 'text') {
    const match = FULL_PLACEHOLDER.exec(value)
    const expected = disposition.textKind === 'opaque' ? 'data' : disposition.textKind
    const actual = match?.[1]
    if (actual !== expected && !(expected === 'text' && actual === 'path')) {
      throw new ShareSafePolicyError(`unredacted ${expected} value at ${formatPath(path)}`)
    }
    incrementPlaceholder(actual as string, counts)
    return
  }
  if (value.length > 256 || hasUnsafeDisplayCharacter(value)
    || ABSOLUTE_PATH.test(value)
    || hasMatch(EMAIL, value) || hasMatch(TOKEN, value) || hasMatch(BEARER, value)
    || /^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    throw new ShareSafePolicyError(`unsafe preserved metadata at ${formatPath(path)}`)
  }
  REDACTION_PLACEHOLDER.lastIndex = 0
  for (const match of value.matchAll(REDACTION_PLACEHOLDER)) incrementPlaceholder(match[1] as string, counts)
}

function incrementPlaceholder(label: string, counts: MutableCounts): void {
  if (label === 'path') counts.paths += 1
  else if (label === 'secret') counts.secrets += 1
  else counts.textValues += 1
}

export function hasUnsafeDisplayCharacter(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0) as number
    if (point < 0x20 || point >= 0x7F && point <= 0x9F
      || point === 0x061C || point === 0x200E || point === 0x200F
      || point >= 0x2028 && point <= 0x202E
      || point >= 0x2066 && point <= 0x2069) return true
  }
  return false
}

function identifierKind(
  key: string,
  path: readonly string[],
  parent: Record<string, unknown> | undefined,
): AliasKind | undefined {
  if (key === 'sessionId' || key === 'parentSession' || key === 'parentSessionId'
    || key === 'childId' || key === 'senderSessionId') return 'session'
  if (key === 'callId' || key === 'toolCallId' || key === 'rootCallId'
    || key === 'parentCallId' || key === 'subCallId') return 'call'
  if (key === 'runId') return 'run'
  if (key === 'commandId' || key === 'sourceCommandId') return 'command'
  if (key === 'compactionId') return 'compaction'
  if (key === 'retryId') return 'retry'
  if (key === 'handlerId') return 'handler'
  if (key === 'messageId') return 'message'
  if (key === 'attachmentId') return 'attachment'
  if (key !== 'id') return undefined
  if (parent?.['type'] === 'session') return 'session'
  if (parent?.['type'] === 'tool-call' || parent?.['type'] === 'tool-call-delta') return 'call'
  if (parent?.['type'] === 'image' || path.includes('attachment') || parent?.['reason'] === 'privacy-default') {
    return 'attachment'
  }
  if (path.at(-2) === 'message') return 'message'
  return undefined
}

function hasMatch(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0
  return pattern.test(value)
}

function sameCounts(left: RedactionCounts, right: RedactionCounts): boolean {
  return left.identifiers === right.identifiers
    && left.textValues === right.textValues
    && left.secrets === right.secrets
    && left.paths === right.paths
}

function formatPath(path: readonly string[]): string {
  return path.length === 0 ? '<root>' : path.join('.')
}

function formatCounts(counts: RedactionCounts): string {
  return `${counts.identifiers}/${counts.textValues}/${counts.secrets}/${counts.paths}`
}
