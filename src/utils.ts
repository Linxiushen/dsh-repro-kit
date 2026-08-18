import { createHash } from 'node:crypto'

export type JsonScalar = string | number | boolean | null
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function sha256Hex(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function canonicalStringify(value: unknown, space?: number): string {
  return JSON.stringify(canonicalize(value), undefined, space)
}

function canonicalize(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON does not support non-finite numbers')
    return value
  }
  if (Array.isArray(value)) return value.map(item => canonicalize(item))
  if (isRecord(value)) {
    const result: Record<string, JsonValue> = {}
    for (const key of Object.keys(value).sort()) {
      const item = value[key]
      if (item !== undefined) result[key] = canonicalize(item)
    }
    return result
  }
  throw new TypeError(`canonical JSON does not support ${typeof value}`)
}

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB'] as const
  let value = bytes / 1024
  let unit = units[0]
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024
    unit = units[index] as typeof unit
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`
}
