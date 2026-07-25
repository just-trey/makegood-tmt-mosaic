---
name: release
description: Cut a release of tmt-mosaic — bump the version everywhere that doesn't auto-track, finalize the CHANGELOG, and push the tag that actually triggers the Pages deploy. Use when asked to cut, prep, or ship a release, or to bump the version.
---

# Cut a release

Pre-1.0 semver (`0.x.y`). PATCH for fixes; MINOR (`0.x.0`) when the release
contains anything under `### Added`. See
[CONTRIBUTING.md](../../../CONTRIBUTING.md#versioning) before deciding.

Do this edit **in the release PR itself**, never as a follow-up. Version drift
between these files is the recurring failure here — the README badge in
particular was once bumped in a separate PR (#9, after 0.1.1) that the user had
to catch manually.

## 1. Bump the version

```bash
node scripts/bump-version.mjs X.Y.Z
```

This script does all three version edits identically every time, so they can't
drift:

- **package.json** `"version"` — the only version edit the app needs: the
  displayed version derives from it via `__APP_VERSION__` in `vite.config.ts`
  (`getAppVersion` → `src/version.ts`).
- **README.md version badge** (the shields.io badge near the top) — the step
  that's been missed before. The script preserves whatever suffix/color the
  badge already has (e.g. `--beta-orange`) and only swaps the version number.
- **CHANGELOG.md** — moves the `## [Unreleased]` entries into a new
  `## [X.Y.Z] - YYYY-MM-DD` section (today's real date), leaves
  `## [Unreleased]` in place but empty, and rewrites the compare-link refs at
  the bottom.

It refuses to run (non-zero exit, no files touched) if `## [Unreleased]` has no
entries, or if any file's current version is already out of sync — read the
error and fix that by hand first. Review its diff before committing.

There must be exactly one `vite.config.*` in the repo. A stray `vite.config.js`
silently shadows `vite.config.ts` and has broken the Pages deploy before — check
if anything about the build looks wrong.

## 2. Tag — this is the actual ship

Push the release PR, let it merge to `main`, **then** tag:

```bash
git tag vX.Y.Z && git push origin vX.Y.Z
```

Since PR #17, `deploy.yml` triggers on `push: tags: ['v*']`, not on merge to
`main`. Merging the release PR ships nothing by itself — **the tag push is the
go-live action.** Treat it as such: confirm with the user before pushing the tag
unless they've already said to go ahead.

After the tag push, watch the deploy with one blocking background call rather
than polling. `gh run watch` requires an explicit run ID when non-interactive —
without one it fails instantly with a usage error that's easy to mistake for a
broken deploy — so grab the ID first:

```bash
gh run list --workflow=deploy.yml --limit 1
gh run watch <run-id> --exit-status
```

## Reference

Follow the `Release v0.1.1 (#6)` commit for the shape of the package.json +
CHANGELOG edit, plus the README badge. Prior tags: v0.1.0, v0.1.1, v0.3.1,
v0.4.0, v0.4.1.
