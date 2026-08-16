---
name: ship-it
description: Pre-PR gate for this repo: checks DECISIONS-NEEDED.md is drained, runs the five CI gates locally, then checks the four docs that drift silently (CHANGELOG, README, in-app help panel, analytics catalog) against the actual diff, and watches CI without polling. Use before opening or updating a PR, or when asked "is this ready to push / ready for a PR".
model: sonnet
---

# Ship it

The five gates below are exactly what `.github/workflows/ci.yml` runs, and `main`
is protected, so a red gate blocks merge. Running them locally is cheaper than a
round trip through GitHub.

## 0. Any open decisions first

```bash
test -s DECISIONS-NEEDED.md && { echo "DECISIONS-NEEDED.md has open entries, not done yet."; cat DECISIONS-NEEDED.md; }
```

**If that prints anything, stop.** CLAUDE.md: "an unresolved entry is a blocker,
not a footnote." Writing the entry down is step one, not the whole job. It still
owes one of three outcomes: resolved into a code comment, promoted to
`tech-debt.md` or `roadmap.md`, or genuinely still open, in which case say so
rather than continuing. Don't run the rest of this skill, and don't open or
update the PR, until the file is gone.

The check is mechanical on purpose. It is easy to settle the one decision a task
named and move straight to shipping without noticing that "I wrote the entry"
and "the branch is done" are different claims.

## 1. Run the gates

Run these together, in the background, and wait for the notification:

```bash
npm run lint && npm run format:check && npm run typecheck && npm run test:coverage && npm run smoke
```

`smoke` builds first, so expect minutes, not seconds. Don't poll it; the harness
re-invokes you when it exits.

The test gate is `test:coverage`, not `npm test`, because that is what CI runs:
the same suite plus the per-directory coverage floors in
[vite.config.ts](../../../vite.config.ts). A breach reads:

```
ERROR: Coverage for statements (n%) does not meet "src/geometry/**" threshold (m%)
```

**That is a coverage floor, not a broken or flaky test.** Don't hunt for a
failing assertion. It names a glob because floors are per-directory aggregates,
so read the coverage table to find which file lost ground. The fix is a test,
not a lower number: floors sit _under_ what the code already achieves, so
tripping one means coverage went backwards in this diff.

**Never fix a `format:check` failure with `npm run format`.** That rewrites line
endings across ~90 files on Windows and buries the real diff. Format only what
you touched:

```bash
npx prettier --write <the files you edited>
```

The husky and lint-staged pre-commit hook already formats staged files, so this
is usually a no-op.

## 2. Check the four silent-drift docs against the diff

Get the diff first (`git diff main...HEAD --stat`), then walk these. Each is
conditional: decide from the actual changed paths, and say out loud which ones
you judged not-applicable and why.

| Trigger in the diff                                                  | What to update                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any user-visible change                                              | A bullet under `## [Unreleased]` in [CHANGELOG.md](../../../CHANGELOG.md), Keep a Changelog category (Added/Changed/Fixed/Removed). Skip for internal refactors, tests, CI/tooling with no behavior change.                                                     |
| A pipeline step or a Known Limitations bullet changed                | [README.md](../../../README.md)'s `## How it works` / `## Known limitations`, and [docs/pipeline.md](../../../docs/pipeline.md) for the full walkthrough.                                                                                                       |
| A roadmap item shipped or a new one was deferred                     | [docs/roadmap.md](../../../docs/roadmap.md). A **shipped** item moves out of the roadmap and becomes a real feature description; leaving it listed as unbuilt is the failure mode here.                                                                         |
| Deferred work, a new measured limitation, or a tech-debt item closed | [docs/tech-debt.md](../../../docs/tech-debt.md): one `##` section per item.                                                                                                                                                                                     |
| A left-panel control added/removed/renamed, or what it does changed  | The `#help-dialog` block in [index.html](../../../index.html). Its sections mirror `#left` 1:1 and the copy is static, so nothing catches this drift but you.                                                                                                   |
| A left-panel control or other primary user action added/changed      | Its `track()` event plus the catalog in [docs/analytics.md](../../../docs/analytics.md). Follow that doc's `## Adding a new event` section and its `## Rules`: no PII, `snake_case`, fire on real user intent (not on page load or programmatic state changes). |

## 3. Code review, if the diff earns it

If the diff touches `src/geometry/` or `src/export/`, run `/code-review` before
opening the PR. Those are the modules where a wrong result still looks
plausible: a mesh that cuts, a 3MF that opens, both subtly wrong. Skip it for
docs, UI copy and other trivial changes.

## 4. Push, then watch CI in one blocking call

Branch off `main` if you aren't already on a branch. `main` rejects direct
pushes, force-pushes and branch deletion, and the pre-commit hook enforces it,
so you hit that at the first commit rather than here.

After pushing, watch CI with a **single background** call:

```bash
n=0
until [ "$(gh pr checks --json name --jq length 2>/dev/null || echo 0)" -gt 0 ]; do
  n=$((n + 1))
  [ $n -ge 30 ] && { echo "no checks registered after 150s: NOT green, investigate"; exit 1; }
  sleep 5
done
gh pr checks --watch --fail-fast
```

**Bare `gh pr checks --watch` is not safe directly after `gh pr create`, which
is exactly when this skill runs it.** GitHub takes a few seconds to register
check runs for a new PR. Until it does, `gh` prints "no checks reported on the
branch" and **exits 0**, which is indistinguishable from success by exit code.
The harness then reports a completed command with no error, so a PR whose CI had
not started reads as passing. This has already happened once (#124). The `until`
loop waits for at least one check to exist, and hard-fails rather than passing
if none appear.

The loop runs inside one shell call, so it does not violate the no-polling rule:
one model turn total, not one per iteration.

**Do not loop `gh pr checks` or `gh run list` from the model side.** Each poll
re-sends the whole conversation, so N polls cost N× the context. One blocking
watch costs 1×, flat, however long CI takes.

Read the actual result text before calling it green. "No checks reported", a
zero-duration pass, and an empty check list are all failures to verify.

CI runs the same five gates as step 1, so if those passed locally this step is
confirmation rather than discovery. Worth it on release tags and on changes that
could behave differently in CI's environment; optional otherwise. Say which case
you think it is instead of watching reflexively.

## Scope

One focused change per branch and PR. If the work splits cleanly into
independent changes, prefer separate PRs; bundle only what is genuinely coupled.
