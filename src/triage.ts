import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { classifyFailureEvent, type FailureClassification } from './failure.js'
import { hasUnsafeDisplayCharacter } from './redaction-policy.js'
import {
  FAILURE_FINGERPRINT_VERSION,
  type FailureEvidence,
  type FailureIncident,
  type LoadedExport,
  type ParsedSession,
  type TriageResult,
} from './types.js'
import { canonicalStringify, isRecord, sha256Hex } from './utils.js'

interface ToolCallFact {
  readonly seq: number
  readonly callId: string
  readonly name?: string
  readonly turn?: number
  readonly step?: number
  resultSeq?: number
}

interface ToolCallIndex {
  readonly ordered: readonly ToolCallFact[]
  readonly byCorrelation: ReadonlyMap<string, readonly ToolCallFact[]>
}

interface RequestContextFact {
  readonly provider?: string
  readonly model?: string
}

interface EvidenceFact {
  readonly event: SessionEvent
  readonly evidence: FailureEvidence
  readonly groupKey: string
}

interface IncidentFact {
  readonly incident: FailureIncident
  readonly latestTime: number
  readonly sourcePath: string
  readonly sourceSha256: string
}

const REDACTED_METADATA = '<redacted-metadata>'
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
const TOKEN = /\b(?:AKIA[0-9A-Z]{16}|(?:sk|gh[opusr]|github_pat|xox[baprs])[-_A-Za-z0-9]{8,})\b/i
const BEARER = /\bBearer\s+[^\s,;]+/i
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/

/** Correlate durable failure evidence without returning prompts, results, paths, or opaque payloads. */
export function triageExport(source: LoadedExport): TriageResult {
  const facts = source.sessions.flatMap(triageSession)
  facts.sort(compareIncidentsNewestFirst)
  const incidents = facts.map(fact => fact.incident)
  return {
    version: FAILURE_FINGERPRINT_VERSION,
    source: {
      kind: source.kind,
      bytes: source.sourceBytes,
      sessionCount: source.sessions.length,
    },
    incidentCount: incidents.length,
    incidents,
  }
}

function triageSession(session: ParsedSession): IncidentFact[] {
  const events = [...session.events].sort((left, right) => left.seq - right.seq)
  const calls = indexToolCalls(events)
  const workflowCalls = indexWorkflowCalls(events, calls)
  const facts: EvidenceFact[] = []
  let context: RequestContextFact = {}

  for (const event of events) {
    context = updateRequestContext(context, event)
    const classification = classifyFailureEvent(event)
    if (classification === undefined) continue
    const call = relatedCall(classification, event, calls, workflowCalls)
    const turn = classification.turn ?? call?.turn
    const step = classification.step ?? call?.step
    const toolName = diagnosticString(classification.toolName ?? call?.name)
    const provider = diagnosticString(context.provider)
    const model = diagnosticString(context.model)
    const errorName = diagnosticString(classification.errorName)
    const errorCode = diagnosticString(classification.errorCode)
    const outcome = diagnosticString(classification.outcome)
    const eventType = diagnosticString(event.type) ?? REDACTED_METADATA
    const evidence: FailureEvidence = {
      seq: event.seq,
      eventType,
      kind: classification.kind,
      ...(turn === undefined ? {} : { turn }),
      ...(step === undefined ? {} : { step }),
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      ...(toolName === undefined ? {} : { toolName }),
      ...(errorName === undefined ? {} : { errorName }),
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(classification.errorStatus === undefined ? {} : { errorStatus: classification.errorStatus }),
      ...(outcome === undefined ? {} : { outcome }),
    }
    facts.push({ event, evidence, groupKey: failureGroupKey(classification, event, turn) })
  }

  const grouped = new Map<string, EvidenceFact[]>()
  for (const fact of facts) {
    const group = grouped.get(fact.groupKey)
    if (group === undefined) grouped.set(fact.groupKey, [fact])
    else group.push(fact)
  }

  return [...grouped.values()].map(group => buildIncident(session, group))
}

function buildIncident(session: ParsedSession, group: readonly EvidenceFact[]): IncidentFact {
  const sorted = [...group].sort((left, right) => left.event.seq - right.event.seq)
  let primary = sorted[0] as EvidenceFact
  let latestTime = primary.event.time
  const failedSteps = new Set<string>()
  for (const fact of sorted) {
    if (comparePrimaryEvidence(fact, primary) < 0) primary = fact
    if (fact.event.time > latestTime) latestTime = fact.event.time
    if (fact.evidence.turn !== undefined && fact.evidence.step !== undefined) {
      failedSteps.add(`${fact.evidence.turn}:${fact.evidence.step}`)
    }
  }
  const evidence = sorted.map(fact => fact.evidence)
  const selector = { kind: 'seq' as const, seq: primary.event.seq, sessionId: session.header.id }
  const incident: FailureIncident = {
    fingerprint: fingerprint(evidence),
    sessionId: session.header.id,
    selector,
    primaryEvidence: primary.evidence,
    evidence,
    relatedSeqs: evidence.map(item => item.seq),
    failedStepCount: failedSteps.size,
  }
  return {
    incident,
    latestTime,
    sourcePath: session.sourcePath,
    sourceSha256: session.sourceSha256,
  }
}

