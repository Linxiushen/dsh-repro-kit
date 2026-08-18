import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli } from '../src/cli.js'

const input = fileURLToPath(new URL('../examples/failing-session.jsonl', import.meta.url))
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function capture(): { io: { stdout: (value: string) => void; stderr: (value: string) => void }; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { io: { stdout: value => out.push(value), stderr: value => err.push(value) }, out, err }
}

describe('runCli command surface', () => {
  it('prints help and version', async () => {
    const help = capture()
    expect(await runCli([], help.io)).toBe(0)
    expect(help.out.join('')).toContain('Usage:')

    const version = capture()
    expect(await runCli(['--version'], version.io)).toBe(0)
    expect(version.out).toEqual(['0.1.0\n'])
  })

  it('inspects in human and JSON modes', async () => {
    const human = capture()
    expect(await runCli(['inspect', input], human.io)).toBe(0)
    expect(human.out.join('')).toContain('Sessions: 1')
    expect(human.out.join('')).toContain('2 error(s)')

    const json = capture()
    expect(await runCli(['inspect', input, '--json'], json.io)).toBe(0)
    expect(JSON.parse(json.out.join(''))).toMatchObject({ ok: true, result: { kind: 'jsonl' } })
  })

  it('triages correlated failures in human and JSON modes', async () => {
    const human = capture()
    expect(await runCli(['triage', input], human.io)).toBe(0)
    expect(human.out.join('')).toContain('Failure incidents: 1')
    expect(human.out.join('')).toContain('dsh-failure-v1:')
    expect(human.out.join('')).toContain('Selector: --seq 12')

    const json = capture()
    expect(await runCli(['triage', input, '--json'], json.io)).toBe(0)
    expect(JSON.parse(json.out.join(''))).toMatchObject({
      ok: true,
      result: {
        version: 1,
        incidentCount: 1,
        incidents: [{
          selector: { kind: 'seq', seq: 12, sessionId: 'demo-session-private-id' },
          primaryEvidence: { eventType: 'tool/result', errorCode: 'EACCES' },
        }],
      },
    })
  })

  it('does not render an unsafe session id as a shell selector', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-repro-cli-session-id-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'unsafe.jsonl')
    const sessionId = '$(Write-Output injected)'
    await writeFile(path, [
      JSON.stringify({
        type: 'session', version: 0, id: sessionId, createdAt: 0, delegationDepth: 0,
      }),
      JSON.stringify({
        type: 'turn/end', seq: 0, time: 1,
        data: { turn: 0, reason: { kind: 'error', error: { code: 'FAIL', message: 'private' } } },
      }),
      '',
    ].join('\n'))

    const human = capture()
    expect(await runCli(['triage', path], human.io)).toBe(0)
    expect(human.out.join('')).toContain('exact session id available with --json')
    expect(human.out.join('')).not.toContain(sessionId)

    const json = capture()
    expect(await runCli(['triage', path, '--json'], json.io)).toBe(0)
    expect(JSON.parse(json.out.join('')).result.incidents[0].selector.sessionId).toBe(sessionId)
  })

  it('supports seq and tool-call selectors and human verification', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-repro-cli-'))
    temporaryDirectories.push(directory)
    const seqBundle = join(directory, 'seq.zip')
    const seq = capture()
    expect(await runCli(['slice', input, '--seq', '12', '--output', seqBundle], seq.io)).toBe(0)
    expect(seq.out.join('')).toContain('Created')

    const verify = capture()
    expect(await runCli(['verify', seqBundle], verify.io)).toBe(0)
    expect(verify.out.join('')).toContain('Verified dsh-repro v1')
    expect(verify.out.join('')).toContain('authenticity not verified')

    const tool = capture()
    expect(await runCli([
      'slice', input, '--tool-call=call-private-1', '--output', join(directory, 'tool.zip'), '--json',
    ], tool.io)).toBe(0)
    expect(JSON.parse(tool.out.join(''))).toMatchObject({ ok: true, result: { target: { kind: 'tool-call' } } })
  })

  it('rejects overwrite, source replacement, and invalid selector combinations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-repro-cli-errors-'))
    temporaryDirectories.push(directory)
    const output = join(directory, 'exists.zip')
    expect(await runCli(['slice', input, '--last-error', '--output', output], capture().io)).toBe(0)

    const cases: readonly (readonly string[])[] = [
      ['unknown'],
      ['inspect'],
      ['inspect', input, '-x'],
      ['inspect', input, '--json=true'],
      ['slice', input],
      ['slice', input, '--last-error', '--seq', '1'],
      ['slice', input, '--last-error', '--session', 'root'],
      ['slice', input, '--seq', '-1'],
      ['slice', input, '--tool-call', ''],
      ['slice', input, '--last-error', '--output', input],
    ]
    for (const args of cases) {
      const result = capture()
      expect(await runCli(args, result.io), args.join(' ')).toBe(2)
      expect(result.err.join(''), args.join(' ')).toContain('USAGE')
    }

    const exists = capture()
    expect(await runCli(['slice', input, '--last-error', '--output', output], exists.io)).toBe(3)
    expect(exists.err.join('')).toContain('OUTPUT_EXISTS')
  })
})
