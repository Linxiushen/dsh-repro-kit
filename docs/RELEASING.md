# Releasing

`package.json` is the single version source. The CLI and library read that
version at runtime, and the release workflow rejects any tag other than
`v${package.version}`.

## Repository setup

The GitHub `npm` environment needs an `NPM_TOKEN` secret until npm Trusted
Publishing is configured. Restrict environment deployment to protected tags or
required reviewers. Keep private vulnerability reporting enabled.

## Release checklist

1. Update `package.json` and `CHANGELOG.md` together.
2. Run `pnpm install --frozen-lockfile`, `pnpm check`, and
   `pnpm test:coverage` on a clean checkout.
3. Verify the intended tag locally with `pnpm check:release vX.Y.Z`.
4. Commit, create the matching annotated tag, and push the commit and tag.

The workflow validates in a read-only job, creates a draft GitHub Release,
publishes the provenance-attested npm package, and only then makes the GitHub
Release public. A rerun skips npm publication when that exact package version
already exists, allowing recovery if only the final Release step failed.

After npm Trusted Publishing is enabled for this repository and workflow,
remove `NPM_TOKEN` from the workflow and environment rather than retaining a
long-lived automation token.
