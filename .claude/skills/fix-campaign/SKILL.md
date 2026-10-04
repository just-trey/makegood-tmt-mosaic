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

The 2026-08-28 run (#259, #260, #261; #257 landed from a stale worktree) is the
worked example. Its measurement report lands at
`docs/findings/<date>-round-trip-measurement.md` per step 5 once the last PR
merges; check `docs/findings/` for the actual filename.

## 0. Before briefing anyone

- `git fetch origin && git log --oneline main..origin/main`. Another session
  may be merging into `main` at the same time. Brief against `origin/main`.
- `git worktree list` and `gh pr list`. **A stale worktree with uncommitted
  docs and tests for your item means someone got there first.** In the worked
  example, item 6 shipped as #257 from such a worktree while agent E was
  re-implementing it. If work exists, finish that branch instead of starting a
  new one.
- Plan mode first. The plan names, per item: the tech-debt section, the
  branch, the files, the trap file to read first, and the test that must be
  shown failing on `main` — plus the agent, model, effort, and review level
  from this table:

  | Item kind                                                | Agent (`.claude/agents/`) | Model  | Effort | Code rounds                 | Prose pass                    |
  | -------------------------------------------------------- | ------------------------- | ------ | ------ | --------------------------- | ----------------------------- |
  | `src/geometry/`, `src/export/`, placement                | `opus-high`               | Opus   | high   | first `high`, later `low`   | one, `low`, at the end        |
  | `src/ui/`, state plumbing, config                        | `sonnet-medium`           | Sonnet | medium | first `medium`, later `low` | one, `low`, at the end        |
  | docs, one fixed target                                   | `sonnet-medium`           | Sonnet | medium | none                        | one, `low`                    |
  | docs, judgment per section (triage, moving measurements) | `sonnet-high`             | Sonnet | high   | none                        | none; orchestrator read (VIS) |

  Why: effort is only settable in an agent definition; otherwise every
  subagent inherits the user's global `effortLevel`. `low` returns fewer,
  high-confidence findings. Pass the level explicitly every time —
  `/code-review` reuses the last level typed.

- `.claude/agents/` definitions load only at session start, so one written
  mid-session is not spawnable (`Agent type 'sonnet-medium' not found`,
  measured 2026-08-29). Write or check the three agent files before starting the
  campaign session; if one is missing mid-run, fall back to `general-purpose`
  with `model` passed (inherits the global effort).

## 1. The brief

Write one shared brief to the scratchpad and one per-item prompt that starts
"Read <brief> first". The shared brief carries the rules the agents kept
needing:

- Worktree: `npm install` first (tests pass without it, `vite`/`smoke` fail
  with a misleading Manifold error). **Never `git stash`** (shared across
  worktrees). The repo's lint-staged pre-commit hook also backs up via
  `git stash`, so workers committing at once can race (wave 1, #322-#324):
  stagger commits or have workers report before committing. Rename the branch
  to the one the plan names. Do not remove the worktree; the orchestrator does.
- Triage a second defect found on the way: **fix in the same PR** when it's in
  a file the PR already touches, the fix is small (a regex branch, a list
  entry, a missing clear), and it gets its own failing test and CHANGELOG
  bullet. **Own tech-debt section** only when it needs a decision, a
  measurement, or a different area of the code. #262's uppercase `E` exponent
  and its `S`/`T`-after-arc promotion should have been fixed inline: each was
  a one-line fix that became a 24- and 31-line section (`docs/tech-debt.md`,
  "The path `d` tokenizer rejects an uppercase `E` exponent" and "An `S`/`T`
  after an arc…"; `grep -n '^## ' docs/tech-debt.md` for the boundaries).
- Levers, so the report can score them: test first and shown failing on
  `main`; mutation run for every new guard/clear/dismiss; state sketch in the
  PR body before the first edit (anything touching warning lifecycle or
  persistence); every number cites its command; read the named trap file; cut
  the area on the second repeat.
- **Prose is reviewed once, at the end, never per round.** Code rounds review
  the code diff, at the levels the step 0 table names. A DOC/NUM/CTX finding on
  comments, CHANGELOG, tech-debt, troubleshooting or the PR body is applied
  without a new round. After the last clean code round, one `low` pass over the
  prose; apply, ship. #270 ran ten rounds, of which 2-10 were all prose with
  the code correct after round 1; #269's rounds 7-8 were the same; #264 took 15
  rounds on 3 files. `push()` in `src/warnings.ts` replaces a standing keyed
  entry in place and skips an unkeyed one already present; don't swap in a new
  object or widen it to unkeyed entries (three reverted rounds, now pinned by
  tests/warnings.test.ts, tests/warningsView.test.ts and the capped/traced test
  in tests/artworkListPanel.test.ts).
- **Run the gate chain in the foreground** — `ship-it`, vitest, and the CI
  watch each as a foreground Bash call with a 600000 timeout, never as a
  background task you then wait on. 3 of 5 agents stalled on this in the
  2026-08-28 campaign, 3 of 4 in 2026-08-29. Step 2 covers recovery.
- `ship-it`, then `gh pr create` with a `## Rounds` table: one row per review
  round including the clean final one, columns Round / Correction / Layer /
  Cause code / Introduced by previous round's fix?. Layer is `behaviour`
  (shipped code) or `prose` (comments, CHANGELOG, tech-debt, troubleshooting,
  PR body) — #270's author added it unprompted, and it is the only reason its
  prose-heavy rounds were measurable. Cause codes: FIX VAC NUM DOC PIPE CTX
  SCOPE DIAG HARD GATE TASTE VIS (VIS: caught by a human looking at the PR, not
  by `/code-review` — step 5 tallies this one specifically).
- **Before deleting a tech-debt section, grep the file for what points at it**:
  `(above)`, `(below)`, the section's title words, and any count it contributed
  to a surviving section. #268 orphaned an `(above)` and left four counts
  stale; #260 and #270 hit the same shape.
- **Rebase onto `origin/main` before pushing.** Every PR touches
  `CHANGELOG.md`'s Fixed list and `docs/tech-debt.md`; the first to merge
  conflicts with all the others.
- **Draft the PR body in a worktree-local path, not the shared scratchpad**: one
  agent's draft overwrote another's in the worked example. Any other scratch file
  goes in the agent's own subdirectory (`<scratchpad>/<item>/`); in wave 1
  (#322-#324) one agent overwrote another's helper script mid-run.
- **Keep working until everything asked is done**; stop to ask only when
  blocked or before a risky step. Then stop and report. Don't add features,
  files, docs, refactors or tests nobody asked for; mention them at the end.
  The plan's failing-on-`main` test is asked for. Why: at low/medium effort
  Sonnet 5.5 checks in early and pads with extras.
- Do not watch CI. Report the PR URL and the Rounds table, then stop.

Spawn with `isolation: "worktree"`, `run_in_background: true`, `subagent_type`
set to the agent the step 0 table names. No subagent spawns subagents.

## 2. While they run

- **Agents pause on their own background tasks.** A report reading "waiting for
  the gate run" or "waiting for the CI watch" is an agent that will not wake on
  its own. `SendMessage` it: read the output file (or re-run in the foreground
  with a 600000 timeout), then continue. Happened to three of five in the worked
  example.
- **A text-only end of turn is a report, not proof the item is done.** Check it
  against the item's checklist. If items remain and no blocker is stated,
  `SendMessage` the worker naming the open items. After 2-3 such continuations,
  stop and surface it to the user. Why: Opus 5.5 sometimes ends a turn
  announcing the next step instead of taking it.
- Code-review sub-passes report to you as well as to the agent. Relay only a
  real trap (the `push()` upsert above, a rule the agent is about to break).

## 3. Merge on green, one at a time, as each lands

Do this per PR the moment its agent reports, without waiting for the others:

```bash
gh pr view <n> --json mergeable,mergeStateStatus -q '.mergeable+" "+.mergeStateStatus'
```

- `MERGEABLE` and checks pending: watch once, in the background, never a poll
  loop. Foreground `sleep` is blocked in this harness, so run the wait as one
  `run_in_background: true` Bash call. Same recipe as `ship-it`'s step 4 (the
  `--json name --jq length` check, not a plain-text grep, #124); read that step
  for the why:

  ```bash
  i=0
  until [ "$(gh pr checks <pr> --json name --jq length 2>/dev/null || echo 0)" -gt 0 ]; do
    i=$((i + 1))
    [ $i -ge 30 ] && { echo "no checks registered after 150s on #<pr>"; exit 1; }
    sleep 5
  done
  gh pr checks <pr> --watch --fail-fast
  ```

  **Every `gh pr checks` in this loop takes `<pr>`**, not just the trailing
  `--watch --fail-fast` call, or the registration check polls the wrong PR.

  Then `gh pr view <n> --json mergeStateStatus` must say `CLEAN` before
  `gh pr merge <n> --squash --delete-branch`. **`gh pr merge`'s allowlist entry
  isn't scoped to those flags** — `--admin` would bypass the CI-green gate this
  step just checked, and no permission-glob syntax can exclude one flag while
  allowing the rest. Never pass `--admin`; there is no mechanical guard. When an
  agent worktree still holds the branch, `--delete-branch` errors although the
  merge succeeded. Verify with `gh pr view <n> --json state`.

  **That error takes the remote branch down with it.** `--delete-branch` deletes
  local and remote together, so the local failure aborts both and the merged
  branch stays on `origin`, silently. Every campaign PR hits this, since the
  agent worktree still holds its branch at merge time. The 2026-08-30 run left
  all six of its branches on the remote; the same `fetch --prune` cleared ten
  more from earlier runs. Step 6 sweeps them, and it is not optional.

- `CONFLICTING`: rebase it yourself in a scratch worktree. The agent's worktree
  may hold the branch, so use a temp local name. **Fetch first** — `gh pr merge`
  is a remote call and never updates the local `origin/main` ref, so a rebase
  without a fresh fetch runs against the pre-merge tip and either misses the
  just-merged PR's content or reproduces the same conflict:

  ```bash
  git fetch -q origin
  S=<scratchpad>/rb<n>
  git worktree add -q -b rb<n>-tmp $S origin/<branch>
  ```

  **`cd "$S"` before every git/npm/node command in this recipe, not
  `git -C $S`.** Allow rules match a command's literal leading tokens, so
  `git -C <path> <cmd>` misses a plain `git rebase` or `git add` rule
  (`.claude/settings.local.json` carries a one-off exact-string entry for this
  gap). `cd` first and every later command matches.

  ```bash
  cd "$S" && git rebase origin/main
  ```

  Resolve `CHANGELOG.md` by keeping both sides' bullets. Resolve
  `docs/tech-debt.md` by dropping every heading of a section already closed on
  `main` and keeping headings the branch added. Symlink `node_modules` from the
  main checkout into `$S` now (`ln -s` the main checkout's `node_modules`,
  allowlisted): `npx prettier`, `node scripts/check-troubleshooting.mjs`, and
  the PR's own vitest command need it in a bare `git worktree add` checkout. Run
  all three, then `git add` both files (`rebase --continue` refuses unstaged
  resolutions), then `git rebase --continue`. **A branch with more than one
  commit touching these two files stops more than once**: after each
  `--continue`, check `git status` for "rebase in progress" and repeat until it
  reports a clean tree. Only then remove the `node_modules` symlink and
  `git push --force-with-lease origin rb<n>-tmp:<branch>` (`cd` back to the main
  checkout first, for the same allowlist reason), remove the scratch worktree,
  **delete the local `rb<n>-tmp` branch** (`git worktree remove` drops the
  directory, not the branch ref), re-arm the watch above.

- Right after a merge, GitHub reports the next PR `UNKNOWN` for ~30s, then
  `CONFLICTING`. That is expected: rebase it as above. Merges are therefore
  sequential; a second PR is never rebased until the first has merged.
- After the merge, remove that agent's worktree. Check first that its HEAD
  equals `origin/<branch>` (the agent may have uncommitted scratch). Locked
  worktrees need `git worktree unlock` before `remove`.

`main` is protected, so `gh pr merge` is the only write to it. Invoking this
skill is the user's approval for every merge it performs, not a per-PR prompt.
The project's `.claude/settings.json` allowlists `gh pr merge`, `git rebase`,
`git reset`, `git branch -D`/`-d`, `git worktree`, `git merge-base`/`merge-tree`,
`cp`, `mkdir`, `sed -i`, a scratch-scoped `rm -rf`, and `ln -s` plus
`git push --force-with-lease` (the rebase-conflict recovery needs both). That grant is repo-wide and persists between runs, a deliberate
tradeoff the user made.

## 4. Live checks

Tests do not carry every claim. For each item the plan marked as needing a
driven run, do it on the merged (or about-to-merge) branch with `MOSAIC_GPU=1`,
reusing an agent worktree that still has `node_modules` and a fresh `dist/`.
Traps that cost a run each in the worked example:

- `afterRebuild` on an action that schedules nothing (setting a value it
  already has) waits its full timeout.
- `settledAfterRebuild` hangs while `#btn-export` is legitimately disabled,
  which it is before any artwork loads. Load artwork first, then change the
  part. `run-app` covers the button's _enabled_ case (wait on `#loading-overlay`
  instead); the disabled case is the same unreliable signal from the other side
  and isn't stated there.
- An assertion written from the _old_ behaviour's symptom ("identical at Detail
  0/50/100") can fail against correct new behaviour. Read the output before
  calling the app wrong.

## 5. The measurement report

When the last PR is merged, write `docs/findings/<date>-round-trip-measurement.md`
pinned to the PR numbers, with the same tables as the 2026-08 process review
(recover it with `git show d61529b^:docs/process-review-2026-08.md`): rounds per
PR, per-round corrections with cause codes copied from the PR bodies, a cause
tally against the baseline (11 code PRs #229-#243: mean ~4.6 rounds; FIX ~30,
GATE ~12, DOC ~12, NUM ~10, VAC ~9, CTX 5, PIPE 3, DIAG 3; SCOPE on 4 PRs), and
which levers each PR applied. **TASTE has no baseline counterpart** — the
original review didn't track "found, judged not worth fixing", so tally TASTE
rows separately and say so rather than comparing two different taxonomies. VIS
is the gate for docs-only PRs, which take no `/code-review` and otherwise reach
`main` unreviewed: #268 is the worked example, an orphaned `(above)` and four
stale counts caught only by the orchestrator read. Score each PR as defects
closed / sections opened / fixed inline / behaviour rounds / prose rounds — not
the tech-debt section count. First line states whether the round-count and
cause-tally numbers moved. Include the null results and anything a live check
caught that review did not. Pull the bodies with `gh pr view <n> --json body`;
the report cites that command. Docs-only, so it ships without `/code-review`,
but still goes through `ship-it` and a PR.

## 6. Cleanup

- Every agent worktree removed, every `worktree-agent-*` and merged `fix/*`
  local branch deleted, `git worktree prune`.
- Scratch worktrees under the scratchpad removed.
- **Every merged branch deleted from `origin`, then `git fetch --prune`.**
  Step 3's `--delete-branch` did not do it (see the note there), and nothing
  else in this skill removes them. Delete a branch only after confirming its PR
  actually merged:

  ```bash
  for b in <the campaign's branches>; do
    n=$(gh pr list --state merged --head "$b" --json number -q '.[0].number')
    [ -n "$n" ] && git push origin --delete "$b" && echo "deleted $b (#$n)"
  done
  git fetch --prune origin
  ```

  `--state merged` is the guard that matters: `--head` alone would also match an
  open PR, and `dead-zones` (PR #193, open since 2026-08-17) sits on the remote
  across every campaign waiting to be deleted by mistake.

- `git pull --ff-only origin main` in the main checkout.
- Leave worktrees you did not create alone unless the user says otherwise.
- **`rm` only the specific paths this run created** (its own agent worktree
  dirs, its own `rb<n>` scratch worktrees), never a bare wildcard sweep of the
  scratchpad or tmp root. `.claude/settings.json`'s `rm -rf` allowlist is scoped
  to this project's tmp root, one level above the per-session UUID directory —
  wide enough to reach a concurrent session's entire scratch tree.
