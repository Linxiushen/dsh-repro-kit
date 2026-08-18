import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli } from '../src/cli.js'

const temporaryDirectories: string[] = []
const input = fileURLToPath(new URL('../examples/failing-session.jsonl', import.meta.url))

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function capture(): { io: { stdout: (value: string) => void; stderr: (value: string) => void }; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return {
    io: { stdout: value => out.push(value), stderr: value => err.push(value) },
    out,
    err,
  }
}

describe('CLI end to end', () => {
  it('creates a deterministic, verifiable, leak-reduced bundle', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-repro-e2e-'))
    temporaryDirectories.push(directory)
    const output = join(directory, 'failure.repro.zip')
    const firstRun = capture()
    expect(await runCli(['slice', input, '--last-error', '--output', output, '--json'], firstRun.io)).toBe(0)
    expect(firstRun.err).toEqual([])
    const firstBytes = await readFile(output)

    const secondRun = capture()
    expect(await runCli([
      'slice', input, '--last-error', '--output', output, '--force', '--json',
    ], secondRun.io)).toBe(0)
    expect(await readFile(output)).toEqual(firstBytes)

    const verification = capture()
    expect(await runCli(['verify', output, '--json'], verification.io)).toBe(0)
    expect(JSON.parse(verification.out.join(''))).toMatchObject({
      ok: true,
      result: { valid: true, verifiedSessions: 1 },
    })

    const files = unzipSync(firstBytes)
    const payload = Object.values(files).map(bytes => new TextDecoder().decode(bytes)).join('\n')
    for (const secret of [
      'alice@example.com',
      'private-project',
      'private-demo-token',
      'sk-demo-private',
      'demo-session-private-id',
      'call-private-1',
    ]) expect(payload).not.toContain(secret)
    expect(payload).toContain('deepseek-chat')
    expect(payload).toContain('EACCES')
  })

  it('maps asynchronous verification failures to stable JSON and exit code', async () => {
    const output = capture()
    expect(await runCli(['verify', input, '--json'], output.io)).toBe(5)
    expect(output.out).toEqual([])
    expect(JSON.parse(output.err.join(''))).toMatchObject({
      ok: false,
      error: { code: 'INVALID_BUNDLE' },
    })
    expect(output.err.join('')).not.toContain('at verifyBundle')
  })
})
