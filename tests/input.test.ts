import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Zip, ZipPassThrough, strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { loadExport } from '../src/input.js'
import { sha256Hex } from '../src/utils.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function sessionHeader(id = 'session-1', extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'session',
    version: 0,
    id,
    createdAt: 1_000,
    delegationDepth: 0,
    ...extra,
  })
}

function eventLine(seq: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'fixture/event',
    seq,
    time: 2_000 + seq,
    data: {},
    ...extra,
  })
}

function sessionLog(id = 'session-1', events: string[] = [eventLine(0)]): string {
  return [sessionHeader(id), ...events].join('\n') + '\n'
}

async function fixtureFile(name: string, content: string | Uint8Array): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-repro-input-'))
  temporaryDirectories.push(directory)
  const path = join(directory, name)
  await writeFile(path, content)
  return path
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function zipWithEntries(entries: ReadonlyArray<readonly [string, string | Uint8Array]>): Uint8Array {
  const chunks: Uint8Array[] = []
  let failure: Error | undefined
  let finished = false
  const archive = new Zip((error, chunk, final) => {
    if (error !== null) failure = error
    if (chunk.byteLength > 0) chunks.push(chunk.slice())
    if (final) finished = true
  })
  for (const [name, content] of entries) {
    const file = new ZipPassThrough(name)
    archive.add(file)
    file.push(typeof content === 'string' ? strToU8(content) : content, true)
  }
  archive.end()
  if (failure !== undefined) throw failure
  if (!finished) throw new Error('ZIP fixture did not finish synchronously')
  return concat(chunks)
}

