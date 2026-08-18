#!/usr/bin/env node

import { constants } from 'node:fs'
import { access, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildBundle } from './bundle.js'
import { ReproError, type ReproErrorCode } from './errors.js'
import { inspectExport } from './inspect.js'
import { loadExport } from './input.js'
import { redactSlice } from './redact.js'
import { sliceExport } from './slice.js'
import { triageExport } from './triage.js'
import type { FailureEvidence, InspectResult, SliceTarget, TriageResult, VerifyResult } from './types.js'
import { canonicalStringify, formatBytes } from './utils.js'
import { verifyBundle } from './verify.js'
import { TOOL_VERSION } from './version.js'

interface CliIo {
  readonly stdout: (message: string) => void
  readonly stderr: (message: string) => void
}

interface CommonOptions {
  readonly positional: readonly string[]
  readonly json: boolean
  readonly help: boolean
  readonly values: ReadonlyMap<string, string>
  readonly flags: ReadonlySet<string>
}

const HELP = `dsh-repro ${TOOL_VERSION}

Create deterministic, privacy-aware DeepSeek Harness reproduction bundles.

Usage:
  dsh-repro inspect <export.zip|session.jsonl> [--json]
  dsh-repro triage <export.zip|session.jsonl> [--json]
  dsh-repro slice <input> --last-error [-o <bundle.repro.zip>] [--force] [--json]
  dsh-repro slice <input> --seq <n> [--session <id>] [-o <path>] [--force] [--json]
  dsh-repro slice <input> --tool-call <id> [--session <id>] [-o <path>] [--force] [--json]
  dsh-repro verify <bundle.repro.zip> [--json]

Options:
  -o, --output <path>  Output path for slice
      --session <id>   Disambiguate a seq or tool-call target
      --force          Replace an existing output file
      --json           Print machine-readable output
  -h, --help           Show help
  -v, --version        Show version
`

const DEFAULT_IO: CliIo = {
  stdout: message => process.stdout.write(message),
  stderr: message => process.stderr.write(message),
}

/** Run the CLI and return its stable process exit code. */
export async function runCli(argv: readonly string[], io: CliIo = DEFAULT_IO): Promise<number> {
  const wantsJson = argv.includes('--json')
  try {
    if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
      io.stdout(HELP)
      return 0
    }
    if (argv.includes('-v') || argv.includes('--version')) {
      io.stdout(`${TOOL_VERSION}\n`)
      return 0
    }
    const command = argv[0]
    const args = argv.slice(1)
    if (command === 'inspect') return await runInspect(parseOptions(args, []), io)
    if (command === 'triage') return await runTriage(parseOptions(args, []), io)
    if (command === 'slice') return await runSlice(parseOptions(args, ['output', 'session', 'seq', 'tool-call']), io)
    if (command === 'verify') return await runVerify(parseOptions(args, []), io)
    throw new ReproError('USAGE', `unknown command: ${JSON.stringify(command)}`)
  } catch (error) {
    const failure = error instanceof ReproError
      ? error
      : new ReproError('INVALID_SESSION', error instanceof Error ? error.message : String(error), {}, { cause: error })
    if (wantsJson) {
      io.stderr(`${canonicalStringify({ ok: false, error: { code: failure.code, message: failure.message, details: failure.details } })}\n`)
    } else {
      io.stderr(`dsh-repro: ${failure.code}: ${failure.message}\n`)
    }
    return exitCode(failure.code)
  }
}

async function runTriage(options: CommonOptions, io: CliIo): Promise<number> {
  assertOnly(options, new Set())
  const input = onePositional(options, 'triage')
  const result = triageExport(await loadExport(input))
  io.stdout(options.json ? `${canonicalStringify({ ok: true, result })}\n` : renderTriage(result))
  return 0
}

async function runInspect(options: CommonOptions, io: CliIo): Promise<number> {
  assertOnly(options, new Set())
  const input = onePositional(options, 'inspect')
  const result = inspectExport(await loadExport(input))
  io.stdout(options.json ? `${canonicalStringify({ ok: true, result })}\n` : renderInspection(result))
  return 0
}