function fingerprint(evidence: readonly FailureEvidence[]): FailureIncident['fingerprint'] {
  const signatures = evidence.map(item => ({
    eventType: item.eventType,
    kind: item.kind,
    ...(item.provider === undefined ? {} : { provider: item.provider }),
    ...(item.model === undefined ? {} : { model: item.model }),
    ...(item.toolName === undefined ? {} : { toolName: item.toolName }),
    ...(item.errorName === undefined ? {} : { errorName: item.errorName }),
    ...(item.errorCode === undefined ? {} : { errorCode: item.errorCode }),
    ...(item.errorStatus === undefined ? {} : { errorStatus: item.errorStatus }),
    ...(item.outcome === undefined ? {} : { outcome: item.outcome }),
  }))
  const unique = [...new Map(signatures.map(item => [canonicalStringify(item), item])).entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([, item]) => item)
  const digest = sha256Hex(canonicalStringify({ version: FAILURE_FINGERPRINT_VERSION, evidence: unique }))
  return `dsh-failure-v${FAILURE_FINGERPRINT_VERSION}:${digest}`
}

function comparePrimaryEvidence(left: EvidenceFact, right: EvidenceFact): number {
  return specificity(right.evidence.kind) - specificity(left.evidence.kind)
    || left.event.seq - right.event.seq
    || compareStrings(left.evidence.eventType, right.evidence.eventType)
}

function specificity(kind: FailureEvidence['kind']): number {
  if (kind === 'turn') return 0
  if (kind === 'assistant-stream') return 1
  if (kind === 'event' || kind === 'workflow-run') return 2
  if (kind === 'workflow-agent') return 3
  return 4
}

function compareIncidentsNewestFirst(left: IncidentFact, right: IncidentFact): number {
  return compareNumbers(right.latestTime, left.latestTime)
    || compareStrings(left.sourcePath, right.sourcePath)
    || compareStrings(left.incident.sessionId, right.incident.sessionId)
    || compareStrings(left.sourceSha256, right.sourceSha256)
    || right.incident.primaryEvidence.seq - left.incident.primaryEvidence.seq
    || compareStrings(left.incident.fingerprint, right.incident.fingerprint)
}

function failureGroupKey(
  classification: FailureClassification,
  event: SessionEvent,
  effectiveTurn: number | undefined,
): string {
  if (effectiveTurn !== undefined) return `turn:${effectiveTurn}`
  if (classification.correlation !== undefined) {
    return `${classification.correlation.kind}:${classification.correlation.value}`
  }
  return `event:${event.seq}`
}

function indexToolCalls(events: readonly SessionEvent[]): ToolCallIndex {
  const calls: ToolCallFact[] = []
  const pending = new Map<string, ToolCallFact[]>()
  for (const event of events) {
    const data = eventData(event)
    if (event.type === 'tool/call') {
      const callId = stringField(data?.['callId'])
      if (callId === undefined) continue
      const name = stringField(data?.['name'])
      const turn = integerField(data, 'turn')
      const step = integerField(data, 'step')
      const call: ToolCallFact = {
        seq: event.seq,
        callId,
        ...(name === undefined ? {} : { name }),
        ...(turn === undefined ? {} : { turn }),
        ...(step === undefined ? {} : { step }),
      }
      calls.push(call)
      addCallCandidates(pending, call)
      continue
    }
    if (event.type !== 'tool/result') continue
    const callId = resultCallId(data)
    if (callId === undefined) continue
    const turn = integerField(data, 'turn')
    const step = integerField(data, 'step')
    const candidates = pending.get(callCorrelationKey(callId, turn, step))
    const candidate = latestPendingCall(candidates, event.seq)
    if (candidate !== undefined) candidate.resultSeq = event.seq
  }

  pending.clear()
  const byCorrelation = new Map<string, ToolCallFact[]>()
  for (const call of calls) addCallCandidates(byCorrelation, call)
  return { ordered: calls, byCorrelation }
}

