import { createRequire } from 'node:module'

const packageMetadata = createRequire(import.meta.url)('../package.json') as { readonly version: string }

export const TOOL_NAME = 'dsh-repro-kit' as const
export const TOOL_VERSION = packageMetadata.version
