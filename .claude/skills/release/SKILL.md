---
name: release
description: Cut a release of tmt-mosaic — bump the version everywhere that doesn't auto-track, finalize the CHANGELOG, and push the tag that actually triggers the Pages deploy. Use when asked to cut, prep, or ship a release, or to bump the version.
model: sonnet
disable-model-invocation: true
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
broken deploy — so resolve the ID first, **pinned to this tag**:

```bash
export tag=vX.Y.Z
sha=$(git rev-parse "$tag^{commit}")
n=0
until id=$(gh run list --workflow=deploy.yml --commit "$sha" --limit 20 \
             --json databaseId,headBranch \
             --jq 'map(select(.headBranch == $ENV.tag)) | first | .databaseId // empty' \
             2>/dev/null); [ -n "$id" ]; do
  n=$((n + 1))
  [ $n -ge 30 ] && { echo "no deploy run for $tag after 150s — NOT deployed, investigate"; exit 1; }
  sleep 5
done
gh run watch "$id" --exit-status
```

**Never resolve the run with `gh run list --limit 1`.** GitHub takes a few
seconds to register the run for a new tag, and in that window the newest deploy
run is still the _previous_ release's — completed and successful. `gh run watch`
on it returns green in under a second, so the last release's deploy reads as
this one's. That is a worse version of the `gh pr checks` race that `ship-it`
guards against (#125): not "nothing to watch and exit 0", but a real pass from
the wrong commit. Filtering on the tag's commit and `headBranch` asserts the run
you're watching _is_ this tag's; the `until` loop waits for it to exist and
hard-fails if it never does.

The loop runs entirely inside one shell call — one model turn total, not one per
iteration. The no-polling rule is about model-side loops.

Green here means the run's own conclusion, not the absence of an error. Read the
result text: a zero-duration pass or a run whose title names an older version is
a failure to verify, not a verification.

### If the run goes red on environment protection rules

```
Tag vX.Y.Z is not allowed to deploy to github-pages due to environment
protection rules
```

This is a fast red, not a hang: `build` succeeds, uploads the artifact, and
`deploy` fails immediately. The `github-pages` _environment_ carries its own
deployment-branch policies, which are separate from `deploy.yml`'s
`push: tags: ['v*']` trigger — satisfying the trigger says nothing about
satisfying the environment. They allowed only the `main` branch at first, which
is exactly how the first tag-triggered deploy failed: the workflow ran because
the tag matched, then the deploy step was refused because the tag didn't.

The fix is a `v*` **tag** policy alongside the branch one:

```bash
gh api --method POST \
  repos/just-trey/makegood-tmt-mosaic/environments/github-pages/deployment-branch-policies \
  -f name='v*' -f type=tag
```

That policy is in place today — verified 2026-08-03, the environment lists
`main` (branch) and `v*` (tag). It should persist, so if a tagged deploy ever
fails this way again, check whether the policy still exists before adding a
second one:

```bash
gh api repos/just-trey/makegood-tmt-mosaic/environments/github-pages/deployment-branch-policies
```

## Reference

Follow the `Release v0.1.1 (#6)` commit for the shape of the package.json +
CHANGELOG edit, plus the README badge. Prior tags: v0.1.0, v0.1.1, v0.3.1,
v0.4.0, v0.4.1.
