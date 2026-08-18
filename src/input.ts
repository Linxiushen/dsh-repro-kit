import { open, stat } from 'node:fs/promises'
import { extname, posix, win32 } from 'node:path'
import { decodeStorageRecord, isJsonValue, type SessionEvent } from '@deepseek-ai/dsh-session'
import { foldSurface } from '@deepseek-ai/dsh-session/surface'
import { unzipSync, type UnzipFileInfo } from 'fflate'
import { ReproError } from './errors.js'
import {
  DEFAULT_INPUT_LIMITS,
  SUPPORTED_SESSION_FORMAT_VERSION,
  type InputLimits,
  type LoadedExport,
  type OmittedAttachment,
  type ParsedSession,
  type SessionHeaderRecord,
} from './types.js'
import { isRecord, sha256Hex } from './utils.js'

const LIMIT_KEYS = Object.freeze(Object.keys(DEFAULT_INPUT_LIMITS) as Array<keyof InputLimits>)
const HEADER_KEYS = new Set([
  'type',
  'version',
  'id',
  'createdAt',
  'cwd',
  'parentSession',
  'seedLength',
  'origin',
  'delegationDepth',
  'agentPreset',
])
const EVENT_KEYS = new Set([
  'type',
  'seq',
  'time',
  'data',
  'surfaceOp',
  'sourceEventSeqs',
  'ignorable',
])
const PACKED_ROW_PAYLOAD = Object.freeze({
  'text-chunks': 'texts',
  'reasoning-chunks': 'texts',
  'tool-call-chunks': 'args',
} as const)

interface ArchiveEntryMetadata {
  readonly path: string
  readonly compressedSize: number
  readonly size: number
}

type ObjectState = 'key-or-end' | 'key' | 'colon' | 'value' | 'comma-or-end'
type ArrayState = 'value-or-end' | 'value' | 'comma-or-end'

type JsonFrame = {
  readonly kind: 'object'
  readonly keys: Set<string>
  state: ObjectState
} | {
  readonly kind: 'array'
  state: ArrayState
}

class JsonScanError extends Error {
  constructor(
    message: string,
    readonly column: number,
  ) {
    super(message)
  }
}

class DuplicateJsonMemberError extends Error {
  constructor(
    readonly key: string,
    readonly column: number,
  ) {
    super(`duplicate JSON member ${JSON.stringify(key)}`)
  }
}

/** Iterative JSON grammar scan that rejects duplicate object members before JSON.parse loses them. */
class JsonMemberScanner {
  private offset = 0
  private rootComplete = false
  private readonly stack: JsonFrame[] = []

  constructor(private readonly input: string) {}

  scan(): void {
    this.consumeValue()
    while (this.stack.length > 0) {
      const frame = this.stack.at(-1)
      if (frame === undefined) throw this.syntax('internal JSON parser state')
      this.skipWhitespace()
      if (frame.kind === 'object') this.consumeObject(frame)
      else this.consumeArray(frame)
    }
    if (!this.rootComplete) throw this.syntax('incomplete JSON value')
    this.skipWhitespace()
    if (this.offset !== this.input.length) throw this.syntax('unexpected trailing content')
  }

  private consumeObject(frame: Extract<JsonFrame, { kind: 'object' }>): void {
    switch (frame.state) {
      case 'key-or-end':
        if (this.peek() === '}') {
          this.offset += 1
          this.finishContainer()
          return
        }
        this.consumeObjectKey(frame)
        return
      case 'key':
        this.consumeObjectKey(frame)
        return
      case 'colon':
        this.expect(':')
        frame.state = 'value'
        return
      case 'value':
        frame.state = 'comma-or-end'
        this.consumeValue()
        return
      case 'comma-or-end': {
        const next = this.peek()
        if (next === ',') {
          this.offset += 1
          frame.state = 'key'
          return
        }
        if (next === '}') {
          this.offset += 1
          this.finishContainer()
          return
        }
        throw this.syntax('expected "," or "}"')
      }
    }
  }

  private consumeObjectKey(frame: Extract<JsonFrame, { kind: 'object' }>): void {
    this.skipWhitespace()
    if (this.peek() !== '"') throw this.syntax('expected an object member name')
    const column = this.offset + 1
    const key = this.consumeString(true)
    if (frame.keys.has(key)) throw new DuplicateJsonMemberError(key, column)
    frame.keys.add(key)
    frame.state = 'colon'
  }

