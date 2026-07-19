---
name: ship-it
description: Pre-PR gate for this repo — runs the five CI gates locally, then checks the four docs that drift silently (CHANGELOG, README, in-app help panel, analytics catalog) against the actual diff, and watches CI without polling. Use before opening or updating a PR, or when asked "is this ready to push / ready for a PR".
---

# Ship it

The five gates below are exactly what `.github/workflows/ci.yml` runs, and `main`
is protected — a red gate blocks merge. Running them locally is cheaper than a
round trip through GitHub.

## 1. Run the gates

Run these together, in the background, and wait for the notification:

```bash
npm run lint && npm run format:check && npm run typecheck && npm test && npm run smoke
```

`smoke` builds first, so it's the slow one — expect minutes, not seconds. Don't
poll it; the harness re-invokes you when it exits.

**Never** fix a `format:check` failure with `npm run format`. That rewrites line
endings across ~90 files on Windows and buries the real diff. Format only the
files you actually touched:

```bash
npx prettier --write <the files you edited>
```

The husky + lint-staged pre-commit hook already formats staged files, so this is
usually a no-op anyway.

## 2. Check the four silent-drift docs against the diff

Get the diff first (`git diff main...HEAD --stat`), then walk these. Each one is
conditional — decide from the actual changed paths, and say out loud which ones
you judged not-applicable and why.

| Trigger in the diff                                                 | What to update                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any user-visible change                                             | A bullet under `## [Unreleased]` in [CHANGELOG.md](../../../CHANGELOG.md), Keep a Changelog category (Added/Changed/Fixed/Removed). Skip for internal refactors, tests, CI/tooling with no behavior change.                                                                  |
| A feature, pipeline step, limitation, or roadmap item changed       | [README.md](../../../README.md) — sections `## How it works`, `## Known limitations`, `## Roadmap ideas (not built)`. A **shipped** roadmap item moves out of "Roadmap ideas" and becomes a real feature description; leaving it listed as unbuilt is the failure mode here. |
| A left-panel control added/removed/renamed, or what it does changed | The `#help-dialog` block in [index.html](../../../index.html). Its sections mirror `#left` 1:1 and the copy is static — nothing catches this drift but you.                                                                                                                  |
| A left-panel control or other primary user action added/changed     | Its `track()` event plus the catalog in [docs/analytics.md](../../../docs/analytics.md). Follow that doc's `## Adding a new event` section and its `## Rules` — no PII, `snake_case`, fire on real user intent (not on page load or programmatic state changes).             |

## 3. Code review, if the diff earns it

If the diff touches `src/geometry/` or `src/export/`, run `/code-review` before
opening the PR. These are the modules where a wrong result still looks plausible
— a mesh that cuts, a 3MF that opens, both subtly wrong. Skip it for docs, UI
copy, and other trivial changes.

## 4. Push, then watch CI in one blocking call

Branch off `main` if you aren't already on a branch — `main` rejects direct
pushes, force-pushes, and branch deletion.

After pushing, watch CI with a **single background** call:

```bash
gh pr checks --watch --fail-fast
```

This blocks in the shell for however long CI takes and costs zero model turns
while waiting; the harness re-invokes you once, with the result. Do **not** loop
`gh pr checks` or `gh run list` — each poll re-sends the whole conversation, so
N polls cost N× the context. One blocking watch costs 1×, flat, regardless of
duration.

Note that CI runs the same five gates from step 1. If those passed locally, this
step is confirmation rather than discovery — worth it on release tags and on
changes that could behave differently in CI's environment, optional otherwise.
Say which case you think it is instead of watching reflexively.

## Scope

One focused change per branch/PR. If the work splits cleanly into independent
changes, prefer separate PRs over one bundle — bundle only what's genuinely
coupled.
