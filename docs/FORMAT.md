# Bundle format v1

The media type is an ordinary ZIP archive. Paths use UTF-8 and forward slashes.
Writers use a fixed timestamp, stable file order, canonical JSON object-key
ordering, LF newlines, and deterministic DEFLATE settings.

## Entries

- `manifest.json`: canonical, indented JSON followed by one LF.
- `REPORT.md`: a human-readable target summary and event timeline.
- `sessions/session-NNN.jsonl`: one redacted session header followed by expanded,
  contiguous events. Every line is canonical compact JSON followed by one LF.

No attachment bytes are permitted in v1.

## Integrity

`manifest.files` has one SHA-256 record for `REPORT.md` and every session JSONL.
The manifest is excluded because a document cannot contain its own final digest.
The ZIP container itself is deterministic but does not need a manifest record.

The source export SHA-256 is not emitted. This is intentional: an unsalted
digest can act as a confirmation oracle for guessed low-entropy source content.

Hashes are an internal integrity mechanism, not an authenticity mechanism. A v1
verifier also reapplies `share-safe-v1`, recomputes its occurrence counts, and
reconstructs `REPORT.md` from the manifest plus session payloads. A rehashed but
non-canonical report or unredacted payload is invalid.

## Failure fingerprints

`dsh-failure-v1:<sha256>` values returned by the triage API/CLI are not stored in
the v1 bundle contract. They hash canonical structured failure facts while
excluding raw identifiers, sequence numbers, timestamps, paths, and free text.
The prefix versions triage semantics independently from this archive format.

`share-safe-v1` also treats object member names as data. Harness structural
keys and fixed JSON Schema keywords are retained. Schema map members and names
outside the conservative structural grammar become stable `<redacted-key-...>`
placeholders; `required`-style references reuse them. Every key occurrence
that is replaced contributes to `textValues` counts.

## Sequence mapping

Session events are sorted by original sequence, then assigned output sequences
from zero. The writer rewrites every retained sequence-bearing field through
that map:

- top-level `sourceEventSeqs`;
- replacement `surfaceOp.start/end`;
- successful `command/done.data.sourceEventSeq`;
- `compaction/summary` and `compaction/prune` fields `data.shadowedSeqs` and
  `data.shadowedRange.start/end`.

`shadowedSeqs` is authoritative and retains its explicit order; a shadowed range
is not expanded into every integer between its endpoints.
`manifest.sessions[].originalSeqs[outputSeq]` returns the corresponding source
sequence. A sliced `seedLength` counts retained events whose original sequence
was below the source seed boundary.

## Versioning

`manifest.version` versions this contract, not the producing CLI. Readers must
reject unsupported versions before applying current-version shape checks.
Additive or semantic changes that an old verifier cannot interpret correctly
require a new integer version.
