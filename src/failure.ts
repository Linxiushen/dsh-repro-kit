import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { FailureKind } from './types.js'
import { isRecord } from './utils.js'

type CorrelationKind = 'call' | 'command' | 'compaction' | 'dispatch' | 'turn' | 'workflow'

export interface FailureClassification {
  readonly kind: FailureKind
  readonly turn?: number
  readonly step?: number
  readonly correlation?: { readonly kind: CorrelationKind; readonly value: string }
  readonly toolName?: string
  readonly errorName?: string
  readonly errorCode?: string
  readonly errorStatus?: number
  readonly outcome?: string
}

interface ErrorFacts {
  readonly errorName?: string
  readonly errorCode?: string
  readonly errorStatus?: number
}

/** Recognize every formal failure shape supported by target selection and triage. */
export function classifyFailureEvent(event: SessionEvent): FailureClassification | undefined {
  const data = eventData(event)
  const type: string = event.type
  const turn = integerField(data, 'turn')
  const step = integerField(data, 'step')
  const scoped = {
    ...(turn === undefined ? {} : { turn }),
    ...(step === undefined ? {} : { step }),
  }

  if (event.type === 'turn/end') {
    const reason = recordField(data, 'reason')
    if (reason?.['kind'] !== 'error') return undefined
    return {
      kind: 'turn',
      ...scoped,
      ...(turn === undefined
        ? {}
        : { correlation: { kind: 'turn' as const, value: String(turn) } }),
      ...errorFacts(reason['error'], reason),
      outcome: 'error',
    }
  }

  if (event.type === 'tool/result') {
    const result = toolResultFailure(data)
    if (!result.failed) return undefined
    return {
      kind: 'tool',
      ...scoped,
      ...(result.callId === undefined
        ? {}
        : { correlation: { kind: 'call' as const, value: result.callId } }),
      ...errorFacts(data?.['error']),
      outcome: 'error',
    }
  }

  if (type === 'command/done') {
    if (data?.['kind'] !== 'error') return undefined
    const commandId = stringField(data['commandId'])
    return {
      kind: 'command',
      ...scoped,
      ...(commandId === undefined
        ? {}
        : { correlation: { kind: 'command' as const, value: commandId } }),
      ...errorFacts(data['error'], data),
      outcome: 'error',
    }
  }

  if (type === 'compaction/end') {
    if (data?.['error'] === undefined) return undefined
    const compactionId = stringField(data['compactionId'])
    return {
      kind: 'compaction',
      ...scoped,
      ...(compactionId === undefined
        ? {}
        : { correlation: { kind: 'compaction' as const, value: compactionId } }),
      ...errorFacts(data['error']),
      outcome: 'error',
    }
  }

  if (type === 'tool/code-dispatch') {
    if (data?.['isError'] !== true) return undefined
    const callId = stringField(data['rootCallId'])
      ?? stringField(data['parentCallId'])
      ?? stringField(data['subCallId'])
    const toolName = stringField(data['name'])
    return {
      kind: 'code-dispatch',
      ...scoped,
      ...(callId === undefined
        ? {}
        : { correlation: { kind: 'dispatch' as const, value: callId } }),
      ...(toolName === undefined ? {} : { toolName }),
      ...errorFacts(data['error'], data),
      outcome: 'error',
    }
  }

  if (type === 'tool-workflow/agent-end') {
    if (data?.['outcome'] !== 'failed') return undefined
    const runId = stringField(data['runId'])
    return {
      kind: 'workflow-agent',
      ...scoped,
      ...(runId === undefined
        ? {}
        : { correlation: { kind: 'workflow' as const, value: runId } }),
      ...errorFacts(data['error'], data),
      outcome: 'failed',
    }
  }

  if (type === 'tool-workflow/run-end') {
    if (data?.['stopReason'] !== 'error') return undefined
    const runId = stringField(data['runId'])
    return {
      kind: 'workflow-run',
      ...scoped,
      ...(runId === undefined
        ? {}
        : { correlation: { kind: 'workflow' as const, value: runId } }),
      ...errorFacts(data['error'], data),
      outcome: 'error',
    }
  }

  if (event.type === 'assistant/chunk') {
    const chunk = recordField(data, 'chunk')
    const reason = recordField(chunk, 'reason')
    if (chunk?.['type'] !== 'error' && reason?.['kind'] !== 'error') return undefined
    return {
      kind: 'assistant-stream',
      ...scoped,
      ...(turn === undefined
        ? {}
        : { correlation: { kind: 'turn' as const, value: String(turn) } }),
      ...errorFacts(chunk?.['failure'], chunk?.['error'], reason?.['failure'], reason?.['error'], chunk, reason),
      outcome: 'error',
    }
  }

  if (!type.endsWith('/error')) return undefined
  return {
    kind: 'event',
    ...scoped,
    ...(turn === undefined
      ? {}
      : { correlation: { kind: 'turn' as const, value: String(turn) } }),
    ...errorFacts(data?.['error'], data),
    outcome: 'error',
  }
}

export function isFailureEvent(event: SessionEvent): boolean {
  return classifyFailureEvent(event) !== undefined
}

function eventData(event: SessionEvent): Record<string, unknown> | undefined {
  return isRecord(event.data) ? event.data : undefined
}

function recordField(
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const field = value?.[key]
  return isRecord(field) ? field : undefined
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function integerField(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const field = value?.[key]
  return Number.isSafeInteger(field) && (field as number) >= 0 ? field as number : undefined
}

function toolResultFailure(data: Record<string, unknown> | undefined): {
  readonly failed: boolean
  readonly callId?: string
} {
  let failed = data?.['error'] !== undefined
  let callId = stringField(data?.['callId'])
  const message = recordField(data, 'message')
  const source = recordField(message, 'source')
  callId ??= stringField(source?.['callId'])
  const content = message?.['content']
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block) || block['type'] !== 'tool-result') continue
      if (block['isError'] === true) failed = true
      callId ??= stringField(block['toolCallId'])
    }
  }
  return { failed, ...(callId === undefined ? {} : { callId }) }
}

function errorFacts(...values: readonly unknown[]): ErrorFacts {
  const records: Record<string, unknown>[] = []
  for (const value of values) {
    if (!isRecord(value)) continue
    records.push(value)
    if (isRecord(value['error'])) records.push(value['error'])
    if (isRecord(value['failure'])) records.push(value['failure'])
  }

  let errorName: string | undefined
  let errorCode: string | undefined
  let errorStatus: number | undefined
  for (const record of records) {
    errorName ??= stringField(record['name'])
    const rawCode = record['code']
    if (errorCode === undefined && (typeof rawCode === 'string' || Number.isSafeInteger(rawCode))) {
      errorCode = String(rawCode)
    }
    const rawStatus = record['status'] ?? record['statusCode']
    if (errorStatus === undefined && Number.isSafeInteger(rawStatus) && (rawStatus as number) >= 0) {
      errorStatus = rawStatus as number
    }
  }
  return {
    ...(errorName === undefined ? {} : { errorName }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(errorStatus === undefined ? {} : { errorStatus }),
  }
}