  private consumeArray(frame: Extract<JsonFrame, { kind: 'array' }>): void {
    switch (frame.state) {
      case 'value-or-end':
        if (this.peek() === ']') {
          this.offset += 1
          this.finishContainer()
          return
        }
        frame.state = 'comma-or-end'
        this.consumeValue()
        return
      case 'value':
        frame.state = 'comma-or-end'
        this.consumeValue()
        return
      case 'comma-or-end': {
        const next = this.peek()
        if (next === ',') {
          this.offset += 1
          frame.state = 'value'
          return
        }
        if (next === ']') {
          this.offset += 1
          this.finishContainer()
          return
        }
        throw this.syntax('expected "," or "]"')
      }
    }
  }

  private consumeValue(): void {
    this.skipWhitespace()
    const next = this.peek()
    if (next === '{') {
      this.offset += 1
      this.stack.push({ kind: 'object', keys: new Set(), state: 'key-or-end' })
      return
    }
    if (next === '[') {
      this.offset += 1
      this.stack.push({ kind: 'array', state: 'value-or-end' })
      return
    }
    if (next === '"') {
      this.consumeString(false)
      this.completePrimitiveRoot()
      return
    }
    if (next === 't') {
      this.consumeKeyword('true')
      this.completePrimitiveRoot()
      return
    }
    if (next === 'f') {
      this.consumeKeyword('false')
      this.completePrimitiveRoot()
      return
    }
    if (next === 'n') {
      this.consumeKeyword('null')
      this.completePrimitiveRoot()
      return
    }
    if (next === '-' || (next !== undefined && next >= '0' && next <= '9')) {
      this.consumeNumber()
      this.completePrimitiveRoot()
      return
    }
    throw this.syntax('expected a JSON value')
  }

  private consumeString(decode: boolean): string {
    const start = this.offset
    this.offset += 1
    for (;;) {
      if (this.offset >= this.input.length) throw this.syntax('unterminated string')
      const code = this.input.charCodeAt(this.offset)
      if (code === 0x22) {
        this.offset += 1
        if (!decode) return ''
        const raw = this.input.slice(start, this.offset)
        try {
          return JSON.parse(raw) as string
        } catch (error: unknown) {
          throw new JsonScanError(
            `invalid JSON string: ${error instanceof Error ? error.message : String(error)}`,
            start + 1,
          )
        }
      }
      if (code < 0x20) throw this.syntax('unescaped control character in string')
      if (code !== 0x5C) {
        this.offset += 1
        continue
      }
      this.offset += 1
      const escape = this.peek()
      if (escape === undefined) throw this.syntax('unterminated string escape')
      if (escape === 'u') {
        if (!/^[0-9A-Fa-f]{4}$/.test(this.input.slice(this.offset + 1, this.offset + 5))) {
          throw this.syntax('invalid Unicode escape')
        }
        this.offset += 5
        continue
      }
      if (!'"\\/bfnrt'.includes(escape)) throw this.syntax('invalid string escape')
      this.offset += 1
    }
  }

  private consumeKeyword(keyword: 'true' | 'false' | 'null'): void {
    if (!this.input.startsWith(keyword, this.offset)) throw this.syntax(`expected ${keyword}`)
    this.offset += keyword.length
  }

  private consumeNumber(): void {
    if (this.peek() === '-') this.offset += 1
    if (this.peek() === '0') {
      this.offset += 1
    } else {
      this.consumeDigits(true)
    }
    if (this.peek() === '.') {
      this.offset += 1
      this.consumeDigits(true)
    }
    const exponent = this.peek()
    if (exponent === 'e' || exponent === 'E') {
      this.offset += 1
      const sign = this.peek()
      if (sign === '+' || sign === '-') this.offset += 1
      this.consumeDigits(true)
    }
  }

  private consumeDigits(requireOne: boolean): void {
    const start = this.offset
    while (this.peek() !== undefined && this.peek()! >= '0' && this.peek()! <= '9') {
      this.offset += 1
    }
    if (requireOne && this.offset === start) throw this.syntax('expected a digit')
  }

  private completePrimitiveRoot(): void {
    if (this.stack.length === 0) this.rootComplete = true
  }

  private finishContainer(): void {
    this.stack.pop()
    if (this.stack.length === 0) this.rootComplete = true
  }

