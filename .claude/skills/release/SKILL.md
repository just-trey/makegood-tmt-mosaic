---
name: release
description: Cut a release of tmt-mosaic — bump the version everywhere that doesn't auto-track, finalize the CHANGELOG, and push the tag that actually triggers the Pages deploy. Use when asked to cut, prep, or ship a release, or to bump the version.
---

# Cut a release

Pre-1.0 semver (`0.x.y`). PATCH for fixes; MINOR (`0.x.0`) when the release
contains anything under `### Added`. See
[CONTRIBUTING.md](../../../CONTRIBUTING.md#versioning) before deciding.

Do all four edits **in the release PR itself**, never as a follow-up. Version
drift between these files is the recurring failure here — the README badge in
particular was once bumped in a separate PR (#9, after 0.1.1) that the user had
to catch manually.

## 1. package.json

`"version"` → the new version. This is the only version edit the app needs: the
displayed version derives from it via `__APP_VERSION__` in `vite.config.ts`
(`getAppVersion` → `src/version.ts`).

There must be exactly one `vite.config.*` in the repo. A stray `vite.config.js`
silently shadows `vite.config.ts` and has broken the Pages deploy before — check
if anything about the build looks wrong.

## 2. README.md version badge

Around line 4 (`version-X.Y.Z--alpha`). **Nothing auto-updates this.** It is the
step most often missed.

## 3. CHANGELOG.md

- Move the `## [Unreleased]` entries into a new `## [X.Y.Z] - YYYY-MM-DD`
  section, using today's real date.
- Leave `## [Unreleased]` in place, empty.
- Update the link refs at the bottom: point `[Unreleased]` at
  `compare/vX.Y.Z...HEAD`, and add `[X.Y.Z]: …compare/vPREV...vX.Y.Z`.

## 4. Tag — this is the actual ship

Push the release PR, let it merge to `main`, **then** tag:

```bash
git tag vX.Y.Z && git push origin vX.Y.Z
```

Since PR #17, `deploy.yml` triggers on `push: tags: ['v*']`, not on merge to
`main`. Merging the release PR ships nothing by itself — **the tag push is the
go-live action.** Treat it as such: confirm with the user before pushing the tag
unless they've already said to go ahead.

After the tag push, watch the deploy with one blocking background call rather
than polling:

```bash
gh run watch --exit-status
```

## Reference

Follow the `Release v0.1.1 (#6)` commit for the shape of the package.json +
CHANGELOG edit, plus the README badge. Prior tags: v0.1.0, v0.1.1, v0.3.1,
v0.4.0, v0.4.1.
