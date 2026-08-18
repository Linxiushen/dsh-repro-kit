# Contributing

Use Node.js 22.19+ or 24 and pnpm 11.

```console
pnpm install --frozen-lockfile
pnpm check
```

Changes to parsing, redaction, slicing, or verification need an adversarial test.
Never add a real session export, credential, home-directory path, customer name,
or production attachment as a fixture. Use synthetic values that are clearly
non-functional.

Bundle-format changes must update `docs/FORMAT.md`, the manifest JSON Schema,
the verifier, both READMEs, and the integer format version when an old verifier
could otherwise accept the new output with incorrect semantics.

Maintainers should follow [docs/RELEASING.md](docs/RELEASING.md) for version and
publication checks.