  private expect(expected: string): void {
    this.skipWhitespace()
    if (this.peek() !== expected) throw this.syntax(`expected ${JSON.stringify(expected)}`)
    this.offset += 1
  }

  private skipWhitespace(): void {
    while (' \t\r\n'.includes(this.peek() ?? '\0')) this.offset += 1
  }

  private peek(): string | undefined {
    return this.input[this.offset]
  }

  private syntax(message: string): JsonScanError {
    return new JsonScanError(message, this.offset + 1)
  }
}

function resolveLimits(input: Partial<InputLimits> | undefined): InputLimits {
  if (input !== undefined && (!isRecord(input) || Array.isArray(input))) {
    throw new ReproError('USAGE', 'input limits must be an object')
  }
  if (input !== undefined) {
    for (const key of Object.keys(input)) {
      if (!LIMIT_KEYS.includes(key as keyof InputLimits)) {
        throw new ReproError('USAGE', `unknown input limit ${JSON.stringify(key)}`)
      }
    }
  }
  const limits = { ...DEFAULT_INPUT_LIMITS, ...input }
  for (const key of LIMIT_KEYS) {
    const value = limits[key]
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ReproError('USAGE', `${key} must be a positive safe integer`, { key, value })
    }
  }
  return limits
}

function parseJsonLine(line: string, sourcePath: string, lineNumber: number): unknown {
  try {
    new JsonMemberScanner(line).scan()
  } catch (error: unknown) {
    if (error instanceof DuplicateJsonMemberError) {
      throw new ReproError(
        'DUPLICATE_JSON_MEMBER',
        `${sourcePath}:${lineNumber}:${error.column}: ${error.message}`,
        { sourcePath, line: lineNumber, column: error.column, member: error.key },
        { cause: error },
      )
    }
    const column = error instanceof JsonScanError ? error.column : undefined
    throw new ReproError(
      'INVALID_JSON',
      `${sourcePath}:${lineNumber}${column === undefined ? '' : `:${column}`}: invalid JSON`,
      { sourcePath, line: lineNumber, ...(column === undefined ? {} : { column }) },
      { cause: error },
    )
  }
  try {
    return JSON.parse(line)
  } catch (error: unknown) {
    throw new ReproError(
      'INVALID_JSON',
      `${sourcePath}:${lineNumber}: invalid JSON`,
      { sourcePath, line: lineNumber },
      { cause: error },
    )
  }
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && !Object.is(value, -0)
}

function parseHeader(value: unknown, sourcePath: string): SessionHeaderRecord {
  if (!isRecord(value)) {
    throw new ReproError('INVALID_SESSION', `${sourcePath}: first line is not a session header`)
  }
  if (typeof value['version'] === 'number'
    && value['version'] !== SUPPORTED_SESSION_FORMAT_VERSION) {
    throw new ReproError(
      'UNSUPPORTED_SESSION_VERSION',
      `${sourcePath}: unsupported session format version ${String(value['version'])}`,
      { sourcePath, version: value['version'], supported: SUPPORTED_SESSION_FORMAT_VERSION },
    )
  }
  for (const key of Object.keys(value)) {
    if (!HEADER_KEYS.has(key)) {
      throw new ReproError(
        'INVALID_SESSION',
        `${sourcePath}: session header contains unsupported field ${JSON.stringify(key)}`,
        { sourcePath, field: key },
      )
    }
  }
  if (value['type'] !== 'session'
    || value['version'] !== SUPPORTED_SESSION_FORMAT_VERSION
    || Object.is(value['version'], -0)
    || typeof value['id'] !== 'string'
    || value['id'].length === 0
    || !nonNegativeSafeInteger(value['createdAt'])
    || !nonNegativeSafeInteger(value['delegationDepth'])) {
    throw new ReproError('INVALID_SESSION', `${sourcePath}: malformed session header`, { sourcePath })
  }
  if (value['cwd'] !== undefined
    && (typeof value['cwd'] !== 'string'
      || (!posix.isAbsolute(value['cwd']) && !win32.isAbsolute(value['cwd'])))) {
    throw new ReproError('INVALID_SESSION', `${sourcePath}: session header cwd must be an absolute path`)
  }
  if (value['parentSession'] !== undefined
    && (typeof value['parentSession'] !== 'string' || value['parentSession'].length === 0)) {
    throw new ReproError('INVALID_SESSION', `${sourcePath}: session header parentSession must be a non-empty string`)
  }
  if (value['seedLength'] !== undefined && !nonNegativeSafeInteger(value['seedLength'])) {
    throw new ReproError('INVALID_SESSION', `${sourcePath}: session header seedLength must be a non-negative safe integer`)
  }
  if (value['origin'] !== undefined && value['origin'] !== 'subagent') {
    throw new ReproError('INVALID_SESSION', `${sourcePath}: session header origin must be "subagent"`)
  }
  if (value['agentPreset'] !== undefined && typeof value['agentPreset'] !== 'string') {
    throw new ReproError('INVALID_SESSION', `${sourcePath}: session header agentPreset must be a string`)
  }
  return value as unknown as SessionHeaderRecord
}

