import { ReproError } from './errors.js'

/** Decode UTF-8 without silently replacing malformed byte sequences. */
export function decodeUtf8Strict(bytes: Uint8Array, location: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new ReproError('INVALID_JSON', `${location} is not valid UTF-8`, { location }, { cause: error })
  }
}

/** Parse JSON and reject duplicate object members at every nesting level. */
export function parseJsonStrict<T = unknown>(text: string, location: string): T {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new ReproError('INVALID_JSON', `${location} is not valid JSON`, { location }, { cause: error })
  }
  new DuplicateMemberScanner(text, location).scan()
  return value as T
}

class DuplicateMemberScanner {
  private static readonly MAX_DEPTH = 256
  private index = 0

  constructor(private readonly text: string, private readonly location: string) {}

  scan(): void {
    this.skipWhitespace()
    this.value([], 0)
  }

  private value(path: readonly string[], depth: number): void {
    if (depth > DuplicateMemberScanner.MAX_DEPTH) {
      throw new ReproError('INVALID_JSON', `${this.location} exceeds the maximum JSON nesting depth`, {
        location: this.location,
        maxDepth: DuplicateMemberScanner.MAX_DEPTH,
      })
    }
    this.skipWhitespace()
    const token = this.text[this.index]
    if (token === '{') this.object(path, depth)
    else if (token === '[') this.array(path, depth)
    else if (token === '"') void this.string()
    else this.primitive()
  }

  private object(path: readonly string[], depth: number): void {
    this.index += 1
    this.skipWhitespace()
    if (this.text[this.index] === '}') {
      this.index += 1
      return
    }
    const keys = new Set<string>()
    while (this.index < this.text.length) {
      this.skipWhitespace()
      const key = this.string()
      if (keys.has(key)) {
        const pointer = `/${[...path, key].map(pointerSegment).join('/')}`
        throw new ReproError(
          'DUPLICATE_JSON_MEMBER',
          `${this.location} contains duplicate JSON member ${JSON.stringify(key)} at ${pointer}`,
          { location: this.location, key, pointer },
        )
      }
      keys.add(key)
      this.skipWhitespace()
      this.index += 1 // colon; JSON.parse already established valid syntax.
      this.value([...path, key], depth + 1)
      this.skipWhitespace()
      if (this.text[this.index] === '}') {
        this.index += 1
        return
      }
      this.index += 1 // comma
    }
  }

  private array(path: readonly string[], depth: number): void {
    this.index += 1
    this.skipWhitespace()
    if (this.text[this.index] === ']') {
      this.index += 1
      return
    }
    let item = 0
    while (this.index < this.text.length) {
      this.value([...path, String(item)], depth + 1)
      item += 1
      this.skipWhitespace()
      if (this.text[this.index] === ']') {
        this.index += 1
        return
      }
      this.index += 1 // comma
    }
  }

  private string(): string {
    const start = this.index
    this.index += 1
    while (this.index < this.text.length) {
      const token = this.text[this.index]
      if (token === '\\') {
        this.index += 2
      } else if (token === '"') {
        this.index += 1
        return JSON.parse(this.text.slice(start, this.index)) as string
      } else {
        this.index += 1
      }
    }
    return '' // Unreachable after the document-level JSON.parse succeeds.
  }

  private primitive(): void {
    while (this.index < this.text.length && !/[\s,\]}]/.test(this.text[this.index] ?? '')) this.index += 1
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.text[this.index] ?? '')) this.index += 1
  }
}

function pointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1')
}
