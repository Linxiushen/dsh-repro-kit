# Security policy

## Reporting a vulnerability

Please use GitHub private vulnerability reporting for this repository. Do not
attach an unreviewed production session export to a public issue. Include the
smallest synthetic fixture that demonstrates the problem when possible.

## Threat model

`dsh-repro-kit` treats ZIP metadata, filenames, JSONL text, packed storage rows,
event envelopes, and manifests as untrusted input. It bounds compressed input,
entry count, per-entry uncompressed bytes, aggregate uncompressed bytes, session
count, and JSONL line count. It rejects duplicate paths and JSON members instead
of accepting parser-dependent interpretations. Files are inflated in memory and
are never extracted to disk paths.

The generated v1 bundle omits media bytes and original input hashes. Stable
aliases do not embed hashes of raw identifiers or text. The profile preserves
some diagnostic metadata, including provider/model names, tool names, error
names/codes, numeric fields, relative timing, event types, and object keys.
The public `RedactedSlice` intermediate also drops the loaded source object, raw
selector values, source paths, and input digests before it reaches the bundle
builder.

## Limitations

This is a disclosure-risk reduction tool, not a proof of anonymization.

- Plugin-defined object keys and numeric fields may carry sensitive meaning.
- Equality and character length of replaced strings are intentionally retained.
- Provider/model, tool, event, error-name, and error-code fields remain visible.
- File sizes, event counts, original sequence numbers, and relative timing remain
  visible.
- Maliciously chosen retained metadata may resemble or contain sensitive data;
  common token, email, URL, and path patterns are scrubbed, but no detector is
  complete.

Always review `REPORT.md`, `manifest.json`, and the session JSONL before sharing.