function validateEvent(value: unknown, expectedSeq: number, sourcePath: string): SessionEvent {
  if (!isRecord(value)) {
    throw new ReproError(
      'INVALID_SESSION',
      `${sourcePath}: event at seq ${expectedSeq} is not an object`,
      { sourcePath, expectedSeq },
    )
  }
  for (const key of Object.keys(value)) {
    if (!EVENT_KEYS.has(key)) {
      throw new ReproError(
        'INVALID_SESSION',
        `${sourcePath}: event at seq ${expectedSeq} contains unsupported field ${JSON.stringify(key)}`,
        { sourcePath, expectedSeq, field: key },
      )
    }
  }
  if (typeof value['type'] !== 'string'
    || value['type'].length === 0
    || !nonNegativeSafeInteger(value['seq'])
    || !Number.isSafeInteger(value['time'])
    || !Object.hasOwn(value, 'data')
    || (value['ignorable'] !== undefined && value['ignorable'] !== true)) {
    throw new ReproError(
      'INVALID_SESSION',
      `${sourcePath}: malformed event envelope at expected seq ${expectedSeq}`,
      { sourcePath, expectedSeq },
    )
  }
  if (!isJsonValue(value)) {
    throw new ReproError(
      'INVALID_SESSION',
      `${sourcePath}: event at expected seq ${expectedSeq} is not lossless JSON`,
      { sourcePath, expectedSeq },
    )
  }
  if (value['seq'] !== expectedSeq) {
    throw new ReproError(
      'INVALID_SESSION',
      `${sourcePath}: event seq gap (expected ${expectedSeq}, got ${value['seq']})`,
      { sourcePath, expectedSeq, actualSeq: value['seq'] },
    )
  }
  const sources = value['sourceEventSeqs']
  if (sources !== undefined) {
    if (!Array.isArray(sources)) {
      throw new ReproError(
        'INVALID_SESSION',
        `${sourcePath}: sourceEventSeqs at seq ${expectedSeq} must be an array`,
        { sourcePath, seq: expectedSeq },
      )
    }
    for (const sourceSeq of sources) {
      if (!nonNegativeSafeInteger(sourceSeq) || sourceSeq >= expectedSeq) {
        throw new ReproError(
          'INVALID_SESSION',
          `${sourcePath}: sourceEventSeqs at seq ${expectedSeq} must cite only earlier events`,
          { sourcePath, seq: expectedSeq, sourceSeq },
        )
      }
    }
  }
  return value as unknown as SessionEvent
}

function decodeUtf8(bytes: Uint8Array, sourcePath: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    throw new ReproError(
      'INVALID_JSON',
      `${sourcePath}: input is not valid UTF-8`,
      { sourcePath },
      { cause: error },
    )
  }
}

function jsonlLineCount(text: string): number {
  if (text.length === 0) return 0
  let count = 1
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 0x0A) count += 1
  }
  if (text.endsWith('\n')) count -= 1
  return count
}

function packedRecordEventCount(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined
  const type = value['type']
  if (typeof type !== 'string' || !Object.hasOwn(PACKED_ROW_PAYLOAD, type)) return undefined
  const data = value['data']
  if (!isRecord(data)) return undefined
  const payloadKey = PACKED_ROW_PAYLOAD[type as keyof typeof PACKED_ROW_PAYLOAD]
  const payload = data[payloadKey]
  return Array.isArray(payload) ? payload.length : undefined
}