async function runSlice(options: CommonOptions, io: CliIo): Promise<number> {
  assertOnly(options, new Set(['output', 'session', 'seq', 'tool-call', 'last-error', 'force']))
  const input = onePositional(options, 'slice')
  const target = targetFrom(options)
  const output = resolve(options.values.get('output') ?? defaultOutputPath(input))
  if (resolve(input) === output) throw new ReproError('USAGE', 'output path must differ from the source input')
  const force = options.flags.has('force')
  if (!force && await exists(output)) throw new ReproError('OUTPUT_EXISTS', `output already exists: ${output}`, { output })

  const source = await loadExport(input)
  const sliced = sliceExport(source, target)
  const artifact = buildBundle(redactSlice(sliced))
  try {
    await writeFile(output, artifact.bytes, { flag: force ? 'w' : 'wx' })
  } catch (error) {
    if (isAlreadyExists(error)) throw new ReproError('OUTPUT_EXISTS', `output already exists: ${output}`, { output })
    throw error
  }
  const result = {
    output,
    bytes: artifact.bytes.byteLength,
    target: artifact.manifest.selection,
    sessions: artifact.manifest.sessions.length,
    omittedAttachments: artifact.manifest.omittedAttachments.length,
  }
  if (options.json) io.stdout(`${canonicalStringify({ ok: true, result })}\n`)
  else {
    io.stdout(`Created ${output} (${formatBytes(artifact.bytes.byteLength)})\n`)
    io.stdout(`Target ${artifact.manifest.selection.sessionId}:${artifact.manifest.selection.originalSeq} ${artifact.manifest.selection.eventType}\n`)
    io.stdout(`Included ${artifact.manifest.sessions.length} session(s); omitted ${artifact.manifest.omittedAttachments.length} attachment(s).\n`)
  }
  return 0
}

async function runVerify(options: CommonOptions, io: CliIo): Promise<number> {
  assertOnly(options, new Set())
  const input = onePositional(options, 'verify')
  const result = await verifyBundle(input)
  io.stdout(options.json ? `${canonicalStringify({ ok: true, result })}\n` : renderVerification(result))
  return 0
}

function parseOptions(args: readonly string[], valueOptions: readonly string[]): CommonOptions {
  const values = new Map<string, string>()
  const flags = new Set<string>()
  const positional: string[] = []
  const expectsValue = new Set(valueOptions)
  let optionsEnabled = true
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string
    if (optionsEnabled && argument === '--') {
      optionsEnabled = false
      continue
    }
    if (!optionsEnabled || !argument.startsWith('-') || argument === '-') {
      positional.push(argument)
      continue
    }
    const raw = argument === '-o' ? 'output' : argument.replace(/^--/, '')
    if (raw === argument) throw new ReproError('USAGE', `unknown short option: ${argument}`)
    const equals = raw.indexOf('=')
    const name = equals < 0 ? raw : raw.slice(0, equals)
    const inlineValue = equals < 0 ? undefined : raw.slice(equals + 1)
    if (expectsValue.has(name)) {
      const value = inlineValue ?? args[index + 1]
      if (value === undefined || inlineValue === undefined && value.startsWith('-')) {
        throw new ReproError('USAGE', `option --${name} requires a value`)
      }
      if (values.has(name)) throw new ReproError('USAGE', `option --${name} may be specified only once`)
      values.set(name, value)
      if (inlineValue === undefined) index += 1
    } else {
      if (inlineValue !== undefined) throw new ReproError('USAGE', `option --${name} does not take a value`)
      if (flags.has(name)) throw new ReproError('USAGE', `option --${name} may be specified only once`)
      flags.add(name)
    }
  }
  return { positional, json: flags.has('json'), help: flags.has('help'), values, flags }
}

function assertOnly(options: CommonOptions, allowed: ReadonlySet<string>): void {
  const common = new Set(['json'])
  for (const name of [...options.values.keys(), ...options.flags]) {
    if (!allowed.has(name) && !common.has(name)) throw new ReproError('USAGE', `unknown option: --${name}`)
  }
}

function onePositional(options: CommonOptions, command: string): string {
  if (options.positional.length !== 1) {
    throw new ReproError('USAGE', `${command} requires exactly one input path`)
  }
  return options.positional[0] as string
}

