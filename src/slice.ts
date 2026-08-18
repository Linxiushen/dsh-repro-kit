import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { ReproError } from './errors.js'
import type {
  LoadedExport,
  ParsedSession,
  SessionHeaderRecord,
  SliceResult,
  SliceTarget,
  SlicedSession,
} from './types.js'

interface EventRef {
  readonly session: ParsedSession
  readonly event: SessionEvent
}

interface Scope {
  readonly turn: number
  readonly step?: number
  readonly startSeq: number
  endSeq?: number
}

interface SessionIndex {
  readonly session: ParsedSession
  readonly events: readonly SessionEvent[]
  readonly bySeq: ReadonlyMap<number, SessionEvent>
  readonly turnBySeq: ReadonlyMap<number, Scope>
  readonly stepBySeq: ReadonlyMap<number, Scope>
  readonly turnScopes: ReadonlyMap<number, readonly Scope[]>
  readonly stepScopes: ReadonlyMap<string, readonly Scope[]>
  readonly requestHeaders: readonly SessionEvent[]
  readonly requestContexts: readonly SessionEvent[]
  readonly toolEvents: ReadonlyMap<string, readonly SessionEvent[]>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function eventData(event: SessionEvent): Record<string, unknown> | undefined {
  return isRecord(event.data) ? event.data : undefined
}

function numberField(event: SessionEvent, key: 'turn' | 'step'): number | undefined {
  const value = eventData(event)?.[key]
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareSessionRefs(left: EventRef, right: EventRef): number {
  return left.event.time - right.event.time
    || compareStrings(left.session.sourcePath, right.session.sourcePath)
    || compareStrings(left.session.header.id, right.session.header.id)
    || compareStrings(left.session.sourceSha256, right.session.sourceSha256)
    || left.event.seq - right.event.seq
    || compareStrings(left.event.type, right.event.type)
}

function isErrorEvent(event: SessionEvent): boolean {
  const data = eventData(event)
  const type: string = event.type
  if (event.type === 'turn/end') {
    return isRecord(data?.['reason']) && data['reason']['kind'] === 'error'
  }
  if (event.type === 'tool/result') {
    if (data?.['error'] !== undefined) return true
    const message = data?.['message']
    return isRecord(message)
      && Array.isArray(message['content'])
      && message['content'].some(block => (
        isRecord(block) && block['type'] === 'tool-result' && block['isError'] === true
      ))
  }
  if (type === 'command/done') return data?.['kind'] === 'error'
  if (type === 'compaction/end') return data?.['error'] !== undefined
  if (type === 'tool/code-dispatch') return data?.['isError'] === true
  if (type === 'tool-workflow/agent-end') return data?.['outcome'] === 'failed'
  if (type === 'tool-workflow/run-end') return data?.['stopReason'] === 'error'
  if (type.endsWith('/error')) return true
  if (event.type !== 'assistant/chunk') return false

  const chunk = data?.['chunk']
  if (!isRecord(chunk)) return false
  if (chunk['type'] === 'error') return true
  return isRecord(chunk['reason']) && chunk['reason']['kind'] === 'error'
}

function assistantToolCallIds(event: SessionEvent): string[] {
  if (event.type !== 'assistant/message') return []
  const message = eventData(event)?.['message']
  if (!isRecord(message) || !Array.isArray(message['content'])) return []
  const ids: string[] = []
  for (const block of message['content']) {
    if (!isRecord(block) || block['type'] !== 'tool-call') continue
    const id = stringField(block['id'])
    if (id !== undefined) ids.push(id)
  }
  return ids
}

function resultCallIds(event: SessionEvent): string[] {
  if (event.type !== 'tool/result') return []
  const data = eventData(event)
  const ids = new Set<string>()
  const direct = stringField(data?.['callId'])
  if (direct !== undefined) ids.add(direct)

  const message = data?.['message']
  if (!isRecord(message)) return [...ids]
  const source = message['source']
  if (isRecord(source)) {
    const sourceCallId = stringField(source['callId'])
    if (sourceCallId !== undefined) ids.add(sourceCallId)
  }
  if (Array.isArray(message['content'])) {
    for (const block of message['content']) {
      if (!isRecord(block) || block['type'] !== 'tool-result') continue
      const toolCallId = stringField(block['toolCallId'])
      if (toolCallId !== undefined) ids.add(toolCallId)
    }
  }
  return [...ids]
}

function eventCallIds(event: SessionEvent): string[] {
  if (event.type === 'tool/call') {
    const callId = stringField(eventData(event)?.['callId'])
    return callId === undefined ? [] : [callId]
  }
  if (event.type === 'tool/result') return resultCallIds(event)
  return assistantToolCallIds(event)
}

function candidateDetails(candidates: readonly EventRef[]): readonly Record<string, unknown>[] {
  return [...candidates]
    .sort((left, right) => (
      compareStrings(left.session.sourcePath, right.session.sourcePath)
      || left.event.seq - right.event.seq
      || compareStrings(left.session.header.id, right.session.header.id)
    ))
    .map(({ session, event }) => ({
      sessionId: session.header.id,
      sourcePath: session.sourcePath,
      seq: event.seq,
      eventType: event.type,
    }))
}

function targetFailure(target: SliceTarget, candidates: readonly EventRef[]): never {
  const ambiguous = candidates.length > 1
  throw new ReproError(
    'TARGET_NOT_FOUND',
    ambiguous
      ? `slice target is ambiguous: ${candidates.length} events match`
      : 'slice target was not found in the loaded export',
    {
      reason: ambiguous ? 'ambiguous' : 'not-found',
      target,
      matchCount: candidates.length,
      candidates: candidateDetails(candidates),
    },
  )
}

function resolveTarget(source: LoadedExport, target: SliceTarget): EventRef {
  if (target.kind === 'last-error') {
    const errors: EventRef[] = []
    for (const session of source.sessions) {
      let latest: SessionEvent | undefined
      for (const event of session.events) {
        if (isErrorEvent(event) && (latest === undefined || event.seq > latest.seq)) latest = event
      }
      if (latest !== undefined) errors.push({ session, event: latest })
    }
    if (errors.length === 0) return targetFailure(target, errors)
    // Seq is authoritative inside one session. Separate sessions have no
    // causal total order, so epoch time is the best available cross-session
    // signal; stable storage identity makes equal timestamps deterministic.
    errors.sort(compareSessionRefs)
    return errors[errors.length - 1] as EventRef
  }

  const sessions = target.sessionId === undefined
    ? source.sessions
    : source.sessions.filter(session => session.header.id === target.sessionId)
  let candidates: EventRef[] = []
  if (target.kind === 'seq') {
    for (const session of sessions) {
      for (const event of session.events) {
        if (event.seq === target.seq) candidates.push({ session, event })
      }
    }
  } else {
    for (const session of sessions) {
      for (const event of session.events) {
        if (event.type === 'tool/call' && stringField(eventData(event)?.['callId']) === target.callId) {
          candidates.push({ session, event })
        }
      }
    }
    // Older imports may retain the model-visible call without a dedicated tool/call record.
    if (candidates.length === 0) {
      for (const session of sessions) {
        for (const event of session.events) {
          if (assistantToolCallIds(event).includes(target.callId)) candidates.push({ session, event })
        }
      }
    }
  }

  if (candidates.length !== 1) return targetFailure(target, candidates)
  return candidates[0] as EventRef
}

function pushScope(map: Map<number, Scope[]>, key: number, scope: Scope): void {
  const scopes = map.get(key)
  if (scopes === undefined) map.set(key, [scope])
  else scopes.push(scope)
}

function pushStepScope(map: Map<string, Scope[]>, scope: Scope): void {
  const key = `${scope.turn}:${String(scope.step)}`
  const scopes = map.get(key)
  if (scopes === undefined) map.set(key, [scope])
  else scopes.push(scope)
}

function buildSessionIndex(session: ParsedSession): SessionIndex {
  const events = [...session.events].sort((left, right) => left.seq - right.seq)
  const bySeq = new Map(events.map(event => [event.seq, event]))
  const turnBySeq = new Map<number, Scope>()
  const stepBySeq = new Map<number, Scope>()
  const mutableTurnScopes = new Map<number, Scope[]>()
  const mutableStepScopes = new Map<string, Scope[]>()
  const requestHeaders: SessionEvent[] = []
  const requestContexts: SessionEvent[] = []
  const mutableToolEvents = new Map<string, SessionEvent[]>()
  let currentTurn: Scope | undefined
  let currentStep: Scope | undefined

  for (const event of events) {
    if (event.type === 'turn/start') {
      const turn = numberField(event, 'turn')
      if (turn !== undefined) {
        currentTurn = { turn, startSeq: event.seq }
        pushScope(mutableTurnScopes, turn, currentTurn)
      }
    }
    if (event.type === 'step/start') {
      const turn = numberField(event, 'turn')
      const step = numberField(event, 'step')
      if (turn !== undefined && step !== undefined) {
        currentStep = { turn, step, startSeq: event.seq }
        pushStepScope(mutableStepScopes, currentStep)
      }
    }

    if (currentTurn !== undefined) turnBySeq.set(event.seq, currentTurn)
    if (currentStep !== undefined) stepBySeq.set(event.seq, currentStep)

    if (event.type === 'request/header') requestHeaders.push(event)
    if (event.type === 'request/context') requestContexts.push(event)
    if (event.type === 'assistant/message' || event.type === 'tool/call' || event.type === 'tool/result') {
      for (const callId of eventCallIds(event)) {
        const paired = mutableToolEvents.get(callId)
        if (paired === undefined) mutableToolEvents.set(callId, [event])
        else paired.push(event)
      }
    }

    if (event.type === 'step/end' && currentStep !== undefined) {
      const turn = numberField(event, 'turn')
      const step = numberField(event, 'step')
      if (turn === currentStep.turn && step === currentStep.step) {
        currentStep.endSeq = event.seq
        currentStep = undefined
      }
    }
    if (event.type === 'turn/end' && currentTurn !== undefined) {
      const turn = numberField(event, 'turn')
      if (turn === currentTurn.turn) {
        currentTurn.endSeq = event.seq
        currentTurn = undefined
        currentStep = undefined
      }
    }
  }

  return {
    session,
    events,
    bySeq,
    turnBySeq,
    stepBySeq,
    turnScopes: mutableTurnScopes,
    stepScopes: mutableStepScopes,
    requestHeaders,
    requestContexts,
    toolEvents: mutableToolEvents,
  }
}

function scopeContains(scope: Scope, seq: number, maximumSeq: number): boolean {
  return scope.startSeq <= seq && seq <= (scope.endSeq ?? maximumSeq)
}

function scopeFor(index: SessionIndex, event: SessionEvent, kind: 'turn' | 'step'): Scope | undefined {
  const direct = (kind === 'turn' ? index.turnBySeq : index.stepBySeq).get(event.seq)
  const turn = numberField(event, 'turn')
  const step = kind === 'step' ? numberField(event, 'step') : undefined
  if (direct !== undefined
    && (turn === undefined || direct.turn === turn)
    && (kind === 'turn' || step === undefined || direct.step === step)) return direct

  if (turn === undefined) return direct
  const scopes = kind === 'turn'
    ? index.turnScopes.get(turn)
    : step === undefined ? undefined : index.stepScopes.get(`${turn}:${step}`)
  if (scopes === undefined) return direct
  const maximumSeq = index.events.at(-1)?.seq ?? event.seq
  return [...scopes]
    .reverse()
    .find(scope => scopeContains(scope, event.seq, maximumSeq)) ?? direct
}

function referencedSeqs(event: SessionEvent): number[] {
  const references: number[] = []
  const add = (value: unknown): void => {
    if (Number.isSafeInteger(value) && (value as number) >= 0) references.push(value as number)
  }
  const value = (event as unknown as Record<string, unknown>)['sourceEventSeqs']
  if (Array.isArray(value)) value.forEach(add)

  const data = eventData(event)
  const type: string = event.type
  if (type === 'command/done' && data?.['kind'] === 'success') add(data['sourceEventSeq'])
  if (type === 'compaction/summary' || type === 'compaction/prune') {
    const shadowedSeqs = data?.['shadowedSeqs']
    if (Array.isArray(shadowedSeqs)) shadowedSeqs.forEach(add)
    const range = data?.['shadowedRange']
    if (isRecord(range)) {
      add(range['start'])
      add(range['end'])
    }
  }
  return references
}

function replaceBounds(event: SessionEvent): readonly [number, number] | undefined {
  const value = (event as unknown as Record<string, unknown>)['surfaceOp']
  if (!isRecord(value) || value['op'] !== 'replace') return undefined
  const start = value['start']
  const end = value['end']
  return Number.isSafeInteger(start) && Number.isSafeInteger(end)
    ? [start as number, end as number]
    : undefined
}

function latestAtOrBefore(events: readonly SessionEvent[], seq: number): SessionEvent | undefined {
  let low = 0
  let high = events.length - 1
  let match: SessionEvent | undefined
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const event = events[middle] as SessionEvent
    if (event.seq <= seq) {
      match = event
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return match
}

function requestAnchor(event: SessionEvent): boolean {
  return event.type === 'assistant/chunk'
    || event.type === 'assistant/message'
    || event.type === 'tool/call'
    || event.type === 'tool/result'
    || event.type.endsWith('/error')
}

function sameToolScope(left: SessionEvent, right: SessionEvent): boolean {
  const turn = numberField(left, 'turn')
  const step = numberField(left, 'step')
  if (turn === undefined || step === undefined) return true
  return numberField(right, 'turn') === turn && numberField(right, 'step') === step
}

function pairedToolEvents(index: SessionIndex, event: SessionEvent, callId: string): SessionEvent[] {
  const candidates = [...(index.toolEvents.get(callId) ?? [])]
    .filter(candidate => sameToolScope(event, candidate))
    .sort((left, right) => left.seq - right.seq)
  const structural = candidates.filter(candidate => candidate.type !== 'tool/result')
  if (event.type === 'tool/result') return structural

  const result = candidates.find(candidate => candidate.type === 'tool/result' && candidate.seq >= event.seq)
  return result === undefined ? structural : [...structural, result]
}

function selectedSeqs(index: SessionIndex, target: SessionEvent): Set<number> {
  const selected = new Set<number>()
  const queue: number[] = []
  const add = (seq: number): void => {
    if (selected.has(seq) || !index.bySeq.has(seq)) return
    selected.add(seq)
    queue.push(seq)
  }
  const addScopeBoundaries = (scope: Scope | undefined): void => {
    if (scope === undefined) return
    add(scope.startSeq)
    if (scope.endSeq !== undefined) add(scope.endSeq)
  }
  const drain = (): void => {
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const event = index.bySeq.get(queue[cursor] as number)
      if (event === undefined) continue
      for (const seq of referencedSeqs(event)) add(seq)
      const bounds = replaceBounds(event)
      if (bounds !== undefined) {
        add(bounds[0])
        add(bounds[1])
      }
      addScopeBoundaries(scopeFor(index, event, 'turn'))
      addScopeBoundaries(scopeFor(index, event, 'step'))
      for (const callId of eventCallIds(event)) {
        for (const pair of pairedToolEvents(index, event, callId)) add(pair.seq)
      }
    }
  }

  add(target.seq)
  const enclosingTurn = scopeFor(index, target, 'turn')
  if (enclosingTurn !== undefined) {
    const maximumSeq = index.events.at(-1)?.seq ?? target.seq
    const end = enclosingTurn.endSeq ?? maximumSeq
    for (const event of index.events) {
      if (event.seq >= enclosingTurn.startSeq && event.seq <= end) add(event.seq)
    }
  }
  drain()

  const anchors = new Map<string, SessionEvent>()
  for (const seq of selected) {
    const event = index.bySeq.get(seq)
    if (event === undefined || !requestAnchor(event)) continue
    const step = scopeFor(index, event, 'step')
    const key = step === undefined ? `event:${event.seq}` : `step:${step.startSeq}`
    const previous = anchors.get(key)
    if (previous === undefined || event.seq < previous.seq) anchors.set(key, event)
  }
  if (anchors.size === 0) anchors.set(`target:${target.seq}`, target)
  for (const anchor of anchors.values()) {
    const header = latestAtOrBefore(index.requestHeaders, anchor.seq)
    const context = latestAtOrBefore(index.requestContexts, anchor.seq)
    if (header !== undefined) add(header.seq)
    if (context !== undefined) add(context.seq)
  }
  drain()
  return selected
}

function remapDataSeqs(
  event: SessionEvent,
  seqMap: ReadonlyMap<number, number>,
): Record<string, unknown> | undefined {
  const data = eventData(event)
  if (data === undefined) return undefined
  const type: string = event.type

  if (type === 'command/done' && data['kind'] === 'success' && Object.hasOwn(data, 'sourceEventSeq')) {
    const output = { ...data }
    const source = data['sourceEventSeq']
    const mapped = Number.isSafeInteger(source) ? seqMap.get(source as number) : undefined
    if (mapped === undefined) delete output['sourceEventSeq']
    else output['sourceEventSeq'] = mapped
    return output
  }

  if (type !== 'compaction/summary' && type !== 'compaction/prune') return undefined
  const output = { ...data }
  if (Object.hasOwn(data, 'shadowedSeqs')) {
    const shadowedSeqs = data['shadowedSeqs']
    output['shadowedSeqs'] = Array.isArray(shadowedSeqs)
      ? shadowedSeqs.flatMap((seq) => {
        if (!Number.isSafeInteger(seq)) return []
        const mapped = seqMap.get(seq as number)
        return mapped === undefined ? [] : [mapped]
      })
      : []
  }
  if (Object.hasOwn(data, 'shadowedRange')) {
    const range = isRecord(data['shadowedRange']) ? data['shadowedRange'] : undefined
    const start = range !== undefined && Number.isSafeInteger(range['start'])
      ? seqMap.get(range['start'] as number)
      : undefined
    const end = range !== undefined && Number.isSafeInteger(range['end'])
      ? seqMap.get(range['end'] as number)
      : undefined
    if (start === undefined || end === undefined) delete output['shadowedRange']
    else output['shadowedRange'] = { ...range, start, end }
  }
  return output
}

function remapEvent(event: SessionEvent, seqMap: ReadonlyMap<number, number>): SessionEvent {
  const output: Record<string, unknown> = { ...event, seq: seqMap.get(event.seq) }
  const data = remapDataSeqs(event, seqMap)
  if (data !== undefined) output['data'] = data
  const rawSources = (event as unknown as Record<string, unknown>)['sourceEventSeqs']
  if (Array.isArray(rawSources)) {
    const sources = rawSources.flatMap((source) => {
      if (!Number.isSafeInteger(source)) return []
      const mapped = seqMap.get(source as number)
      return mapped === undefined ? [] : [mapped]
    })
    if (sources.length > 0 || event.type === 'assistant/message') output['sourceEventSeqs'] = sources
    else delete output['sourceEventSeqs']
  } else {
    delete output['sourceEventSeqs']
  }

  const rawSurfaceOp = (event as unknown as Record<string, unknown>)['surfaceOp']
  if (isRecord(rawSurfaceOp) && rawSurfaceOp['op'] === 'replace') {
    const start = Number.isSafeInteger(rawSurfaceOp['start'])
      ? seqMap.get(rawSurfaceOp['start'] as number)
      : undefined
    const end = Number.isSafeInteger(rawSurfaceOp['end'])
      ? seqMap.get(rawSurfaceOp['end'] as number)
      : undefined
    output['surfaceOp'] = start === undefined || end === undefined
      ? 'append'
      : { op: 'replace', start, end }
  }
  return output as unknown as SessionEvent
}

function remapHeader(header: SessionHeaderRecord, originalSeqs: readonly number[]): SessionHeaderRecord {
  const seedLength = header.seedLength
  if (seedLength === undefined) return { ...header }
  return {
    ...header,
    seedLength: originalSeqs.filter(seq => seq < seedLength).length,
  }
}

function lineageSessions(source: LoadedExport, selected: ParsedSession): ParsedSession[] {
  const byId = new Map<string, ParsedSession[]>()
  for (const session of source.sessions) {
    const matches = byId.get(session.header.id)
    if (matches === undefined) byId.set(session.header.id, [session])
    else matches.push(session)
  }

  const ancestors: ParsedSession[] = []
  const visited = new Set([selected.header.id])
  let parentId = selected.header.parentSession
  while (parentId !== undefined && !visited.has(parentId)) {
    const matches = byId.get(parentId)
    if (matches === undefined || matches.length === 0) break
    const parent = [...matches].sort((left, right) => compareStrings(left.sourcePath, right.sourcePath))[0]
    if (parent === undefined) break
    ancestors.push(parent)
    visited.add(parent.header.id)
    parentId = parent.header.parentSession
  }
  return ancestors.reverse()
}

function lineageSlice(session: ParsedSession): SlicedSession {
  return {
    sourcePath: session.sourcePath,
    header: remapHeader(session.header, []),
    events: [],
    originalSeqs: [],
    lineageOnly: true,
  }
}

/** Select a deterministic, causally closed reproduction slice from a loaded export. */
export function sliceExport(source: LoadedExport, target: SliceTarget): SliceResult {
  const resolved = resolveTarget(source, target)
  const index = buildSessionIndex(resolved.session)
  const selected = selectedSeqs(index, resolved.event)
  const originalSeqs = [...selected].sort((left, right) => left - right)
  const seqMap = new Map(originalSeqs.map((seq, index) => [seq, index]))
  const events = originalSeqs.map((seq) => remapEvent(index.bySeq.get(seq) as SessionEvent, seqMap))
  const sliced: SlicedSession = {
    sourcePath: resolved.session.sourcePath,
    header: remapHeader(resolved.session.header, originalSeqs),
    events,
    originalSeqs,
    lineageOnly: false,
  }

  return {
    source,
    requestedTarget: target,
    target: {
      kind: target.kind,
      sessionId: resolved.session.header.id,
      originalSeq: resolved.event.seq,
      eventType: resolved.event.type,
    },
    sessions: [...lineageSessions(source, resolved.session).map(lineageSlice), sliced],
  }
}