function assertEventBudget(
  currentEvents: number,
  addedEvents: number,
  sourcePath: string,
  line: number,
  limits: InputLimits,
): void {
  const maxEvents = limits.maxJsonlLines - 1
  if (addedEvents <= maxEvents - currentEvents) return
  throw new ReproError(
    'INPUT_TOO_LARGE',
    `${sourcePath}:${line}: decoded event count exceeds the maxJsonlLines budget`,
    { sourcePath, line, currentEvents, recordEvents: addedEvents, limit: maxEvents },
  )
}

function parseSessionJsonl(
  bytes: Uint8Array,
  sourcePath: string,
  limits: InputLimits,
): ParsedSession {
  const text = decodeUtf8(bytes, sourcePath)
  const lineCount = jsonlLineCount(text)
  if (lineCount > limits.maxJsonlLines) {
    throw new ReproError(
      'INPUT_TOO_LARGE',
      `${sourcePath}: JSONL line count exceeds maxJsonlLines`,
      { sourcePath, lines: lineCount, limit: limits.maxJsonlLines },
    )
  }
  if (lineCount === 0) {
    throw new ReproError('INVALID_SESSION', `${sourcePath}: empty session log`, { sourcePath })
  }
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const first = lines[0]
  if (first === undefined || first.trim().length === 0) {
    throw new ReproError('INVALID_SESSION', `${sourcePath}: missing session header`, { sourcePath })
  }
  const header = parseHeader(parseJsonLine(first, sourcePath, 1), sourcePath)
  const events: SessionEvent[] = []
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined || line.trim().length === 0) {
      throw new ReproError(
        'INVALID_JSON',
        `${sourcePath}:${index + 1}: blank JSONL records are not allowed`,
        { sourcePath, line: index + 1 },
      )
    }
    const record = parseJsonLine(line, sourcePath, index + 1)
    const packedEvents = packedRecordEventCount(record)
    if (packedEvents !== undefined) {
      assertEventBudget(events.length, packedEvents, sourcePath, index + 1, limits)
    }
    let decoded: SessionEvent[]
    try {
      decoded = decodeStorageRecord(record)
    } catch (error: unknown) {
      throw new ReproError(
        'INVALID_SESSION',
        `${sourcePath}:${index + 1}: malformed session storage row`,
        { sourcePath, line: index + 1 },
        { cause: error },
      )
    }
    assertEventBudget(events.length, decoded.length, sourcePath, index + 1, limits)
    for (const event of decoded) events.push(validateEvent(event, events.length, sourcePath))
  }
  try {
    foldSurface(events)
  } catch (error: unknown) {
    throw new ReproError(
      'INVALID_SESSION',
      `${sourcePath}: session surface invariants failed`,
      { sourcePath },
      { cause: error },
    )
  }
  return {
    sourcePath,
    header,
    events,
    sourceSha256: sha256Hex(bytes),
    sourceBytes: bytes.byteLength,
  }
}

function assertSafeArchivePath(path: string): void {
  const unsafe = path.length === 0
    || path.includes('\0')
    || path.includes('\\')
    || path.startsWith('/')
    || /^[A-Za-z]:/.test(path)
  const segments = path.split('/')
  if (unsafe || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new ReproError(
      'UNSAFE_ARCHIVE',
      `unsafe ZIP entry path ${JSON.stringify(path)}`,
      { path },
    )
  }
}

function assertArchiveSize(value: number, field: 'size' | 'originalSize', path: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ReproError(
      'UNSAFE_ARCHIVE',
      `ZIP entry ${JSON.stringify(path)} has invalid ${field} metadata`,
      { path, field, value },
    )
  }
}

