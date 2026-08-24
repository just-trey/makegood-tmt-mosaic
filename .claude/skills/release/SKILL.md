---
name: release
description: "Cut a release of tmt-mosaic: bump the version everywhere that doesn't auto-track, finalize the CHANGELOG, and push the tag that actually triggers the Pages deploy. Use when asked to cut, prep, or ship a release, or to bump the version."
model: sonnet
disable-model-invocation: true
---

# Cut a release

Pre-1.0 semver (`0.x.y`). PATCH for fixes; MINOR (`0.x.0`) when the release
contains anything under `### Added`. Read
[CONTRIBUTING.md](../../../CONTRIBUTING.md#versioning) before deciding.

**Do the version edit in the release PR itself, never as a follow-up.** Version
drift between these files is the recurring failure: the README badge was once
bumped in a separate PR (#9, after 0.1.1) that the user had to catch by hand.

## 1. Bump the version

```bash
node scripts/bump-version.mjs X.Y.Z
```

The script makes all three edits identically every time, so they can't drift:

- **package.json** `"version"`, the only version edit the app needs. The
  displayed version derives from it via `__APP_VERSION__` in `vite.config.ts`
  (`getAppVersion` → `src/version.ts`).
- **README.md version badge**, the step that has been missed before. The script
  preserves the badge's existing suffix and colour (`--beta-orange`) and swaps
  only the number.
- **CHANGELOG.md**: moves `## [Unreleased]` entries into a new
  `## [X.Y.Z] - YYYY-MM-DD` section using today's real date, leaves
  `## [Unreleased]` empty, and rewrites the compare links at the bottom.

It refuses to run, non-zero and touching nothing, if `## [Unreleased]` is empty
or any file's version is already out of sync. Fix that by hand first. Review the
diff before committing.

**There must be exactly one `vite.config.*` in the repo.** A stray
`vite.config.js` silently shadows `vite.config.ts` and has broken the Pages
deploy before. Check it if anything about the build looks wrong.

## 2. Tag: this is the actual ship

Push the release PR, let it merge to `main`, **then** tag:

```bash
git tag vX.Y.Z && git push origin vX.Y.Z
```

Since PR #17, `deploy.yml` triggers on `push: tags: ['v*']`, not on merge to
`main`. **Merging the release PR ships nothing; the tag push is the go-live
action.** Confirm with the user before pushing it unless they have already said
to go ahead.

The tag push also mints the **GitHub Release**. `deploy.yml`'s `release` job
creates it from this version's CHANGELOG section (via
`scripts/changelog-extract.mjs`), gated on the build passing. No manual
`gh release create`. For a while tags ran ahead of the Releases page (releases
stopped at v0.2.1 while tags reached v0.6.0) precisely because that step was
manual. If they drift again, the **Backfill GitHub Releases** workflow
(`backfill-releases.yml`, from the Actions tab) creates a Release for every
`v*` tag missing one, and is idempotent.

Because the notes come from the CHANGELOG, a tag whose CHANGELOG section is
wrong ships wrong notes. Get step 1 right before tagging.

### Watch the deploy

One blocking background call, not polling. `gh run watch` needs an explicit run
ID when non-interactive, and without one it fails instantly with a usage error
that is easy to mistake for a broken deploy. Resolve the ID first, **pinned to
this tag**:

```bash
export tag=vX.Y.Z
sha=$(git rev-parse "$tag^{commit}")
n=0
until id=$(gh run list --workflow=deploy.yml --commit "$sha" --limit 20 \
             --json databaseId,headBranch \
             --jq 'map(select(.headBranch == $ENV.tag)) | first | .databaseId // empty' \
             2>/dev/null); [ -n "$id" ]; do
  n=$((n + 1))
  [ $n -ge 30 ] && { echo "no deploy run for $tag after 150s: NOT deployed, investigate"; exit 1; }
  sleep 5
done
gh run watch "$id" --exit-status
```

**Never resolve the run with `gh run list --limit 1`.** GitHub takes a few
seconds to register a new tag's run, and in that window the newest deploy run is
the _previous_ release's, completed and successful. `gh run watch` on it returns
green in under a second, so the last release's deploy reads as this one's.

That is a worse version of the `gh pr checks` race `ship-it` guards against
(#125): not "nothing to watch and exit 0", but a real pass from the wrong
commit. Filtering on the tag's commit and `headBranch` asserts the run _is_ this
tag's; the `until` loop waits for it and hard-fails if it never appears.

The loop runs inside one shell call: one model turn, not one per iteration. The
no-polling rule is about model-side loops.

**Green means the run's own conclusion, not the absence of an error.** A
zero-duration pass, or a run whose title names an older version, is a failure to
verify.

### If the run goes red on environment protection rules

```
Tag vX.Y.Z is not allowed to deploy to github-pages due to environment
protection rules
```

A fast red, not a hang: `build` succeeds and uploads the artifact, then `deploy`
fails immediately. The `github-pages` _environment_ carries its own
deployment-branch policies, separate from `deploy.yml`'s `push: tags: ['v*']`
trigger. Satisfying the trigger says nothing about satisfying the environment.
They allowed only `main` at first, which is exactly how the first tag-triggered
deploy failed: the workflow ran because the tag matched, then the deploy was
refused because the tag didn't.

The fix is a `v*` **tag** policy alongside the branch one:

```bash
gh api --method POST \
  repos/just-trey/makegood-tmt-mosaic/environments/github-pages/deployment-branch-policies \
  -f name='v*' -f type=tag
```

**That policy is in place today**, verified 2026-08-03: the environment lists
`main` (branch) and `v*` (tag). It should persist, so if a tagged deploy fails
this way again, check the policy still exists before adding a second:

```bash
gh api repos/just-trey/makegood-tmt-mosaic/environments/github-pages/deployment-branch-policies
```

## Reference

Follow the `Release v0.1.1 (#6)` commit for the shape of the package.json and
CHANGELOG edit plus the README badge. Prior tags: v0.1.0, v0.1.1, v0.3.1,
v0.4.0, v0.4.1.