function indexWorkflowCalls(
  events: readonly SessionEvent[],
  calls: ToolCallIndex,
): ReadonlyMap<string, ToolCallFact> {
  const result = new Map<string, ToolCallFact>()
  const active: ToolCallFact[] = []
  let callIndex = 0
  for (const event of events) {
    while (callIndex < calls.ordered.length) {
      const call = calls.ordered[callIndex] as ToolCallFact
      if (call.seq >= event.seq) break
      active.push(call)
      callIndex += 1
    }

    const type: string = event.type
    if (type !== 'tool-workflow/run-start') continue
    const runId = stringField(eventData(event)?.['runId'])
    if (runId === undefined || result.has(runId)) continue
    let call = active.at(-1)
    while (call !== undefined && call.resultSeq !== undefined && call.resultSeq <= event.seq) {
      active.pop()
      call = active.at(-1)
    }
    if (call !== undefined) result.set(runId, call)
  }
  return result
}

function relatedCall(
  classification: FailureClassification,
  event: SessionEvent,
  calls: ToolCallIndex,
  workflowCalls: ReadonlyMap<string, ToolCallFact>,
): ToolCallFact | undefined {
  const correlation = classification.correlation
  if (correlation?.kind === 'workflow') return workflowCalls.get(correlation.value)
  if (correlation?.kind !== 'call' && correlation?.kind !== 'dispatch') return undefined
  const candidates = calls.byCorrelation.get(callCorrelationKey(
    correlation.value,
    classification.turn,
    classification.step,
  ))
  return latestCallAtOrBefore(candidates, event.seq)
}

function addCallCandidates(index: Map<string, ToolCallFact[]>, call: ToolCallFact): void {
  pushCallCandidate(index, callCorrelationKey(call.callId, undefined, undefined), call)
  if (call.turn !== undefined) {
    pushCallCandidate(index, callCorrelationKey(call.callId, call.turn, undefined), call)
  }
  if (call.step !== undefined) {
    pushCallCandidate(index, callCorrelationKey(call.callId, undefined, call.step), call)
  }
  if (call.turn !== undefined && call.step !== undefined) {
    pushCallCandidate(index, callCorrelationKey(call.callId, call.turn, call.step), call)
  }
}

function pushCallCandidate(
  index: Map<string, ToolCallFact[]>,
  key: string,
  call: ToolCallFact,
): void {
  const candidates = index.get(key)
  if (candidates === undefined) index.set(key, [call])
  else candidates.push(call)
}

function callCorrelationKey(
  callId: string,
  turn: number | undefined,
  step: number | undefined,
): string {
  return JSON.stringify([callId, turn ?? null, step ?? null])
}

function latestPendingCall(
  candidates: ToolCallFact[] | undefined,
  beforeSeq: number,
): ToolCallFact | undefined {
  if (candidates === undefined) return undefined
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index] as ToolCallFact
    if (candidate.resultSeq !== undefined) {
      if (index === candidates.length - 1) candidates.pop()
      continue
    }
    if (candidate.seq < beforeSeq) return candidate
  }
  return undefined
}

function latestCallAtOrBefore(
  candidates: readonly ToolCallFact[] | undefined,
  seq: number,
): ToolCallFact | undefined {
  if (candidates === undefined) return undefined
  let low = 0
  let high = candidates.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if ((candidates[middle] as ToolCallFact).seq <= seq) low = middle + 1
    else high = middle
  }
  return candidates[low - 1]
}

function updateRequestContext(previous: RequestContextFact, event: SessionEvent): RequestContextFact {
  const data = eventData(event)
  if (event.type === 'request/context') {
    const provider = stringField(data?.['provider'])
    const model = stringField(data?.['model'])
    return {
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
    }
  }
  if (event.type !== 'request/header') return previous
  const header = data !== undefined && isRecord(data['header']) ? data['header'] : undefined
  const config = header !== undefined && isRecord(header['config']) ? header['config'] : undefined
  const provider = stringField(config?.['provider'])
  const model = stringField(config?.['model'])
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
  }
}

function resultCallId(data: Record<string, unknown> | undefined): string | undefined {
  const direct = stringField(data?.['callId'])
  if (direct !== undefined) return direct
  const message = data !== undefined && isRecord(data['message']) ? data['message'] : undefined
  const source = message !== undefined && isRecord(message['source']) ? message['source'] : undefined
  const fromSource = stringField(source?.['callId'])
  if (fromSource !== undefined) return fromSource
  const content = message?.['content']
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (!isRecord(block) || block['type'] !== 'tool-result') continue
    const callId = stringField(block['toolCallId'])
    if (callId !== undefined) return callId
  }
  return undefined
}

function diagnosticString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (value.length > 256 || hasUnsafeDisplayCharacter(value)
    || ABSOLUTE_PATH.test(value)
    || EMAIL.test(value) || TOKEN.test(value) || BEARER.test(value)
    || /^[a-z][a-z\d+.-]*:\/\//i.test(value)) return REDACTED_METADATA
  return value
}

function eventData(event: SessionEvent): Record<string, unknown> | undefined {
  return isRecord(event.data) ? event.data : undefined
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function integerField(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const field = value?.[key]
  return Number.isSafeInteger(field) && (field as number) >= 0 ? field as number : undefined
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareNumbers(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0
}