function targetFrom(options: CommonOptions): SliceTarget {
  const selectors = [
    options.flags.has('last-error') ? 'last-error' : undefined,
    options.values.has('seq') ? 'seq' : undefined,
    options.values.has('tool-call') ? 'tool-call' : undefined,
  ].filter((value): value is 'last-error' | 'seq' | 'tool-call' => value !== undefined)
  if (selectors.length !== 1) throw new ReproError('USAGE', 'slice requires exactly one target selector')
  const sessionId = options.values.get('session')
  if (selectors[0] === 'last-error') {
    if (sessionId !== undefined) throw new ReproError('USAGE', '--session cannot be used with --last-error')
    return { kind: 'last-error' }
  }
  if (selectors[0] === 'seq') {
    const raw = options.values.get('seq') as string
    if (!/^(?:0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      throw new ReproError('USAGE', '--seq must be a non-negative safe integer')
    }
    return { kind: 'seq', seq: Number(raw), ...(sessionId === undefined ? {} : { sessionId }) }
  }
  const callId = options.values.get('tool-call') as string
  if (callId.length === 0) throw new ReproError('USAGE', '--tool-call must be non-empty')
  return { kind: 'tool-call', callId, ...(sessionId === undefined ? {} : { sessionId }) }
}

function defaultOutputPath(input: string): string {
  const extension = extname(input)
  const stem = basename(input, extension)
  return join(dirname(resolve(input)), `${stem}.repro.zip`)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

function renderInspection(result: InspectResult): string {
  const lines = [
    `Input: ${result.kind}, ${formatBytes(result.sourceBytes)}`,
    `SHA-256: ${result.sourceSha256}`,
    `Sessions: ${result.sessions.length}; attachments omitted by default: ${result.omittedAttachments}`,
  ]
  for (const session of result.sessions) {
    const sessionId = displaySessionId(session.id)
    const parent = session.parentSession === undefined ? '' : `, parent ${displaySessionId(session.parentSession)}`
    lines.push(
      `- ${sessionId}: ${session.eventCount} event(s), ${session.errorCount} error(s), depth ${session.delegationDepth}${parent}`,
    )
  }
  return `${lines.join('\n')}\n`
}

function renderVerification(result: VerifyResult): string {
  return `Verified dsh-repro v${result.manifest.version}: ${result.verifiedFiles} payload(s), ${result.verifiedSessions} session(s); authenticity not verified.\n`
}

function renderTriage(result: TriageResult): string {
  const lines = [
    `Failure incidents: ${result.incidentCount} across ${result.source.sessionCount} session(s).`,
  ]
  for (const [index, incident] of result.incidents.entries()) {
    const primary = incident.primaryEvidence
    lines.push(`${index + 1}. ${incident.fingerprint}`)
    lines.push(
      `   Primary: ${displaySessionId(incident.sessionId)}:${primary.seq} ${primary.eventType}; evidence: ${incident.evidence.length}`,
    )
    const facts = renderFailureFacts(primary)
    if (facts.length > 0) lines.push(`   Facts: ${facts.join(', ')}`)
    lines.push(`   Selector: ${renderSelector(incident.selector.seq, incident.selector.sessionId)}`)
  }
  return `${lines.join('\n')}\n`
}

function renderFailureFacts(evidence: FailureEvidence): string[] {
  const facts: string[] = []
  if (evidence.provider !== undefined || evidence.model !== undefined) {
    facts.push(`route=${JSON.stringify(evidence.provider ?? '?')}/${JSON.stringify(evidence.model ?? '?')}`)
  }
  if (evidence.toolName !== undefined) facts.push(`tool=${JSON.stringify(evidence.toolName)}`)
  if (evidence.errorName !== undefined) facts.push(`error=${JSON.stringify(evidence.errorName)}`)
  if (evidence.errorCode !== undefined) facts.push(`code=${JSON.stringify(evidence.errorCode)}`)
  if (evidence.errorStatus !== undefined) facts.push(`status=${evidence.errorStatus}`)
  if (evidence.outcome !== undefined) facts.push(`outcome=${JSON.stringify(evidence.outcome)}`)
  return facts
}

function displaySessionId(sessionId: string): string {
  return isSafeCliToken(sessionId) ? sessionId : '<session-id available with --json>'
}

function renderSelector(seq: number, sessionId: string): string {
  return isSafeCliToken(sessionId)
    ? `--seq ${seq} --session ${sessionId}`
    : `--seq ${seq}; exact session id available with --json`
}

function isSafeCliToken(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:@/+=-]*$/.test(value)
}

function exitCode(code: ReproErrorCode): number {
  if (code === 'USAGE') return 2
  if (code === 'TARGET_NOT_FOUND') return 4
  if (code === 'INVALID_BUNDLE' || code === 'INTEGRITY_MISMATCH') return 5
  return 3
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  process.exitCode = await runCli(process.argv.slice(2))
}
