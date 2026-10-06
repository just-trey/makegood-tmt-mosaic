# Round-trip measurement: mixed UI and geometry fix campaign (2026-10-06)

**Round count rose slightly and the cause tally shifted to HARD.** Mean
rounds per PR is 3.25 (4 PRs, #355-#358, 13 rounds) against 3.0 for the
2026-10-05b campaign, 2.3 for the earlier 2026-10-05 one, 2.9 for 2026-09-24
and the 2026-08 baseline's ~4.6 (11 PRs, #229-#243). Corrections per PR are
5.5 against 3.0, 1.0 and 5.2. HARD (5) is new: the earlier 2026-10-05
campaigns had none, and all five sit in #358's geometry code and script. One
PR carries 13 of the 22 corrections. Four PRs, one of them a null result: a
small sample, not a trend.

Covers #355, #356, #357, #358 (all merged 2026-10-06, 04:54Z-05:53Z). PR round
tables pulled with `gh pr view <n> --json body,mergeCommit` for `n` in
355-358. Same-week reports:
`docs/findings/2026-10-05-round-trip-measurement-b.md` (#348-#351),
`docs/findings/2026-10-05-round-trip-measurement.md` (#344-#346).

## 1. Rounds per PR

| PR       | Agent         | What                                                        | Rounds                   |
| -------- | ------------- | ----------------------------------------------------------- | ------------------------ |
| #355     | sonnet-medium | Measure whether "Raise Detail" ever leads to a capped trace | 2                        |
| #356     | sonnet-medium | `check:zone-occlusion` inks the four zones it never reached | 3                        |
| #357     | opus-high     | Break a checkerboard at its bottom-left cell when stuck     | 3                        |
| #358     | opus-high     | Bound chair-body cut depth by the wall under it             | 5                        |
| **Mean** |               | **4 PRs**                                                   | **3.25** (13 rounds / 4) |

- Same counting basis as the earlier reports: the clean final round is its own
  row, and several corrections in one review pass are one round. An
  orchestrator read that found something is a round (#356 round 3, #358's two
  orchestrator rows sit inside its 5).
- #358's 5: round 1 (`high`), round 2 (`low`, clean), the `low` prose pass, the
  orchestrator's read, and round 3 (`low`, the script).
- The baseline left clean final rounds out, so 3.25 understates the drop
  against 4.6.
- Round 1 levels: `high` on the two `opus-high` PRs, `medium` on the two
  `sonnet-medium` PRs, `low` for later rounds and the prose pass.
- Agent column is from the plan; the round-1 level in each body matches it.

## 2. Corrections per round

| PR   | Round            | Correction                                                                                                                                         | Layer     | Cause      | Introduced by previous fix? |
| ---- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- | --------------------------- |
| #355 | 1 (medium)       | Doc said "one step (20)"; the slider steps by 5                                                                                                    | prose     | NUM        | No                          |
| #355 | 2 (low, prose)   | none                                                                                                                                               | -         | -          | -                           |
| #356 | 1 (medium)       | Overlong comment line; CHANGELOG code-span wrap (prettier-produced, kept as house style)                                                           | prose     | DOC        | No                          |
| #356 | 2 (low, prose)   | none                                                                                                                                               | -         | -          | -                           |
| #356 | 3 (orchestrator) | Comment and PR body cited counts from a deleted throwaway sweep; replaced with counts the check logs                                               | prose     | NUM, VIS   | No                          |
| #357 | 1 (high)         | Fallback no longer restores the bottom-right rewrite when both bottom cells strand a piece: no grid reached that branch, so no test could cover it | behaviour | VAC        | No                          |
| #357 | 1 (high)         | Tech-debt section narrowed instead of deleted                                                                                                      | prose     | DOC        | No                          |
| #357 | 1 (high)         | `deChecker` docstring trimmed back to its old length                                                                                               | prose     | DOC        | No                          |
| #357 | 1 (high)         | Declined: prefer a cell that splits nothing; it changes output on grids the old code handled                                                       | -         | SCOPE      | No                          |
| #357 | 1 (high)         | Declined: share `takeable` with despeckle's `makesChecker`; skip re-flooding; hoist closures                                                       | -         | TASTE      | No                          |
| #357 | 2 (low)          | none                                                                                                                                               | -         | -          | -                           |
| #357 | 3 (low, prose)   | PR body: uncommitted-harness timing table and an uncounted search claim dropped                                                                    | prose     | NUM        | No                          |
| #357 | 3 (low, prose)   | `breakChecker` docstring did not say "when that strands" meant the bottom-right rewrite                                                            | prose     | DOC        | No                          |
| #358 | 1 (high)         | Ray grid capped at 256 cells without growing the cell, so part of a dense mesh fell off the grid                                                   | behaviour | HARD       | No                          |
| #358 | 1 (high)         | Unclipped regions were wall-bounded, unlike the flat mapper                                                                                        | behaviour | PIPE       | No                          |
| #358 | 1 (high)         | A NaN ray could walk cells forever                                                                                                                 | behaviour | HARD       | No                          |
| #358 | 1 (high)         | Each new deepest setting re-sampled every chart; the cap now doubles                                                                               | behaviour | FIX        | No                          |
| #358 | 1 (high)         | Docstring over 4 lines; test comments narrated the change                                                                                          | prose     | DOC        | No                          |
| #358 | 1 (high)         | Cutter chord sag vs the 0.05 mm floor (unmeasured); depth warning staged before a cutter that may fail; both filed to tech-debt                    | prose     | SCOPE      | No                          |
| #358 | 2 (low)          | none                                                                                                                                               | -         | -          | -                           |
| #358 | 3 (low, prose)   | `pipeline.md` said the cap was the deepest setting; it doubles                                                                                     | prose     | DOC        | **Yes**                     |
| #358 | 4 (orchestrator) | Pre-existing: chair-wing-left's genus goes 0 to 4 at the default 1 mm depth, noticed and not filed; filed with a reproduce script                  | prose     | SCOPE, VIS | No                          |
| #358 | 5 (low, script)  | `scripts/measure-cut-genus.ts` crashed on an empty cut body                                                                                        | behaviour | HARD       | No                          |
| #358 | 5 (low, script)  | The same script crashed on a part with no build output                                                                                             | behaviour | HARD       | No                          |
| #358 | 5 (low, script)  | The same script passed an unparseable depth through as NaN                                                                                         | behaviour | HARD       | No                          |

- Row labels differ from the PR bodies where the body counts passes
  differently. #358's body labels the script review "round 3" and the
  orchestrator read "prose (coordinator)"; here they are rounds 5 and 4 in
  the order they ran. #356's round 3 is the same pass the body calls
  "coordinator".
- #356 and #358's orchestrator rows carry VIS here (a human read caught them).
  The bodies carry NUM and SCOPE. A row with two codes counts each.
- #358's script went unreviewed until the orchestrator asked: it was committed
  as the reproduce command for the genus section, after round 2 had returned
  clean. The `low` review then found the three HARD rows. This is a second VIS
  catch (the missing review, not the crashes) and is counted in §3 as a
  separate VIS.
- #357's declined SCOPE row is not an applied correction; it is excluded from
  the tally with the TASTE rows.
- #358's body also records two round-1 findings "judged no-change": the
  re-entry gap could swallow an exit just before a rib, and the plane test at
  knife edges (§4).

## 3. Cause tally

Counted per correction row code. TASTE and #357's declined SCOPE excluded
(§4).

| Code                    | This campaign | 2026-10-05b | 2026-09-24 | Earlier 2026-10-05 | Baseline (#229-#243) |
| ----------------------- | ------------- | ----------- | ---------- | ------------------ | -------------------- |
| FIX                     | 1             | 1           | 18         | 0                  | ~30                  |
| DOC                     | 6             | 3           | 34         | 2                  | ~12                  |
| NUM                     | 3             | 3           | 16         | 0                  | ~10                  |
| VAC                     | 1             | 2           | 8          | 0                  | ~9                   |
| PIPE, SCOPE, DIAG       | 3             | 0           | 15         | 0                  | ~10                  |
| CTX                     | 0             | 1           | 1          | 0                  | 5                    |
| GATE, HARD              | 5             | 0           | 2          | 0                  | ~14                  |
| VIS                     | 3             | 2           | 0          | 1                  | 0                    |
| **Total (excl. TASTE)** | **22**        | **12**      | **94**     | **3**              | not totaled          |

- Per PR: 5.5 corrections now, 3.0 on 2026-10-05b, 5.2 on 2026-09-24, 1.0
  earlier on 2026-10-05.
- Per-PR codes: #355 1, #356 3, #357 5, #358 13.
- Within the PIPE/SCOPE/DIAG row: PIPE 1, SCOPE 2 (both #358), DIAG 0.
- Corrections caused by the previous round's own fix: **1 of 22** (#358's
  `pipeline.md` DOC, prose).
- Behaviour-layer corrections: 8 (#357: 1 VAC; #358: 2 HARD, 1 PIPE, 1 FIX in
  round 1 and 3 HARD in the script review). The two `sonnet-medium` PRs had
  none. The other 14 codes are prose or process.
- HARD is a real cause here, not a catch-all: three of the five are one new
  script's crashes on inputs it was never run against.

## 4. TASTE

**3 items tagged TASTE**, no baseline counterpart (the 2026-08 review never
coded it); tallied on its own per the fix-campaign skill step 5.

- #357: 1 table row covering three declined suggestions. Share `takeable`
  with `makesChecker`; skip re-flooding a piece; hoist closures. The body says
  the data structures differ and the end-to-end cost is inside run-to-run
  spread.
- #358: 2, in prose under its table (not table rows): the re-entry gap that
  could swallow an exit just before a rib, and the plane test at knife edges.
- #357 also declined one SCOPE suggestion (prefer a cell that splits nothing)
  because it changes output on grids the old code handled. Not counted as
  TASTE.

## 5. VIS

- **Three VIS catches, all by an orchestrator read.** #356's prose and both
  of #358's. None is a `/code-review` finding.
- #356: the `IDENTITY_SWEEP` comment and the PR body cited counts from a
  throwaway wider sweep that was deleted and cannot be reproduced from the
  repo. The agent replaced them with counts the shipped check logs
  (`[vN/zone X]` lines). Code rule 4 (no claims without a measurement).
- #358, unfiled finding: the agent noticed chair-wing-left's genus changing
  from 0 to 4 at the default depth, a pre-existing defect, and did not file
  it. The orchestrator asked for its own tech-debt section and a committed
  reproduce script
  (`node_modules/.bin/vite-node scripts/measure-cut-genus.ts`).
- #358, unreviewed script: that script then reached the PR with no review
  pass until the orchestrator asked. The `low` review found 3 HARD defects in
  it (§2, round 5 rows).

## 6. Score per PR

Behaviour corrections = behaviour-layer corrections with a real cause
(excludes TASTE and clean rows). It is not a count of tech-debt defects fixed.

Defects closed = tech-debt defects the PR fixed. Counted from the PR body
(`gh pr view <n> --json body`) and its tech-debt diff
(`git show <merge-sha> -- docs/tech-debt.md`): one per distinct defect the
body says it closed and the diff removed. A narrowed section counts only the
defects it removed. A defect found on the way and fixed inline is the Fixed
inline column, not this one. A defect measured but not fixed, or found not to
reproduce, counts 0.

Sections opened = new sections the body names, checked against
`git show <merge-sha> -- docs/tech-debt.md | grep '^+## '`. A narrowed
section that was retitled shows as a `+##` line without being a new section.

| PR        | Behaviour corrections | Defects closed | Sections opened | Fixed inline | Behaviour rounds     | Prose rounds             |
| --------- | --------------------- | -------------- | --------------- | ------------ | -------------------- | ------------------------ |
| #355      | 0                     | 0              | 0               | 0            | 1 (clean)            | 1 (clean)                |
| #356      | 0                     | 1              | 0               | 1            | 1 (clean)            | 2 (1 clean, 1 NUM + VIS) |
| #357      | 1                     | 1              | 0               | 0            | 2 (1 VAC)            | 1 (1 NUM, 1 DOC)         |
| #358      | 7                     | 1              | 3               | 0            | 3 (4 in R1, 3 in R5) | 2 (1 DOC, 1 SCOPE + VIS) |
| **Total** | **8**                 | **3**          | **3**           | **1**        | 7                    | 6                        |

- Behaviour rounds are code-review passes; prose rounds are the prose-only
  passes after them (`low` prose pass, orchestrator read). Prose findings from
  a code round (#355, #356, #357 and #358 round 1) are listed in §2 under
  that round. The two columns sum to 13.
- **#355: 0 defects, a null result.** It measured and narrowed. 0 of 138
  "raise Detail" rows are capped with a color still dropped 20 points up
  (`node_modules/.bin/vite-node scripts/bench-raster.ts dropped-next`). A
  notice that knows the next step caps costs an extra trace per announce: 613
  traces averaged 363 ms. Cost with no measured benefit, so not built.
- #356: 1 defect, four zones the identity sweep never inked. Section deleted
  (the only pointer was a historical CHANGELOG line). Fixed inline: the 6 px
  step exposed 12 "picked null" failures on seam hairlines of other zones;
  fixed by sending identity nulls through the same `splitHairlines` excuse
  pass 1 uses. Measured in the body, not a separate bullet.
- #357: 1 defect, the hand-built grid the old section pinned. Section
  **narrowed and retitled** (`A deChecker break can still leave a piece under
the despeckle floor — no grid known`), not deleted. `grep '^+## '` shows 1
  but none is new.
- #358: 1 defect, the chair body has no depth bound. Section narrowed and
  retitled to sideways flat faces (the cut itself is wrong there whatever the
  depth). **3 sections opened**: the warped-floor sag margin, the depth
  warning before a failed cutter, and the left fender's genus change at the
  default depth. `grep '^+## '` shows 4; one is the retitled narrowing.
- #358's three opened sections are two findings from round 1 (SCOPE) and one
  pre-existing defect the orchestrator asked to be filed (VIS). None needed
  fixing in the same PR (different area or needs a measurement), so none counts
  as fixed inline.
- `docs/tech-debt.md` went from 27 to 29 sections
  (`git show 37abaf7:docs/tech-debt.md | grep -c '^## '` and
  `grep -c '^## ' docs/tech-debt.md` on `d52f1d4`): #356 removed 1, #358
  removed 1 and added 4 (one retitled narrowing, three new). #355 and #357
  netted 0 (narrowed in place or retitled).
- Narrowed, not closed: #355 (null), #357, #358.

## 7. Levers applied

| Lever                        | #355 | #356 | #357 | #358 |
| ---------------------------- | ---- | ---- | ---- | ---- |
| Test failing on `main` shown | n/a  | yes  | yes  | yes  |
| Mutation run                 | n/a  | yes  | yes  | yes  |
| Numbers cite their command   | yes  | yes  | yes  | yes  |
| Measured on real input       | yes  | yes  | yes  | yes  |

- #355 changed no code under `src/`; the existing fixture test already pins
  the synthetic case. Its real input is the gitignored `stubs/` corpus
  (475 rows).
- #356's failing proof is the check itself on `main`: `npm run build && MOSAIC_GPU=1
npm run check:zone-occlusion` printed `FAILED (4)`. Its mutation is removing
  view `v5`, which fails with "zone seat-right produced no interior ink
  sample".
- #357: 8 mutants swapped into `src/raster/trace.ts`, each failing at least
  one test (body table, 107 tests). Its measurement is
  `bench-raster.ts cap` and `despeckle`, both identical to `main` bar the
  `ms` column.
- #358: 11 removed guards, each failing a test (body table). 5 tests failed
  on `main`. Measured with `scripts/measure-wall.ts` (thinnest chair wall
  2.03 mm) and a live run.
- The trap-file and state-sketch levers are not reported in the bodies; not
  scored.

## 8. Process misses (not in the round tables)

- **#355 skipped the prose pass.** The agent ran prettier and lint instead of
  the `/code-review low` prose pass the brief requires. The orchestrator sent
  it back; the pass came back clean. Same shape as #344 and #345 on 2026-10-05.
- **#357's out-of-body timings.** The deChecker-only timings (about 40 to 77 ms
  on `cap`) came from an uncommitted instrumented copy of the function. They
  were left out of the PR (the prose pass dropped that table). No committed
  command reproduces them, so this report does not rely on them.
- **#358's unfiled finding and unreviewed script** (§5). Together they cost
  one orchestrator round and one `low` review round.
- **Flaky test.** `tests/exportPanel.test.ts` failed 2 cases once in #358's
  agent run and passed on rerun. Not investigated here; CI status is not
  recorded in this report.
- **Main merges.** All four merged by `gh pr update-branch` or already
  current. No conflict needed a scratch rebase this campaign.

## 9. Null results and live checks

- **#355 is the null result** (§6). Narrowed with 0 of 138 and 363 ms; no
  fix invented.
- **#357's new path never fires on the corpus.** Both benches' rows are
  identical to `main`; the bottom-left rewrite was never used, so the fix is
  tested on hand-built grids only
  (`node_modules/.bin/vite-node scripts/bench-raster.ts cap` and `... despeckle`
  per its body). Like #350 on 2026-10-05b.
- **#356's own check was the real measurement.** It is a driven check
  (`MOSAIC_GPU=1`, built app) and the intermediate run with the 6 px step but
  no hairline excuse printed `FAILED (12)`. The check, not review,
  exposed that.
- **#358 live check passed.** The agent ran it with `MOSAIC_GPU=1`, built
  preview, chair, 700 mm square bound to Left side: no warning at the
  default 1 mm, four pills at 20 mm (Handle 2.03 to 1.98, Storage 3.90 to
  3.85, Wing 3.40 to 3.35, Wheel mount 4.00 to 3.95). It confirmed the
  warning and caught nothing review missed. **The orchestrator ran no
  separate live check**; the user runs those manually.
- **Live checks caught nothing review missed.** What the orchestrator read
  caught (§5) was not a live check.
- Orchestrator facts in §5, §8 and the live-check lines are the
  orchestrator's account, not reproducible by command.

## 10. Sources

- PR bodies: `gh pr view <n> --json body,mergeCommit` for `n` in 355-358.
  Merge SHAs: #355 `e47762b`, #356 `39d91ec`, #357 `7d876c4`, #358 `d52f1d4`.
- Baseline: `git show d61529b^:docs/process-review-2026-08.md`.
- Earlier figures: `docs/findings/2026-09-24-round-trip-measurement.md`,
  `docs/findings/2026-10-05-round-trip-measurement.md`,
  `docs/findings/2026-10-05-round-trip-measurement-b.md`.
- Section counts and defects: `git show <merge-sha> -- docs/tech-debt.md`.
- Campaign plan (agents, branches, review levels): `~/.claude/plans/crispy-jingling-hollerith.md`,
  outside the repo.
