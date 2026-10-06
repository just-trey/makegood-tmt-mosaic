# Round-trip measurement: mixed UI and geometry fix campaign (2026-10-05b)

**Round counts held near last campaign's level and rose against the same-day
one; the cause tally is small and shifted toward NUM and VAC.** Mean rounds
per PR is 3.0 (4 PRs, #348-#351, 12 rounds) against 2.3 for the earlier
2026-10-05 campaign, 2.9 for 2026-09-24 and the 2026-08 baseline's ~4.6
(11 PRs, #229-#243). Corrections per PR are 3.0 against 5.2 (2026-09-24) and
1.0 (earlier 2026-10-05). Four PRs, two of them `opus-high` geometry items:
a small sample, not a trend.

Covers #348, #349, #350, #351 (merged 2026-10-05; #351 at 03:04Z on
2026-10-06). PR round tables pulled with `gh pr view <n> --json body` for `n`
in 348-351. The earlier campaign of the same day is
`docs/findings/2026-10-05-round-trip-measurement.md` (#344-#346).

## 1. Rounds per PR

| PR       | Agent         | What                                                       | Rounds                   |
| -------- | ------------- | ---------------------------------------------------------- | ------------------------ |
| #348     | sonnet-medium | `export-chair-examples` reaches 4 filaments without Fill   | 3                        |
| #349     | opus-high     | Name a dropped color on a capped trace and at full Detail  | 3                        |
| #350     | opus-high     | Absorb what breaking a checkerboard splits under despeckle | 3                        |
| #351     | sonnet-medium | `measure-cut-width` on empty-hole and no-overlap sidecars  | 3                        |
| **Mean** |               | **4 PRs**                                                  | **3.00** (12 rounds / 4) |

- Same counting basis as 2026-09-24 and the earlier 2026-10-05: the clean
  final round is its own row, and several corrections in one review pass are
  one round (#349 and #350 list 7 table rows each over 3 rounds).
- The baseline left clean final rounds out, so 3.0 understates the drop
  against 4.6.
- Round 1 levels: `high` on the two `opus-high` PRs, `medium` on the two
  `sonnet-medium` PRs, `low` for later rounds and the prose pass.

## 2. Corrections per round

| PR   | Round            | Correction                                                                               | Layer     | Cause    | Introduced by previous fix? |
| ---- | ---------------- | ---------------------------------------------------------------------------------------- | --------- | -------- | --------------------------- |
| #348 | 1 (medium)       | none                                                                                     | -         | -        | -                           |
| #348 | 2 (low, prose)   | Header comment line left unwrapped                                                       | prose     | DOC      | No                          |
| #348 | 3 (orchestrator) | `verify-new-bed-size` skill still said "4-filament test SVG filled" (Fill-based)         | prose     | VIS      | No                          |
| #349 | 1 (high)         | Bench labelled any unmatched notice "full Detail"                                        | behaviour | NUM      | No                          |
| #349 | 1 (high)         | Restore test's "not capped" check matched the 0-dropped text only                        | behaviour | VAC      | No                          |
| #349 | 1 (high)         | Troubleshooting said no Detail recovers a capped color, from one fixture                 | prose     | NUM      | No                          |
| #349 | 1 (high)         | "4 of 190" didn't say the bench samples only Detail 50 and 100                           | prose     | CTX      | No                          |
| #349 | 1 (high)         | Test comment narrated the change                                                         | prose     | DOC      | No                          |
| #349 | 2 (low)          | none                                                                                     | behaviour | -        | -                           |
| #349 | 3 (low, prose)   | none                                                                                     | prose     | -        | -                           |
| #350 | 1 (high)         | Fallback recoloured the smallest component in a checkerboard, unbounded in size; removed | behaviour | FIX      | No                          |
| #350 | 1 (high)         | The only test reaching that fallback didn't check other shapes kept their colour         | behaviour | VAC      | No                          |
| #350 | 1 (high)         | Docstring over 4 lines, stale bench comment, CHANGELOG corpus claim with no command      | prose     | DOC, NUM | No                          |
| #350 | 2 (low)          | none                                                                                     | behaviour | -        | -                           |
| #350 | 3 (low, prose)   | none                                                                                     | prose     | -        | -                           |
| #351 | 1 (medium)       | none                                                                                     | -         | -        | -                           |
| #351 | 2 (low, prose)   | none                                                                                     | -         | -        | -                           |
| #351 | 3 (orchestrator) | Edited the pinned findings report `2026-09-08-cut-region-width.md`; reverted             | prose     | VIS      | No                          |

- #348's and #351's orchestrator rows are tagged VIS here (a human read caught
  them). Their PR bodies carry DOC and CTX respectively. #351's cause is the
  orchestrator's own brief, which told the agent to edit a pinned report
  against `docs/CLAUDE.md`.
- #350's third row carries two codes (DOC, NUM); the tally counts each.

## 3. Cause tally

Counted per correction row code. TASTE excluded (§4).

| Code                    | This campaign | 2026-09-24 | Earlier 2026-10-05 | Baseline (#229-#243) |
| ----------------------- | ------------- | ---------- | ------------------ | -------------------- |
| FIX                     | 1             | 18         | 0                  | ~30                  |
| DOC                     | 3             | 34         | 2                  | ~12                  |
| NUM                     | 3             | 16         | 0                  | ~10                  |
| VAC                     | 2             | 8          | 0                  | ~9                   |
| PIPE, SCOPE, DIAG       | 0             | 15         | 0                  | ~10                  |
| CTX                     | 1             | 1          | 0                  | 5                    |
| GATE, HARD              | 0             | 2          | 0                  | ~14                  |
| VIS                     | 2             | 0          | 1                  | 0                    |
| **Total (excl. TASTE)** | **12**        | **94**     | **3**              | not totaled          |

- Per PR: 3.0 corrections now, 5.2 on 2026-09-24, 1.0 earlier today.
- Corrections caused by the previous round's own fix: **0 of 12**.
- Behaviour-layer corrections: 4 (NUM, VAC in #349; FIX, VAC in #350). Both
  `sonnet-medium` PRs had none. The other 8 are prose.

## 4. TASTE

**6 items tagged TASTE**, no baseline counterpart (the 2026-08 review never
coded it); tallied on its own per the fix-campaign skill step 5.

- #349: 4, listed under its table as not applied. "Even at full Detail" at
  Detail 95; the no-remedy notice against ui-conventions #3; the capped remedy
  wording; inlining `rasterLostColors`.
- #350: 2 table rows. A per-speck sort in the main despeckle path (reverted to
  the linear scan); a fix inside `deChecker` and an extra labelling pass (kept
  out; the latter measured at +1.2% trace time).

## 5. VIS

- **Both VIS rows are prose the orchestrator read and `/code-review` did not
  cover.** Docs-only and prose-only rows reach `main` only through this read.
- #348: `.claude/skills/verify-new-bed-size/SKILL.md` still described a
  Fill-based 4-filament test SVG after the script stopped using Fill.
- #351: the brief told the agent to update the pinned findings report. The
  rule is in `docs/CLAUDE.md` ("A report is pinned to its run and never edited
  to stay current"). The edit was reverted. Cause is CTX in the brief, not
  the agent.
- #349's full-Detail notice offers no remedy, a judgment against
  ui-conventions #3: no measured rule says when a bigger size lowers the
  floor, so no constant was invented. Surfaced to the user and merged as is.
  Not a VIS correction; recorded because it was a human-level call.

## 6. Score per PR

Defects closed = behaviour-layer corrections with a real cause (excludes
TASTE and clean rows). Sections opened =
`git show <merge-sha> -- docs/tech-debt.md | grep '^+## '`.

| PR        | Defects closed | Sections opened | Fixed inline | Behaviour rounds | Prose rounds      |
| --------- | -------------- | --------------- | ------------ | ---------------- | ----------------- |
| #348      | 0              | 0               | 0            | 1 (clean)        | 2 (1 DOC, 1 VIS)  |
| #349      | 2              | 1               | 1            | 2 (1 NUM, 1 VAC) | 1 (3 corrections) |
| #350      | 2              | 1               | 0            | 2 (1 FIX, 1 VAC) | 1 (1 DOC, 1 NUM)  |
| #351      | 0              | 0               | 0            | 1 (clean)        | 2 (1 VIS)         |
| **Total** | **4**          | **2**           | **1**        | 6                | 6                 |

- #349's inline fix: the `artworkListPanel` test's load helper copied the
  notice logic by hand and had gone stale; it now calls `announceTrace`. No
  PR body labels a second defect, so this is the orchestrator's reading.
- #349 and #350 each **narrowed their tech-debt section** instead of closing
  it. #348 and #351 closed theirs. `docs/tech-debt.md` went from 29 to 27
  sections (`git show b418289^:docs/tech-debt.md | grep -c '^## '` and
  `grep -c '^## ' docs/tech-debt.md` on `0b3358c`): 4 removed, 2 added.
- Sections opened: #349, "Raise Detail" on a dropped-color notice can lead
  nowhere (a measurement owed); #350, a `deChecker` split can stay under the
  despeckle floor when every label makes a checkerboard.
- #351 added an optional sidecar path argument to the script, noted in its
  body as unasked but needed to show the failures.
- Round 1 of #349 and #350 mixes both layers; prose rows are counted in the
  prose column, so the columns do not sum to 12.

## 7. Levers applied

| Lever                        | #348 | #349 | #350 | #351 |
| ---------------------------- | ---- | ---- | ---- | ---- |
| Test failing on `main` shown | yes  | yes  | yes  | yes  |
| Mutation run                 | yes  | yes  | yes  | yes  |
| Numbers cite their command   | yes  | yes  | yes  | yes  |
| Measured on real input       | yes  | yes  | yes  | yes  |

- #348's failing proof is the script's own failure on `main`
  (`page.selectOption: Timeout 30000ms exceeded`); its mutation is
  `STRIPE_MM` set to 600. Its real measurement is a full four-export run.
- #349 and #350 measured on `scripts/bench-raster.ts` with the gitignored
  `stubs/` corpus; #350 had 11 of 19 sources in its worktree.
- #351's real input is the shipped sidecar plus the `fdada8b` one.
- The trap-file and state-sketch levers are not reported in the bodies; not
  scored.

## 8. Process misses (not in the round tables)

- **#350 rebased onto #349 by the orchestrator.** Only `CHANGELOG.md`
  conflicted; `scripts/bench-raster.ts` auto-merged and the cap bench still
  reported 0 rows under the floor.
- **`--no-verify` on #350.** The agent committed with it to dodge the
  lint-staged stash race the shared brief warns about.
- **Brief error.** #351's brief contradicted `docs/CLAUDE.md` (§5).
- **Stale prose outside the diff.** #348's skill-file drift (§5) is the same
  shape as #268's orphaned `(above)`: no code reviewer reads it.

## 9. Null results and live checks

- **Live checks: none driven in this campaign.** The user runs them manually,
  so there is no result to compare with review.
- **#349's capped arm never fires on the corpus.** 2 rows cap, both with 0
  dropped; the capped-with-a-color-dropped case has 0 rows
  (`node_modules/.bin/vite-node scripts/bench-raster.ts dropped`, per its
  body). That fix is tested on a fixture only.
- **#350 changed no corpus output.** 0 of 22 rows differ; `cap` rows under
  the floor went 2 of 24 to 0 of 24. The corpus rarely hits the case it fixes.
- **Narrowed, not closed:** #349 and #350 (§6).
- Orchestrator facts in §5, §8 and the live-check line are the
  orchestrator's account, not reproducible by command.

## 10. Sources

- PR bodies: `gh pr view <n> --json body,mergeCommit` for `n` in 348-351.
  Merge SHAs: #348 `b418289`, #349 `8ef43b0`, #350 `a97e464`, #351 `0b3358c`.
- Baseline: `git show d61529b^:docs/process-review-2026-08.md`.
- Earlier figures: `docs/findings/2026-09-24-round-trip-measurement.md`,
  `docs/findings/2026-10-05-round-trip-measurement.md`.
- Section counts: `git show <merge-sha> -- docs/tech-debt.md`.