function parseZip(bytes: Uint8Array, inputPath: string, limits: InputLimits): LoadedExport {
  const seen = new Set<string>()
  const jsonlEntries: ArchiveEntryMetadata[] = []
  const attachments: OmittedAttachment[] = []
  let entries = 0
  let sessions = 0
  let totalUncompressed = 0
  try {
    // This pass visits every central-directory record but extracts nothing. All
    // aggregate limits therefore settle before the first inflater is created.
    unzipSync(bytes, {
      filter(info: UnzipFileInfo): boolean {
        entries += 1
        if (entries > limits.maxEntries) {
          throw new ReproError(
            'INPUT_TOO_LARGE',
            `ZIP entry count exceeds maxEntries (${limits.maxEntries})`,
            { entries, limit: limits.maxEntries },
          )
        }
        assertSafeArchivePath(info.name)
        if (seen.has(info.name)) {
          throw new ReproError(
            'UNSAFE_ARCHIVE',
            `duplicate ZIP entry ${JSON.stringify(info.name)}`,
            { path: info.name },
          )
        }
        seen.add(info.name)
        assertArchiveSize(info.size, 'size', info.name)
        assertArchiveSize(info.originalSize, 'originalSize', info.name)
        if (info.originalSize > limits.maxEntryBytes) {
          throw new ReproError(
            'INPUT_TOO_LARGE',
            `ZIP entry ${JSON.stringify(info.name)} exceeds maxEntryBytes`,
            { path: info.name, size: info.originalSize, limit: limits.maxEntryBytes },
          )
        }
        if (info.originalSize > limits.maxTotalUncompressedBytes - totalUncompressed) {
          throw new ReproError(
            'INPUT_TOO_LARGE',
            'ZIP total uncompressed size exceeds maxTotalUncompressedBytes',
            {
              path: info.name,
              size: info.originalSize,
              totalBefore: totalUncompressed,
              limit: limits.maxTotalUncompressedBytes,
            },
          )
        }
        totalUncompressed += info.originalSize
        const metadata: ArchiveEntryMetadata = {
          path: info.name,
          compressedSize: info.size,
          size: info.originalSize,
        }
        if (info.name.endsWith('.jsonl')) {
          sessions += 1
          if (sessions > limits.maxSessions) {
            throw new ReproError(
              'INPUT_TOO_LARGE',
              `ZIP session count exceeds maxSessions (${limits.maxSessions})`,
              { sessions, limit: limits.maxSessions },
            )
          }
          jsonlEntries.push(metadata)
        } else if (info.name.startsWith('media/')) {
          attachments.push({
            sourcePath: info.name,
            size: info.originalSize,
            compressedSize: info.size,
            reason: 'privacy-default',
          })
        }
        return false
      },
    })
  } catch (error: unknown) {
    if (error instanceof ReproError) throw error
    throw new ReproError(
      'UNSAFE_ARCHIVE',
      `${inputPath}: invalid or unsupported ZIP archive`,
      { sourcePath: inputPath },
      { cause: error },
    )
  }

  if (jsonlEntries.length === 0) {
    throw new ReproError('INVALID_SESSION', `${inputPath}: ZIP contains no session JSONL files`)
  }
  const jsonlPaths = new Set(jsonlEntries.map(entry => entry.path))
  let extracted: Record<string, Uint8Array>
  try {
    extracted = unzipSync(bytes, { filter: info => jsonlPaths.has(info.name) })
  } catch (error: unknown) {
    throw new ReproError(
      'UNSAFE_ARCHIVE',
      `${inputPath}: failed to extract session JSONL entries`,
      { sourcePath: inputPath },
      { cause: error },
    )
  }
  const parsed: ParsedSession[] = []
  const sessionIds = new Map<string, string>()
  for (const entry of jsonlEntries) {
    const content = extracted[entry.path]
    if (content === undefined || content.byteLength !== entry.size) {
      throw new ReproError(
        'UNSAFE_ARCHIVE',
        `ZIP entry ${JSON.stringify(entry.path)} did not match its size metadata`,
        { path: entry.path, expected: entry.size, actual: content?.byteLength },
      )
    }
    const session = parseSessionJsonl(content, entry.path, limits)
    const existing = sessionIds.get(session.header.id)
    if (existing !== undefined) {
      throw new ReproError(
        'INVALID_SESSION',
        `duplicate session id ${JSON.stringify(session.header.id)} in ZIP`,
        { id: session.header.id, firstPath: existing, secondPath: entry.path },
      )
    }
    sessionIds.set(session.header.id, entry.path)
    parsed.push(session)
  }
  return {
    kind: 'zip',
    sourceSha256: sha256Hex(bytes),
    sourceBytes: bytes.byteLength,
    sessions: parsed,
    attachments,
  }
}

function hasZipSignature(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4B) return false
  const third = bytes[2]
  const fourth = bytes[3]
  return (third === 0x03 && fourth === 0x04)
    || (third === 0x05 && fourth === 0x06)
    || (third === 0x07 && fourth === 0x08)
}

function looksLikeJson(bytes: Uint8Array): boolean {
  let offset = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF ? 3 : 0
  while (offset < bytes.byteLength) {
    const byte = bytes[offset]
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0A && byte !== 0x0D) return byte === 0x7B
    offset += 1
  }
  return false
}