describe('loadExport JSONL', () => {
  it('loads a strict session log and reports byte identities', async () => {
    const content = sessionLog()
    const path = await fixtureFile('session.jsonl', content)

    const loaded = await loadExport(path)

    expect(loaded.kind).toBe('jsonl')
    expect(loaded.sourceBytes).toBe(Buffer.byteLength(content))
    expect(loaded.sourceSha256).toBe(sha256Hex(content))
    expect(loaded.attachments).toEqual([])
    expect(loaded.sessions).toHaveLength(1)
    expect(loaded.sessions[0]?.header.id).toBe('session-1')
    expect(loaded.sessions[0]?.events.map(event => event.seq)).toEqual([0])
  })

  it('expands packed chunk storage rows through decodeStorageRecord', async () => {
    const packed = JSON.stringify({
      type: 'text-chunks',
      seq0: 0,
      time0: 5_000,
      data: { turn: 1, step: 1, index: 0, dt: [2, -1], texts: ['a', 'b', 'c'] },
    })
    const path = await fixtureFile('packed.jsonl', `${sessionHeader()}\n${packed}\n`)

    const loaded = await loadExport(path)

    expect(loaded.sessions[0]?.events.map(event => event.seq)).toEqual([0, 1, 2])
    expect(loaded.sessions[0]?.events.map(event => event.time)).toEqual([5_000, 5_002, 5_001])
    expect(loaded.sessions[0]?.events.map(event => event.type)).toEqual([
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
    ])
  })

  it('bounds packed-row expansion by the logical event budget', async () => {
    const packed = JSON.stringify({
      type: 'text-chunks',
      seq0: 0,
      time0: 5_000,
      data: { turn: 1, step: 1, index: 0, dt: [1, 1], texts: ['a', 'b', 'c'] },
    })
    const path = await fixtureFile('packed-limit.jsonl', `${sessionHeader()}\n${packed}\n`)

    await expect(loadExport(path, { maxJsonlLines: 3 })).rejects.toMatchObject({
      code: 'INPUT_TOO_LARGE',
      details: { line: 2, currentEvents: 0, recordEvents: 3, limit: 2 },
    })
  })

  it('rejects recursively duplicated JSON members after escape decoding', async () => {
    const duplicate = '{"type":"fixture/event","seq":0,"time":1,"data":{"a":1,"\\u0061":2}}'
    const path = await fixtureFile('duplicate.jsonl', `${sessionHeader()}\n${duplicate}\n`)

    await expect(loadExport(path)).rejects.toMatchObject({
      code: 'DUPLICATE_JSON_MEMBER',
      details: { line: 2, member: 'a' },
    })
  })

  it('rejects sequence gaps', async () => {
    const path = await fixtureFile('gap.jsonl', sessionLog('session-1', [eventLine(1)]))

    await expect(loadExport(path)).rejects.toMatchObject({
      code: 'INVALID_SESSION',
      details: { expectedSeq: 0, actualSeq: 1 },
    })
  })

  it('rejects sourceEventSeqs that do not cite earlier events', async () => {
    const path = await fixtureFile('future-source.jsonl', sessionLog('session-1', [
      eventLine(0),
      eventLine(1, { sourceEventSeqs: [0, 1] }),
    ]))

    await expect(loadExport(path)).rejects.toMatchObject({
      code: 'INVALID_SESSION',
      details: { seq: 1, sourceSeq: 1 },
    })
  })

  it('delegates surface and provenance validation to the official session fold', async () => {
    const missingSurfaceMarker = await fixtureFile('missing-surface.jsonl', sessionLog('session-1', [
      eventLine(0, {
        type: 'user/message',
        data: {
          id: 'message-1',
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
          source: { kind: 'user' },
        },
      }),
    ]))
    const duplicateSources = await fixtureFile('duplicate-sources.jsonl', sessionLog('session-2', [
      eventLine(0),
      eventLine(1, {
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'message-2',
            role: 'assistant',
            content: [{ type: 'text', text: 'hello' }],
            source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
          },
        },
        surfaceOp: 'append',
        sourceEventSeqs: [0, 0],
      }),
    ]))

    await expect(loadExport(missingSurfaceMarker)).rejects.toMatchObject({ code: 'INVALID_SESSION' })
    await expect(loadExport(duplicateSources)).rejects.toMatchObject({ code: 'INVALID_SESSION' })
  })

  it.each([
    ['negative zero', '-0'],
    ['an exponent overflow', '1e400'],
  ])('rejects %s in otherwise valid event data', async (_label, numberLiteral) => {
    const event = `{"type":"fixture/event","seq":0,"time":1,"data":{"value":${numberLiteral}}}`
    const path = await fixtureFile('lossy-number.jsonl', `${sessionHeader()}\n${event}\n`)

    await expect(loadExport(path)).rejects.toMatchObject({
      code: 'INVALID_SESSION',
      details: { expectedSeq: 0 },
    })
  })

  it.each(['/srv/project', 'C:\\workspace'])('accepts portable absolute cwd %j', async (cwd) => {
    const path = await fixtureFile('portable-cwd.jsonl', `${sessionHeader('session-1', { cwd })}\n`)

    const loaded = await loadExport(path)

    expect(loaded.sessions[0]?.header.cwd).toBe(cwd)
  })

  it('reports a foreign header version before applying current header shape checks', async () => {
    const path = await fixtureFile('future.jsonl', '{"type":"session","version":1}\n')

    await expect(loadExport(path)).rejects.toMatchObject({
      code: 'UNSUPPORTED_SESSION_VERSION',
      details: { version: 1, supported: 0 },
    })
  })

  it('rejects unknown and malformed header fields', async () => {
    const unknown = await fixtureFile(
      'unknown-header.jsonl',
      `${sessionHeader('session-1', { sandboxMode: 'host' })}\n`,
    )
    const missingDepth = await fixtureFile(
      'missing-depth.jsonl',
      '{"type":"session","version":0,"id":"session-1","createdAt":1}\n',
    )

    await expect(loadExport(unknown)).rejects.toMatchObject({ code: 'INVALID_SESSION' })
    await expect(loadExport(missingDepth)).rejects.toMatchObject({ code: 'INVALID_SESSION' })
  })

  it('rejects invalid UTF-8 before parsing JSON', async () => {
    const bytes = concat([strToU8(`${sessionHeader()}\n`), new Uint8Array([0xC3, 0x28, 0x0A])])
    const path = await fixtureFile('invalid-utf8.jsonl', bytes)

    await expect(loadExport(path)).rejects.toMatchObject({ code: 'INVALID_JSON' })
  })

  it('enforces input and JSONL line budgets', async () => {
    const content = sessionLog('session-1', [eventLine(0), eventLine(1)])
    const path = await fixtureFile('limited.jsonl', content)

    await expect(loadExport(path, { maxInputBytes: 8 })).rejects.toMatchObject({
      code: 'INPUT_TOO_LARGE',
    })
    await expect(loadExport(path, { maxJsonlLines: 2 })).rejects.toMatchObject({
      code: 'INPUT_TOO_LARGE',
    })
  })

  it('rejects non-file inputs with a stable category', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-repro-input-directory-'))
    temporaryDirectories.push(directory)

    await expect(loadExport(directory)).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
  })
})

