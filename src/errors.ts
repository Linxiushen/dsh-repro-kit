/** Stable failure categories for API callers and CLI exit-code mapping. */
export type ReproErrorCode =
  | 'USAGE'
  | 'INPUT_NOT_FOUND'
  | 'INPUT_TOO_LARGE'
  | 'UNSUPPORTED_INPUT'
  | 'UNSAFE_ARCHIVE'
  | 'INVALID_JSON'
  | 'DUPLICATE_JSON_MEMBER'
  | 'INVALID_SESSION'
  | 'UNSUPPORTED_SESSION_VERSION'
  | 'TARGET_NOT_FOUND'
  | 'OUTPUT_EXISTS'
  | 'INVALID_BUNDLE'
  | 'INTEGRITY_MISMATCH'

/** An expected, user-actionable failure with a stable machine-readable code. */
export class ReproError extends Error {
  readonly code: ReproErrorCode
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    code: ReproErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ReproError'
    this.code = code
    this.details = details
  }
}

export function asReproError(error: unknown): ReproError {
  if (error instanceof ReproError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new ReproError('INVALID_SESSION', message, {}, { cause: error })
}
