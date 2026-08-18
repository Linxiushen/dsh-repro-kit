import type { SessionEvent } from '@deepseek-ai/dsh-session'

export const BUNDLE_FORMAT_VERSION = 1 as const
export const SUPPORTED_SESSION_FORMAT_VERSION = 0 as const

export type InputKind = 'jsonl' | 'zip'

export interface SessionHeaderRecord {
  readonly type: 'session'
  readonly version: number
  readonly id: string
  readonly createdAt: number
  readonly cwd?: string
  readonly parentSession?: string
  readonly seedLength?: number
  readonly origin?: 'subagent'
  readonly delegationDepth: number
  readonly agentPreset?: string
}

export interface ParsedSession {
  readonly sourcePath: string
  readonly header: SessionHeaderRecord
  readonly events: readonly SessionEvent[]
  readonly sourceSha256: string
  readonly sourceBytes: number
}

export interface OmittedAttachment {
  readonly sourcePath: string
  readonly size: number
  readonly compressedSize: number
  readonly reason: 'privacy-default'
}

export interface LoadedExport {
  readonly kind: InputKind
  readonly sourceSha256: string
  readonly sourceBytes: number
  readonly sessions: readonly ParsedSession[]
  readonly attachments: readonly OmittedAttachment[]
}

export interface InputLimits {
  readonly maxInputBytes: number
  readonly maxEntries: number
  readonly maxSessions: number
  readonly maxEntryBytes: number
  readonly maxTotalUncompressedBytes: number
  readonly maxJsonlLines: number
}

export const DEFAULT_INPUT_LIMITS: InputLimits = Object.freeze({
  maxInputBytes: 64 * 1024 * 1024,
  maxEntries: 256,
  maxSessions: 64,
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalUncompressedBytes: 128 * 1024 * 1024,
  maxJsonlLines: 500_000,
})

export type SliceTarget =
  | { readonly kind: 'last-error' }
  | { readonly kind: 'seq'; readonly seq: number; readonly sessionId?: string }
  | { readonly kind: 'tool-call'; readonly callId: string; readonly sessionId?: string }

export interface ResolvedTarget {
  readonly kind: SliceTarget['kind']
  readonly sessionId: string
  readonly originalSeq: number
  readonly eventType: string
}

export interface SlicedSession {
  readonly sourcePath: string
  readonly header: SessionHeaderRecord
  readonly events: readonly SessionEvent[]
  readonly originalSeqs: readonly number[]
  readonly lineageOnly: boolean
}

export interface SliceResult {
  readonly source: LoadedExport
  readonly requestedTarget: SliceTarget
  readonly target: ResolvedTarget
  readonly sessions: readonly SlicedSession[]
}

export interface RedactionCounts {
  readonly identifiers: number
  readonly textValues: number
  readonly secrets: number
  readonly paths: number
}

export interface RedactedAttachment {
  readonly id: string
  readonly bytes: number
  readonly reason: 'privacy-default'
}

export interface RedactedSourceSummary {
  readonly kind: InputKind
  readonly bytes: number
  readonly sessionCount: number
  readonly omittedAttachments: readonly RedactedAttachment[]
}

export interface RedactedSession {
  readonly header: SessionHeaderRecord
  readonly events: readonly SessionEvent[]
  readonly originalSeqs: readonly number[]
  readonly lineageOnly: boolean
}

export interface RedactedSlice {
  readonly source: RedactedSourceSummary
  readonly requestedTarget: { readonly kind: SliceTarget['kind'] }
  readonly target: ResolvedTarget
  readonly sessions: readonly RedactedSession[]
  readonly counts: RedactionCounts
}

export interface BundleFileRecord {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

export interface BundleSessionRecord {
  readonly id: string
  readonly parentSession?: string
  readonly file: string
  readonly eventCount: number
  readonly originalSeqs: readonly number[]
  readonly lineageOnly: boolean
}

export interface BundleManifest {
  readonly format: 'dsh-repro'
  readonly version: typeof BUNDLE_FORMAT_VERSION
  readonly tool: { readonly name: 'dsh-repro-kit'; readonly version: string }
  readonly source: {
    readonly kind: InputKind
    readonly bytes: number
    readonly sessionCount: number
    readonly omittedAttachmentCount: number
  }
  readonly selection: {
    readonly kind: SliceTarget['kind']
    readonly sessionId: string
    readonly originalSeq: number
    readonly outputSeq: number
    readonly eventType: string
    readonly policy: 'enclosing-turn+causal-sources+tool-pairs+lineage'
  }
  readonly redaction: {
    readonly profile: 'share-safe-v1'
    readonly counts: RedactionCounts
    readonly notice: string
  }
  readonly sessions: readonly BundleSessionRecord[]
  readonly omittedAttachments: readonly {
    readonly id: string
    readonly bytes: number
    readonly reason: 'privacy-default'
  }[]
  /** Hashes every payload file. The manifest is excluded to avoid a self-hash cycle. */
  readonly files: readonly BundleFileRecord[]
}

export interface BundleArtifact {
  readonly bytes: Uint8Array
  readonly manifest: BundleManifest
  readonly report: string
}

export interface InspectSession {
  readonly id: string
  readonly sourcePath: string
  readonly parentSession?: string
  readonly delegationDepth: number
  readonly eventCount: number
  readonly firstSeq?: number
  readonly lastSeq?: number
  readonly errorCount: number
}

export interface InspectResult {
  readonly kind: InputKind
  readonly sourceSha256: string
  readonly sourceBytes: number
  readonly sessions: readonly InspectSession[]
  readonly omittedAttachments: number
}

export const FAILURE_FINGERPRINT_VERSION = 1 as const

export type FailureKind =
  | 'assistant-stream'
  | 'code-dispatch'
  | 'command'
  | 'compaction'
  | 'event'
  | 'tool'
  | 'turn'
  | 'workflow-agent'
  | 'workflow-run'

/** Share-conscious structured facts from one durable failure event. */
export interface FailureEvidence {
  readonly seq: number
  readonly eventType: string
  readonly kind: FailureKind
  readonly turn?: number
  readonly step?: number
  readonly provider?: string
  readonly model?: string
  readonly toolName?: string
  readonly errorName?: string
  readonly errorCode?: string
  readonly errorStatus?: number
  readonly outcome?: string
}

/** Failure events deterministically correlated within one session. */
export interface FailureIncident {
  readonly fingerprint: `dsh-failure-v${typeof FAILURE_FINGERPRINT_VERSION}:${string}`
  readonly sessionId: string
  readonly selector: { readonly kind: 'seq'; readonly seq: number; readonly sessionId: string }
  readonly primaryEvidence: FailureEvidence
  readonly evidence: readonly FailureEvidence[]
  readonly relatedSeqs: readonly number[]
  readonly failedStepCount: number
}

/** Privacy-conscious failure inventory for an export. Message bodies and opaque payloads are excluded. */
export interface TriageResult {
  readonly version: typeof FAILURE_FINGERPRINT_VERSION
  readonly source: {
    readonly kind: InputKind
    readonly bytes: number
    readonly sessionCount: number
  }
  readonly incidentCount: number
  readonly incidents: readonly FailureIncident[]
}

export interface VerifyResult {
  readonly valid: true
  readonly authenticity: 'not-verified'
  readonly checks: {
    readonly payloadIntegrity: 'verified'
    readonly harnessStructure: 'verified'
    readonly redactionPolicy: 'verified'
    readonly canonicalReport: 'verified'
  }
  readonly manifest: BundleManifest
  readonly verifiedFiles: number
  readonly verifiedSessions: number
}
