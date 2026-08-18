import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { redactSlice } from '../src/redact.js'
import type { SliceResult } from '../src/types.js'

function requestHeaderSlice(parameters: Record<string, unknown>): SliceResult {
  const event = {
    type: 'request/header',
    seq: 0,
    time: 1_001,
    data: {
      header: {
        config: { provider: 'deepseek', model: 'deepseek-chat' },
        tools: [{ name: 'lookup', description: 'private tool description', parameters }],
      },
      reason: 'initial',
    },
  } as unknown as SessionEvent
  return {
    source: {
      kind: 'jsonl',
      sourceSha256: 'a'.repeat(64),
      sourceBytes: 128,
      sessions: [],
      attachments: [],
    },
    requestedTarget: { kind: 'seq', seq: 0 },
    target: { kind: 'seq', sessionId: 'raw-session', originalSeq: 0, eventType: 'request/header' },
    sessions: [{
      sourcePath: 'session.jsonl',
      header: {
        type: 'session', version: 0, id: 'raw-session', createdAt: 1_000, delegationDepth: 0,
      },
      events: [event],
      originalSeqs: [0],
      lineageOnly: false,
    }],
  }
}

describe('share-safe object-key policy', () => {
  it('accepts fixed JSON Schema reference keywords used by Harness tool schemas', () => {
    const result = redactSlice(requestHeaderSlice({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://example.invalid/private-tool-schema',
      $vocabulary: { 'https://json-schema.org/draft/2020-12/vocab/core': true },
      type: 'object',
      $defs: {
        Address: {
          type: 'object',
          properties: { street: { type: 'string' } },
        },
      },
      properties: {
        destination: { $ref: '#/$defs/Address' },
        properties: { type: 'string' },
      },
      required: ['destination'],
    }))
    const serialized = JSON.stringify(result)
    const redactedEvent = result.sessions[0]!.events[0] as unknown as {
      data: { header: { tools: { parameters: Record<string, unknown> }[] } }
    }
    const parameters = redactedEvent.data.header.tools[0]!.parameters
    const properties = parameters['properties'] as Record<string, unknown>
    const propertyKey = Object.keys(properties)[0] as string

    expect(serialized).toContain('"$schema"')
    expect(serialized).toContain('"$vocabulary"')
    expect(serialized).toContain('"$defs"')
    expect(serialized).toContain('"$ref"')
    expect(serialized).not.toContain('private-tool-schema')
    expect(serialized).not.toContain('#/$defs/Address')
    expect(serialized).not.toContain('private tool description')
    expect(serialized).not.toContain('"destination"')
    expect(propertyKey).toMatch(/^<redacted-key-\d+ chars=11>$/)
    expect(parameters['required']).toEqual([propertyKey])
    expect(Object.values(properties)).toContainEqual({ type: 'string' })
  })

  it.each([
    '1stField',
    '_private',
    '__proto__',
    '路径',
    '^x-',
    '$private',
    'a'.repeat(65),
  ])('replaces free-form schema key %s with one stable placeholder', (key) => {
    const result = redactSlice(requestHeaderSlice({
      type: 'object',
      properties: { [key]: { type: 'string' } },
      dependentSchemas: { [key]: { type: 'string' } },
    }))
    const serialized = JSON.stringify(result)
    const placeholders = serialized.match(/<redacted-key-\d+ chars=\d+>/g) ?? []

    expect(serialized).not.toContain(JSON.stringify(key))
    expect(placeholders).toHaveLength(2)
    expect(new Set(placeholders).size).toBe(1)
    expect(result.counts.textValues).toBeGreaterThanOrEqual(2)
  })

  it('preserves the secret disposition of an unsafe sensitive key', () => {
    const result = redactSlice(requestHeaderSlice({ type: 'object', _apiKey: 12_345 }))
    const serialized = JSON.stringify(result)

    expect(serialized).not.toContain('_apiKey')
    expect(serialized).toMatch(/<redacted-secret-key-\d+ chars=7>/)
    expect(serialized).toMatch(/<redacted-secret-\d+ chars=5>/)
    expect(result.counts).toMatchObject({ secrets: 1 })
  })

  it('escapes placeholder-shaped retained metadata before counting it', () => {
    const slice = requestHeaderSlice({ type: 'object' })
    const sourceEvent = slice.sessions[0]!.events[0] as unknown as {
      data: { header: { config: { provider: string } } }
    }
    const reserved = '<redacted-text-001 chars=5>'
    sourceEvent.data.header.config.provider = reserved

    const result = redactSlice(slice)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(reserved)
    expect(result.counts.textValues).toBeGreaterThanOrEqual(1)
  })

  it('redacts display-control characters consistently in events and the target', () => {
    const slice = requestHeaderSlice({ type: 'object' })
    const unsafeType = 'plugin\u001B[31m/error'
    const sourceEvent = slice.sessions[0]!.events[0] as unknown as { type: string }
    const target = slice.target as { eventType: string }
    sourceEvent.type = unsafeType
    target.eventType = unsafeType

    const result = redactSlice(slice)
    expect(result.target.eventType).toMatch(/^<redacted-text-\d+ chars=\d+>$/)
    expect(result.sessions[0]!.events[0]!.type).toBe(result.target.eventType)
    expect(JSON.stringify(result)).not.toContain('\u001B')
  })
})
