# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.0] - 2026-08-18

### Added

- Bounded official ZIP and plaintext JSONL input parsing.
- Last-error, exact-sequence, and tool-call target selection.
- Causally closed turn slicing with lineage and sequence remapping.
- Stable share-safe redaction and default attachment omission.
- Deterministic v1 bundles, Markdown reports, SHA-256 payload records, and an
  independent verifier.
- CLI, TypeScript API, bilingual documentation, schema, and CI.
- Failure incident triage with privacy-conscious evidence, exact slice
  selectors, and versioned structural fingerprints.
- Runtime `share-safe-v1` policy audits in both the bundle writer and independent
  verifier, including recomputed redaction counts and JSON traversal budgets.
- Canonical `REPORT.md` reconstruction and explicit verification checks with
  unauthenticated provenance status.
- Stable redaction of JSON Schema map keys and out-of-profile object keys while
  retaining Harness and fixed JSON Schema structural vocabulary.

### Changed

- Unified `inspect` and `--last-error` on one formal failure classifier.
- Preserved official workflow child, code-dispatch, command, compaction, retry,
  and handler identifier relationships through typed aliases.
- Made ZIP timestamps and attachment alias ordering deterministic across
  timezones and locales.

[Unreleased]: https://github.com/Linxiushen/dsh-repro-kit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Linxiushen/dsh-repro-kit/releases/tag/v0.1.0
