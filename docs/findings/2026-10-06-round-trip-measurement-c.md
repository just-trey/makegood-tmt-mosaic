# Round-trip measurement: batch C export-feedback campaign (2026-10-06)

**Rounds are flat against the last campaign and down against the 2026-08
baseline; the cause tally collapsed to two corrections.** Mean rounds per PR
is 3.0 (3 PRs, #365-#367, 9 rounds) against ~4.6 (11 PRs, #229-#243), so down.
Against 3.0 for 2026-10-05b it is equal, and against 3.25 for the earlier
2026-10-06 report (#355-#358) it is down. Corrections per PR are 0.67 against
5.5, 3.0, 5.2 and 1.0. The only codes are PIPE (1) and VIS (1); FIX, DOC,
NUM, VAC, HARD, GATE and CTX are all 0. Three PRs: a small sample, not a trend.

Covers #365, #366, #367 (all merged 2026-10-07, 02:39Z-03:13Z). PR round
tables pulled with `gh pr view <n> --json body,title,mergeCommit,mergedAt` for
`n` in 365-367. Same-day report: `docs/findings/2026-10-06-round-trip-measurement.md`
(#355-#358), the format model and baseline source.

## 1. Rounds per PR

| PR       | Agent         | What                                                      | Rounds                 |
| -------- | ------------- | --------------------------------------------------------- | ---------------------- |
| #365     | sonnet-medium | Clear a stale raster load warning on the next good load   | 2                      |
| #366     | sonnet-medium | Say what an export saved, and why Export is off           | 4                      |
| #367     | sonnet-medium | Leave a standing warning when a part's file fails to load | 3                      |
| **Mean** |               | **3 PRs**                                                 | **3.0** (9 rounds / 3) |

- Same counting basis as the earlier reports: the clean final round is its own
  row. The baseline left clean final rounds out, so 3.0 understates the drop.
- #366's 4: round 1 (`medium`), the `low` prose pass, the live check, round 2
  (`low`, that change only). #367's 3: round 1 (`medium`), round 2 (`low`),
  round 3 (`low`, clean). #365's 2: round 1 (`medium`), the `low` prose pass.
- #367's body has no separate prose-pass row. Its round 1 notes were comment
  accuracy, so the prose pass looks folded into round 1; the body does not say.
- Agent column is inferred from the round-1 level (`medium` is
  `sonnet-medium`). All three are `src/ui/`, state plumbing or `src/app/` work.

## 2. Corrections per round

| PR   | Round               | Correction                                                                                                                                             | Layer     | Cause | Introduced by previous fix? |
| ---- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ----- | --------------------------- |
| #365 | 1 (medium)          | none                                                                                                                                                   | -         | -     | -                           |
| #365 | 2 (low, prose)      | none                                                                                                                                                   | -         | -     | -                           |
| #366 | 1 (medium)          | none; two low notes not applied (unexpected-throw hint stays generic, status clears on any rebuild)                                                    | -         | -     | -                           |
| #366 | 2 (low, prose)      | Declined: say "preview" instead of "rebuild"; "rebuild" is shipped copy                                                                                | -         | TASTE | No                          |
| #366 | 3 (live check)      | Status line wrapped its unit onto its own line (`3.0` / `MB`) at the default panel width; joined with a non-breaking space                             | behaviour | VIS   | No                          |
| #366 | 4 (low, one change) | none                                                                                                                                                   | -         | -     | -                           |
| #367 | 1 (medium)          | none needed; two low notes on comment accuracy, body codes them DOC                                                                                    | -         | -     | -                           |
| #367 | 2 (low)             | #365's `clearWarnings()` on raster load (and the existing SVG one) would drop a push-once missing-part warning; now re-stated per rebuild, with a test | behaviour | PIPE  | No                          |
| #367 | 3 (low)             | none                                                                                                                                                   | -         | -     | -                           |

- #366's round numbers are the order the rows ran. The body labels them
  "1", "prose", "live check", "2".
- #367's round 2 was relayed by the orchestrator before review ran, not found
  by `/code-review`. The body carries PIPE and "orchestrator-reported". It is
  tallied PIPE, not VIS, because the orchestrator read two PRs' diffs together
  rather than a PR's own contents. It is a cross-PR interaction: #365 and #367
  ran in parallel worktrees, and neither review could see the other's change.
- #367's round 1 DOC is excluded from the tally: the body says "None needed".
- #366's live check is counted as a round because it found a defect that
  review had passed. The body codes it VIS.

## 3. Cause tally

Counted per applied correction row. TASTE excluded (§4).

| Code                    | This campaign | 2026-10-06 (#355-#358) | 2026-10-05b | Baseline (#229-#243) |
| ----------------------- | ------------- | ---------------------- | ----------- | -------------------- |
| FIX                     | 0             | 1                      | 1           | ~30                  |
| DOC                     | 0             | 6                      | 3           | ~12                  |
| NUM                     | 0             | 3                      | 3           | ~10                  |
| VAC                     | 0             | 1                      | 2           | ~9                   |
| PIPE, SCOPE, DIAG       | 1             | 3                      | 0           | ~10                  |
| CTX                     | 0             | 0                      | 1           | 5                    |
| GATE, HARD              | 0             | 5                      | 0           | ~14                  |
| VIS                     | 1             | 3                      | 2           | 0                    |
| **Total (excl. TASTE)** | **2**         | **22**                 | **12**      | not totaled          |

- Per-PR codes: #365 0, #366 1, #367 1.
- Within the PIPE/SCOPE/DIAG row: PIPE 1 (#367), SCOPE 0, DIAG 0.
- Corrections caused by the previous round's own fix: **0 of 2**.
- Behaviour-layer corrections: 2 (#366 VIS, #367 PIPE). Prose-layer: 0.
- Both are defects no code review could have found from the diff alone: one
  needs a rendered panel, one needs another PR's change.
- "Moved vs baseline": every per-code count is at or below baseline, but 2
  corrections cannot say a code stopped happening.

## 4. TASTE

**1 item tagged TASTE**, no baseline counterpart; tallied on its own per the
fix-campaign skill step 5.

- #366: "preview" suggested over "rebuild" in the disabled-Export reasons.
  Declined: "rebuild" is the word the overlay and help panel already ship.

## 5. VIS

- **One VIS catch, by a live check, not review.** #366's status line broke
  `3.0 MB` across two lines at the default panel width. The agent's headless
  Playwright run (all 5 cases pass after the fix) saw it; both `/code-review`
  rounds and the prose pass had passed the string. Fixed in a follow-up
  round with a non-breaking space, and that change got its own `low` review
  (clean).
- Size display uses binary megabytes: the 144,044,105-byte chair file shows
  "137.4 MB". Left as is.
- No orchestrator-read VIS this time: all three PRs touched code and had
  `/code-review`, and none was docs-only.

## 6. Score per PR

Behaviour corrections = behaviour-layer corrections with a real cause
(excludes TASTE and clean rows). Defects closed = tech-debt defects the PR
fixed, counted from the body and
`git show <merge-sha> -- docs/tech-debt.md`: one per distinct defect the diff
removed. Sections opened = `git show <merge-sha> -- docs/tech-debt.md | grep '^+## '`.

| PR        | Behaviour corrections | Defects closed | Sections opened | Fixed inline | Behaviour rounds | Prose rounds |
| --------- | --------------------- | -------------- | --------------- | ------------ | ---------------- | ------------ |
| #365      | 0                     | 1              | 0               | 0            | 1 (clean)        | 1 (clean)    |
| #366      | 1                     | 2              | 0               | 0            | 3 (1 VIS)        | 1 (TASTE)    |
| #367      | 1                     | 1              | 0               | 0            | 3 (1 PIPE)       | 0            |
| **Total** | **2**                 | **4**          | **0**           | **0**        | 7                | 2            |

- Behaviour rounds are code-review passes plus #366's live check; prose
  rounds are the prose-only passes. The two columns sum to 9.
- **#365: 1 defect**, the stale "No opaque pixels" warning after a good raster
  load. Removed the raster clause from the section's "Closing it" line; the
  section stayed.
- **#366: 2 defects**, the two bullets removed: a finished export said nothing,
  and `#export-hint` read the same enabled or disabled. Section narrowed to the
  failed-part bullet. It also changed behaviour: Export is now disabled when no
  color lands on the part. It used to save a file with none of the design.
  That is a deliberate change, not a defect fix, and the body flags it.
- **#367: 1 defect**, the failed-part bullet. It was the last bullet, so the
  section "A finished export says nothing, and a disabled Export gives no
  reason" was deleted. `grep -n '(above)\|(below)\|finished export\|disabled Export' docs/tech-debt.md`
  on this branch finds no pointer left to it.
- `docs/tech-debt.md` went down by 1 section (#367 removed it; #365 and #366
  edited in place). Reproduce with `git show 7c647b0^:docs/tech-debt.md | grep -c '^## '`
  against `git show e7c87a7:docs/tech-debt.md | grep -c '^## '`.
- Closed, not narrowed: the section is gone. #365 and #366 each narrowed it.

## 7. Levers applied

| Lever                        | #365         | #366 | #367 |
| ---------------------------- | ------------ | ---- | ---- |
| Test failing on `main` shown | yes          | yes  | yes  |
| Mutation run                 | not reported | yes  | yes  |
| Numbers cite their command   | yes          | yes  | yes  |
| State sketch in body         | yes          | yes  | yes  |
| Live check                   | none         | yes  | yes  |

- #365: failing proof is `npx vitest run tests/artworkPanelRasterLoad.test.ts`
  with the `src/ui/artworkPanel.ts` change absent (`expected true to be false`).
  The body reports no mutation run, though the brief asks for one per new
  clear.
- #366: 6 new cases fail on `main`
  (`npx vitest run tests/exportPanel.test.ts tests/rebuild-scene.test.ts`). 5
  mutants, each failing 1 of 59 tests.
- #367: `tests/failed-part-warning.test.ts` 5 cases; on `main` 2 fail and 3
  pass vacuously. 3 mutants (no retract fails 2, no re-warn on rollback fails 1,
  no quiet guard fails 2). `rebuild-scene` test fails with the rebuild call
  removed.
- Live checks: #366 headless Playwright, 5 cases pass. #367 5 cases pass, and
  confirmed the chair exports 12 of 13 parts with the warning shown.
- The trap-file lever is not reported in the bodies; not scored.

## 8. Process misses and null results

- **Brief error, not a defect (#367).** The brief assumed a chair switch rolls
  back and so would leave a failed part. The live check showed the dropdown
  uses the non-quiet path; rollback is restore-only. The shipped code matches
  the real behaviour.
- **Cross-PR trap (#365 into #367).** #365's `clearWarnings()` on raster load
  would have removed #367's push-once warning. Neither PR's review could see
  it. The orchestrator relayed it before #367's round 2. The brief's `push()` rule
  covered the upsert, not callers that clear.
- **Flaky test.** `tests/build-worker.test.ts` "answers a cancel at once,
  honoured, and reuses the worker once it has stopped" failed once under
  `npm run test:coverage` in both the #366 and #367 runs and passed on rerun
  both times. #366's body records it ("passed alone and on rerun"); #367's
  does not. Not investigated here; filed in `docs/tech-debt.md` as unmeasured.
- **#365 ran no live check** and reported 0 behaviour corrections. It
  changes one `clearWarnings()` call.
- **No orchestrator-ran live check.** The live checks above are the workers'.
- Orchestrator facts (the live-check results, the cross-PR relay, the flake
  count) are the orchestrator's account, not reproducible by command.

## 9. Sources

- PR bodies: `gh pr view <n> --json body,title,mergeCommit,mergedAt` for `n` in
  365-367. Merge SHAs: #365 `7c647b0`, #366 `e0a57d0`, #367 `e7c87a7`.
- Baseline: `git show d61529b^:docs/process-review-2026-08.md`.
- Earlier figures: `docs/findings/2026-10-06-round-trip-measurement.md`,
  `docs/findings/2026-10-05-round-trip-measurement-b.md`.
- Section counts and defects: `git show <merge-sha> -- docs/tech-debt.md`.