async function readBounded(path: string, maxInputBytes: number): Promise<Uint8Array> {
  let pathInfo
  try {
    pathInfo = await stat(path)
  } catch (error: unknown) {
    throw new ReproError(
      'INPUT_NOT_FOUND',
      `cannot read input ${JSON.stringify(path)}`,
      { path },
      { cause: error },
    )
  }
  if (!pathInfo.isFile()) {
    throw new ReproError(
      'UNSUPPORTED_INPUT',
      `input is not a regular file: ${JSON.stringify(path)}`,
      { path },
    )
  }
  if (!Number.isSafeInteger(pathInfo.size) || pathInfo.size > maxInputBytes) {
    throw new ReproError(
      'INPUT_TOO_LARGE',
      `input exceeds maxInputBytes (${maxInputBytes})`,
      { path, size: pathInfo.size, limit: maxInputBytes },
    )
  }

  let handle
  try {
    handle = await open(path, 'r')
  } catch (error: unknown) {
    throw new ReproError(
      'INPUT_NOT_FOUND',
      `cannot read input ${JSON.stringify(path)}`,
      { path },
      { cause: error },
    )
  }

  try {
    try {
      const info = await handle.stat()
      if (!info.isFile()) {
        throw new ReproError(
          'UNSUPPORTED_INPUT',
          `input is not a regular file: ${JSON.stringify(path)}`,
          { path },
        )
      }
      if (!Number.isSafeInteger(info.size) || info.size > maxInputBytes) {
        throw new ReproError(
          'INPUT_TOO_LARGE',
          `input exceeds maxInputBytes (${maxInputBytes})`,
          { path, size: info.size, limit: maxInputBytes },
        )
      }

      // Read through the same handle that was inspected. A bounded probe after
      // the stat-sized prefix catches files that grow while they are being read.
      const prefix = new Uint8Array(info.size)
      let total = 0
      while (total < prefix.byteLength) {
        const { bytesRead } = await handle.read(
          prefix,
          total,
          prefix.byteLength - total,
          total,
        )
        if (bytesRead === 0) break
        total += bytesRead
      }

      const chunks: Uint8Array[] = total === 0 ? [] : [prefix.subarray(0, total)]
      for (;;) {
        const remaining = maxInputBytes - total
        const chunk = new Uint8Array(Math.min(64 * 1024, remaining + 1))
        const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, total)
        if (bytesRead === 0) break
        total += bytesRead
        if (total > maxInputBytes) {
          throw new ReproError(
            'INPUT_TOO_LARGE',
            `input exceeds maxInputBytes (${maxInputBytes})`,
            { path, size: total, limit: maxInputBytes },
          )
        }
        chunks.push(chunk.subarray(0, bytesRead))
      }

      if (chunks.length === 0) return new Uint8Array()
      if (chunks.length === 1) return chunks[0] as Uint8Array
      const bytes = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return bytes
    } finally {
      await handle.close()
    }
  } catch (error: unknown) {
    if (error instanceof ReproError) throw error
    throw new ReproError(
      'INPUT_NOT_FOUND',
      `cannot read input ${JSON.stringify(path)}`,
      { path },
      { cause: error },
    )
  }
}

/** Load one plaintext DSH session JSONL file or an official session-export ZIP. */
export async function loadExport(
  path: string,
  inputLimits?: Partial<InputLimits>,
): Promise<LoadedExport> {
  if (typeof path !== 'string' || path.length === 0) {
    throw new ReproError('USAGE', 'input path must be a non-empty string')
  }
  const limits = resolveLimits(inputLimits)
  const bytes = await readBounded(path, limits.maxInputBytes)
  if (hasZipSignature(bytes) || extname(path).toLowerCase() === '.zip') {
    return parseZip(bytes, path, limits)
  }
  if (extname(path).toLowerCase() !== '.jsonl' && !looksLikeJson(bytes)) {
    throw new ReproError(
      'UNSUPPORTED_INPUT',
      `input must be a .jsonl session log or .zip session export: ${JSON.stringify(path)}`,
      { path },
    )
  }
  const session = parseSessionJsonl(bytes, path, limits)
  return {
    kind: 'jsonl',
    sourceSha256: sha256Hex(bytes),
    sourceBytes: bytes.byteLength,
    sessions: [session],
    attachments: [],
  }
}
