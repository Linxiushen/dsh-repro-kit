# dsh-repro-kit

[![CI](https://github.com/Linxiushen/dsh-repro-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/Linxiushen/dsh-repro-kit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-repro-kit.svg)](https://www.npmjs.com/package/dsh-repro-kit)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Turn a DeepSeek Harness session export into a deterministic, causally sliced,
privacy-aware reproduction bundle that is practical to attach to a GitHub issue.

[简体中文](README.zh-CN.md)

## Why

The official DeepSeek Harness export is intentionally lossless: it can contain
the root session, every exported subagent descendant, and referenced media. That
is the right backup format, but usually too broad for a public bug report.

`dsh-repro-kit` keeps the debugging structure and removes most of the disclosure
surface:

- selects the last failure, an exact event sequence, or one tool call;
- retains the enclosing turn, causal `sourceEventSeqs`, tool call/result pairs,
  request state, and available parent lineage;
- replaces session, call, run, message, and attachment identifiers with stable
  bundle-local aliases;
- removes prompt, system, reasoning, tool arguments/results, opaque metadata,
  paths, common credentials, and all attachment bytes by default;
- emits deterministic ZIP bytes, payload SHA-256 records, a Markdown timeline,
  and a versioned manifest;
- verifies archive safety, hashes, schema relationships, contiguous sequence
  numbers, and the official DeepSeek Harness surface invariants.

## Quick start

Requires Node.js 22.19+ or Node.js 24.

```console
pnpm dlx dsh-repro-kit inspect dsh-session-abc.zip
pnpm dlx dsh-repro-kit slice dsh-session-abc.zip --last-error
pnpm dlx dsh-repro-kit verify dsh-session-abc.repro.zip
```

Use an exact event or tool call when the export contains several failures:

```console
dsh-repro slice export.zip --seq 183 --session child-session-id
dsh-repro slice export.zip --tool-call call_01JXYZ --output issue-421.repro.zip
```

Add `--json` to any command for machine-readable output. Existing outputs are
never replaced unless `--force` is explicit.

## Pipeline

```mermaid
flowchart LR
  A["Official ZIP or JSONL"] --> B["Bounded parser"]
  B --> C["Target resolver"]
  C --> D["Causal closure"]
  D --> E["Share-safe redaction"]
  E --> F["Deterministic bundle"]
  F --> G["Independent verifier"]
```

The generated archive has a deliberately small surface:

```text
failure.repro.zip
├── manifest.json
├── REPORT.md
└── sessions/
    ├── session-001.jsonl
    └── session-002.jsonl
```

`manifest.json` does not hash itself, which avoids a self-referential digest.
It hashes every other payload. The original export digest is deliberately not
included because an unsalted digest can confirm guesses about low-entropy input.

## Selection semantics

The v1 policy is
`enclosing-turn+causal-sources+tool-pairs+lineage`:

1. Resolve exactly one target event.
2. Include its complete enclosing turn when one exists.
3. Recursively include cited source events, command/compaction sequence
   references, and surface replacement endpoints.
4. Keep matching assistant tool blocks, `tool/call`, and `tool/result` events in
   the same turn and step.
5. Add turn/step boundaries and the nearest applicable request header/context.
6. Add available ancestors as header-only lineage sessions.
7. Renumber events contiguously and rewrite provenance and replacement refs.

The manifest retains the original sequence mapping for diagnostics.
Within one session, `--last-error` uses log sequence rather than wall-clock
order. Separate sessions have no causal total order, so their final failures are
ordered by epoch timestamp with stable storage identity as a deterministic tie
break.

## Security model

ZIP input is inspected before inflation. The parser rejects path traversal,
backslashes, duplicate entries, duplicate session IDs, malformed UTF-8,
duplicate JSON members, unsupported session versions, sequence gaps, and inputs
that exceed fixed byte, entry, session, or line budgets. Packed chunk rows are
expanded with the public `@deepseek-ai/dsh-session` decoder.

The default redaction profile preserves event kinds, turn/step placement,
provider/model identifiers, tool names, error names/codes, numeric usage, and
relative timing. Text payloads are replaced by stable placeholders that reveal
only equality and character count. Real timestamps are normalized to the
session start.

Automated redaction reduces disclosure risk; it cannot guarantee that every
plugin-defined field or sensitive numeric value is harmless. Review the bundle
before sharing it. See [SECURITY.md](SECURITY.md) for the threat model and limits.

## Library API

```ts
import { buildBundle, loadExport, redactSlice, sliceExport, verifyBundle } from 'dsh-repro-kit'
import { writeFile } from 'node:fs/promises'

const source = await loadExport('dsh-session-abc.zip')
const slice = sliceExport(source, { kind: 'last-error' })
const artifact = buildBundle(redactSlice(slice))

await writeFile('failure.repro.zip', artifact.bytes)
await verifyBundle(artifact.bytes)
```

The `RedactedSlice` returned by `redactSlice()` does not retain the loaded export,
raw selector values, source paths, or input digests. Retained diagnostic metadata
still requires review under the threat model above.

Public TypeScript types include `InputLimits`, `SliceTarget`, `RedactedSlice`,
`BundleManifest`, and `VerifyResult`. Expected failures use `ReproError` with
stable codes.

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | Success |
| 2 | Invalid command or options |
| 3 | Input, format, or output-path failure |
| 4 | Slice target missing or ambiguous |
| 5 | Invalid bundle or integrity mismatch |

## Compatibility

Version 0.1 targets DeepSeek Harness session format `0` and
`@deepseek-ai/dsh-session@0.1.0-rc.7`. A foreign format version is refused before
current-shape validation; silent best-effort conversion would produce misleading
evidence.

The bundle contract is documented in [docs/FORMAT.md](docs/FORMAT.md) and its
machine-readable schema is [schemas/manifest.schema.json](schemas/manifest.schema.json).

## Development

```console
pnpm install --frozen-lockfile
pnpm check
```

The test suite includes malformed archives, duplicate JSON keys, packed chunks,
causal closure, relationship-preserving redaction, deterministic ZIP generation,
tampering, and a complete CLI round trip.

MIT licensed.
