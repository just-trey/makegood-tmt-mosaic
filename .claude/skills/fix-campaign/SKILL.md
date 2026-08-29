---
name: fix-campaign
model: sonnet
disable-model-invocation: true
description: 'Close several independent docs/tech-debt.md items at once: one worktree agent per item on the model CLAUDE.md assigns, one PR each, merged to main on green as each lands, then a round-trip measurement report. Use when asked to fix a batch of tech-debt items, run a multi-agent fix campaign, or "merge each as it finishes".'
---

# Fix campaign

One agent per tech-debt item, in its own worktree, on the model CLAUDE.md's
planning table assigns (`src/geometry/`, `src/export/`, placement math →
Opus; UI, state plumbing, docs → Sonnet). The orchestrator never edits source:
it briefs, merges, measures, and cleans up.

The 2026-08-28 run (#259, #260, #261; #257 landed from a stale worktree) is
the worked example this skill is drawn from. Its measurement report lands at
`docs/findings/<date>-round-trip-measurement.md` per step 5 below once that
campaign's last PR merges; check `docs/findings/` for the actual filename
rather than assuming this date.

## 0. Before briefing anyone

- `git fetch origin && git log --oneline main..origin/main`. Another session
  may be merging into `main` at the same time. Brief against `origin/main`.
- `git worktree list` and `gh pr list`. **A stale worktree with uncommitted
  docs and tests for your item means someone got there first.** In the
  worked example, item 6 shipped as #257 from exactly such a worktree while
  agent E was re-implementing it. Check the branch and any open PR before
  spawning; if work exists, finish that branch instead of starting a new one.
- Plan mode first. The plan names, per item: the tech-debt section, the
  model, the branch, the files, the trap file to read first, and the test
  that must be shown failing on `main`.

## 1. The brief

Write one shared brief to the scratchpad and one per-item prompt that starts
"Read <brief> first". The shared brief carries the rules the agents kept
needing:

- Worktree: `npm install` first (tests pass without it, `vite`/`smoke` fail
  with a misleading Manifold error). **Never `git stash`** (shared across
  worktrees). Rename the branch to the one the plan names. Do not remove the
  worktree; the orchestrator does.
- One finding per PR. A second defect found on the way becomes its own
  tech-debt section, not a fix.
- Levers, so the report can score them: test first and shown failing on
  `main`; mutation run for every new guard/clear/dismiss; state sketch in the
  PR body before the first edit (anything touching warning lifecycle or
  persistence); every number cites its command; read the named trap file;
  cut the area on the second repeat.
- `/code-review` before pushing and again after acting on findings. Stop on
  taste. Never add a `replaceNotice`/upsert to `src/warnings.ts` (tech-debt's
  first section: tried, three rounds, reverted).
- `ship-it`, then `gh pr create` with a `## Rounds` table: one row per review
  round including the clean final one, columns Round / Correction / Cause
  code / Introduced by previous round's fix?. Cause codes: FIX VAC NUM DOC
  PIPE CTX SCOPE DIAG HARD GATE TASTE VIS (VIS: caught by a human looking at
  the PR, not by `/code-review` — step 5 tallies this one specifically).
- **Rebase onto `origin/main` before pushing.** Every PR touches
  `CHANGELOG.md`'s Fixed list and `docs/tech-debt.md`; the first one to merge
  conflicts with all the others.
- **Draft the PR body in a worktree-local path, not the shared scratchpad.**
  Parallel agents share the scratchpad; one agent's draft overwrote
  another's there in the worked example.
- Do not watch CI. Report the PR URL and the Rounds table, then stop.

Spawn with `isolation: "worktree"`, `run_in_background: true`, the `model`
the plan names. No subagent spawns subagents.

## 2. While they run

- **Agents pause on their own background tasks.** A report reading "waiting
  for the gate run" or "waiting for the CI watch" is an agent that will not
  wake on its own. `SendMessage` it: read the output file (or re-run in the
  foreground with a 600000 timeout), then continue. Happened to three of
  five in the worked example.
- Code-review sub-passes report to you as well as to the agent. Relay only a
  real trap (the upsert above, a rule the agent is about to break). The
  agent already has the findings.
- **The scratchpad is shared across the parallel agents.** One agent's
  PR-body draft was overwritten by another's. Tell agents to draft PR bodies
  in a worktree-local path.

## 3. Merge on green, one at a time, as each lands

Do this per PR the moment its agent reports, without waiting for the others:

```bash
gh pr view <n> --json mergeable,mergeStateStatus -q '.mergeable+" "+.mergeStateStatus'
```

- `MERGEABLE` and checks pending: watch once, in the background, never a
  poll loop. Foreground `sleep` is blocked in this harness, so run the wait
  as one `run_in_background: true` Bash call, not inline. Same recipe as
  `ship-it`'s SKILL.md step 4 (the `--json name --jq length` check, not a
  plain-text grep: `gh pr checks`'s own "no checks reported" string can
  satisfy a bare `grep -q .`, #124) — read that step for the why, since
  restating the rationale twice is what drifts out of sync, not the two
  lines of shell:

  ```bash
  i=0
  until [ "$(gh pr checks <pr> --json name --jq length 2>/dev/null || echo 0)" -gt 0 ]; do
    i=$((i + 1))
    [ $i -ge 30 ] && { echo "no checks registered after 150s on #<pr>"; exit 1; }
    sleep 5
  done
  gh pr checks <pr> --watch --fail-fast
  ```

  **Every `gh pr checks` in this loop takes `<pr>`**, not just the last
  one — parameterizing only the trailing `--watch --fail-fast` call leaves
  the registration check polling the wrong PR.

  Then `gh pr view <n> --json mergeStateStatus` must say `CLEAN` before
  `gh pr merge <n> --squash --delete-branch`. **`gh pr merge`'s allowlist
  entry isn't scoped to those flags** — `--admin` would bypass the
  CI-green gate this step just checked, and no permission-glob syntax here
  can exclude one flag while allowing the rest. Never pass `--admin`; there
  is no mechanical guard against it.

- `CONFLICTING`: rebase it yourself in a scratch worktree. The agent's
  worktree may hold the branch, so use a temp local name. **Fetch first** —
  `gh pr merge` is a remote call and never updates the local `origin/main`
  ref, so a rebase without a fresh fetch runs against the pre-merge tip and
  either misses the just-merged PR's content or reproduces the same conflict:

  ```bash
  git fetch -q origin
  S=<scratchpad>/rb<n>
  git worktree add -q -b rb<n>-tmp $S origin/<branch>
  ```

  **`cd "$S"` before every git/npm/node command in this recipe from here
  on, rather than `git -C $S`.** `git -C <path> <cmd>` doesn't match a plain
  `Bash(git rebase *)`/`Bash(git add *)` allow rule — the pattern matches on
  the command's literal leading tokens, and `.claude/settings.local.json`
  already carries a one-off exact-string entry for exactly this gap
  (`git -C <worktree-path> checkout ...`) rather than a reusable prefix.
  `cd` first and every subsequent command matches the plain rule.

  ```bash
  cd "$S" && git rebase origin/main
  ```

  Resolve `CHANGELOG.md` by keeping both sides' bullets. Resolve
  `docs/tech-debt.md` by dropping every heading of a section that is already
  closed on `main` and keeping headings the branch added. Symlink
  `node_modules` from the main checkout into `$S` now (`ln -s
<main-checkout>/node_modules node_modules`, allowlisted) — `npx prettier`,
  `node scripts/check-troubleshooting.mjs`, and the PR's own vitest command
  all need it to resolve at all in a bare `git worktree add` checkout, not
  just the first of the three. Run all three, `git add CHANGELOG.md
docs/tech-debt.md` — `rebase --continue` refuses unstaged conflict
  resolutions — then `git rebase --continue`. **A branch with more than one
  commit touching these two files stops more than once**: after each
  `--continue`, check `git status` for "rebase in progress" and repeat the
  resolve-add-continue cycle until it reports a clean tree. Only then remove
  the `node_modules` symlink and `git push --force-with-lease origin
rb<n>-tmp:<branch>` (`cd` back to the main checkout first — `-C` only bites
  when it's the leading token the allowlist tries to match), remove the
  scratch worktree, **delete the local `rb<n>-tmp` branch** (`git worktree
remove` drops the directory, not the branch ref — confirmed by creating
  and removing one), re-arm the watch above.

- Right after a merge, GitHub reports the next PR `UNKNOWN` for ~30s, then
  `CONFLICTING`. That is expected: rebase it as above. Merges are therefore
  sequential; a second PR is never rebased until the first has merged.
- After the merge, remove that agent's worktree. Check first that its HEAD
  equals `origin/<branch>` (the agent may have uncommitted scratch). Locked
  worktrees need `git worktree unlock` before `remove`.

`main` is protected, so `gh pr merge` is the only write to it. Invoking this
skill is the user's approval for every merge it performs — that is the
contract, not a per-PR prompt. The project's `.claude/settings.json`
allowlists `gh pr merge`, `git rebase`, `git reset`, `git branch -D`/`-d`,
`git worktree`, `git push --force-with-lease` and `ln -s` (the
rebase-conflict recovery step needs both specifically), `git
merge-base`/`merge-tree`, `cp`, `mkdir`, `sed -i`, and a scratch-scoped
`rm -rf`, so this skill (and anything else running in the
repo) does not stop for them. That grant is repo-wide and persists between
runs — a deliberate tradeoff the user made, not one scoped to a single
invocation or to only the commands this skill happens to use.

## 4. Live checks

Tests do not carry every claim. For each item the plan marked as needing a
driven run, do it on the merged (or about-to-merge) branch with
`MOSAIC_GPU=1`, reusing an agent worktree that still has `node_modules` and a
fresh `dist/`. Traps that cost a run each in the worked example:

- `afterRebuild` on an action that schedules nothing (setting a value it
  already has) waits its full timeout.
- `settledAfterRebuild` hangs while `#btn-export` is legitimately disabled,
  which it is before any artwork loads. Load artwork first, then change the
  part. `run-app`'s SKILL.md names the general rule for the button's
  _enabled_ case (staying enabled is not a settled-rebuild signal; wait on
  `#loading-overlay` instead) — the disabled case here is the same
  unreliable signal from its other side, not something run-app already
  states.
- An assertion written from the _old_ behaviour's symptom ("identical at
  Detail 0/50/100") can fail against correct new behaviour. Read the output
  before calling the app wrong.

## 5. The measurement report

When the last PR is merged, write
`docs/findings/<date>-round-trip-measurement.md` pinned to the PR numbers,
with the same tables as the 2026-08 process review (recover it with
`git show d61529b^:docs/process-review-2026-08.md`): rounds per PR, per-round
corrections with cause codes copied from the PR bodies, a cause tally against
the baseline (11 code PRs #229-#243: mean ~4.6 rounds; FIX ~30, GATE ~12,
DOC ~12, NUM ~10, VAC ~9, CTX 5, PIPE 3, DIAG 3; SCOPE on 4 PRs), and which
levers each PR applied. **TASTE has no baseline counterpart** — the
original review didn't track "found, judged not worth fixing" as its own
code, so tally TASTE rows separately rather than folding them into any
baseline bucket, and say so in the report rather than silently comparing two
different taxonomies. The baseline's VIS row (0, since #229-#243 all merged
within minutes with no human look) is not expected to reappear here either:
this campaign's PRs get a human look before merge, which VIS measured the
absence of. First line states whether the round-count and cause-tally
numbers moved. Include the null results and anything a live check caught
that review did not. Pull the
bodies with `gh pr view <n> --json body`; the report cites that command.
Docs-only, so it ships without `/code-review`, but it still goes through
`ship-it` and a PR.

## 6. Cleanup

- Every agent worktree removed, every `worktree-agent-*` and merged
  `fix/*` local branch deleted, `git worktree prune`.
- Scratch worktrees under the scratchpad removed.
- `git pull --ff-only origin main` in the main checkout.
- Leave worktrees you did not create alone unless the user says otherwise.
- **`rm` only the specific paths this run created** (its own agent worktree
  dirs, its own `rb<n>` scratch worktrees), never a bare wildcard sweep of
  the whole scratchpad or tmp root. `.claude/settings.json`'s `rm -rf`
  allowlist is scoped to this project's tmp root, one level above the
  per-session UUID directory — wide enough to reach a concurrent session's
  entire scratch tree, not just this run's.