describe('loadExport ZIP', () => {
  it('loads official root and descendant paths while omitting media bytes', async () => {
    const root = sessionLog('root')
    const child = sessionLog('child')
    const media = randomBytes(128)
    const archive = zipSync({
      'session.jsonl': strToU8(root),
      'subagents/child/session.jsonl': strToU8(child),
      'media/image-1.png': media,
      'forward-compatible.txt': strToU8('ignored'),
    })
    const path = await fixtureFile('official.zip', archive)

    const loaded = await loadExport(path)

    expect(loaded.kind).toBe('zip')
    expect(loaded.sessions.map(session => session.header.id)).toEqual(['root', 'child'])
    expect(loaded.sessions.map(session => session.sourcePath)).toEqual([
      'session.jsonl',
      'subagents/child/session.jsonl',
    ])
    expect(loaded.attachments).toEqual([
      expect.objectContaining({
        sourcePath: 'media/image-1.png',
        size: media.byteLength,
        reason: 'privacy-default',
      }),
    ])
  })

  it.each([
    '../session.jsonl',
    '/session.jsonl',
    'C:/session.jsonl',
    'C:session.jsonl',
    'subagents\\child\\session.jsonl',
    'subagents//session.jsonl',
    'subagents/./session.jsonl',
    'subagents/../session.jsonl',
    'media/bad\0name.png',
  ])('rejects unsafe archive path %j', async (entry) => {
    const path = await fixtureFile('zip-slip.zip', zipWithEntries([[entry, sessionLog()]]))

    await expect(loadExport(path)).rejects.toMatchObject({ code: 'UNSAFE_ARCHIVE' })
  })

  it('rejects duplicate central-directory entry names', async () => {
    const archive = zipWithEntries([
      ['session.jsonl', sessionLog('first')],
      ['session.jsonl', sessionLog('second')],
    ])
    const path = await fixtureFile('duplicate-entry.zip', archive)

    await expect(loadExport(path)).rejects.toMatchObject({
      code: 'UNSAFE_ARCHIVE',
      details: { path: 'session.jsonl' },
    })
  })

  it('rejects highly compressed entries from metadata before extraction', async () => {
    const inflated = strToU8('x'.repeat(128 * 1024))
    const archive = zipSync({ 'session.jsonl': [inflated, { level: 9 }] })
    expect(archive.byteLength).toBeLessThan(inflated.byteLength)
    const path = await fixtureFile('metadata-bomb.zip', archive)

    await expect(loadExport(path, { maxEntryBytes: 1_024 })).rejects.toMatchObject({
      code: 'INPUT_TOO_LARGE',
      details: { path: 'session.jsonl', size: inflated.byteLength, limit: 1_024 },
    })
  })

  it('enforces entry, total-uncompressed, and session metadata limits', async () => {
    const archive = zipSync({
      'session.jsonl': strToU8(sessionLog('root')),
      'subagents/a/session.jsonl': strToU8(sessionLog('a')),
      'ignored.bin': strToU8('ignored'),
    })
    const path = await fixtureFile('limits.zip', archive)

    await expect(loadExport(path, { maxEntries: 2 })).rejects.toMatchObject({
      code: 'INPUT_TOO_LARGE',
    })
    await expect(loadExport(path, { maxSessions: 1 })).rejects.toMatchObject({
      code: 'INPUT_TOO_LARGE',
    })
    await expect(loadExport(path, { maxTotalUncompressedBytes: 32 })).rejects.toMatchObject({
      code: 'INPUT_TOO_LARGE',
    })
  })

  it('rejects archives without sessions and duplicate session ids', async () => {
    const emptyPath = await fixtureFile(
      'no-session.zip',
      zipSync({ 'media/image.png': randomBytes(16) }),
    )
    const duplicatePath = await fixtureFile(
      'duplicate-session.zip',
      zipSync({
        'session.jsonl': strToU8(sessionLog('same')),
        'subagents/other/session.jsonl': strToU8(sessionLog('same')),
      }),
    )

    await expect(loadExport(emptyPath)).rejects.toMatchObject({ code: 'INVALID_SESSION' })
    await expect(loadExport(duplicatePath)).rejects.toMatchObject({
      code: 'INVALID_SESSION',
      details: { id: 'same' },
    })
  })
})
