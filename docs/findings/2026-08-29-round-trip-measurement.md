# Round trips on the 2026-08-28 fix campaign, against the 2026-08 baseline

**Result: the process levers moved the numbers, mostly.** Across the four
briefed code PRs (#259-#262) the mean was **4.0 review rounds** against the
baseline's ~4.6, **VAC went from ~9 to 0**, **NUM from ~10 to 2**, and
fix-introduced defects from ~2.7 per PR to 1.0. DOC and CTX did not move
much. The one PR that ran without the brief (#257, from a stale worktree)
took 6 rounds and carried the campaign's only unrecorded rounds. The
docs-and-config PR that codified the process (#264) took **15 rounds on 3
files**, which is a finding about reviewing prose, not about the levers.

Pinned to `main` at `3b10a2e` (#264). Machine: WSL2, RTX 2060,
`MOSAIC_GPU=1` for the one live check. Every number below comes from the PR
bodies: `gh pr view <n> --json body` for `n` in 257 259 260 261 262 264, and
the Rounds tables are copied, not re-derived. File counts are `gh pr view <n> --json changedFiles`. #257 has no Rounds table; its
prose says six rounds and names the causes, so its rows are marked
approximate.

## Baseline

From `docs/process-review-2026-08.md` (deleted in #249; `git show
d61529b^:docs/process-review-2026-08.md`), over the 11 code PRs #229-#243:

| Metric               | Baseline |
| -------------------- | -------- |
| Mean rounds, code PR | ~4.6     |
| FIX                  | ~30      |
| GATE                 | ~12      |
| DOC                  | ~12      |
| NUM                  | ~10      |
| VAC                  | ~9       |
| CTX                  | 5        |
| PIPE                 | 3        |
| DIAG                 | 3        |
| SCOPE                | 4 PRs    |
| VIS                  | 0        |
| Bundled PRs          | 4 of 11  |
| Human look pre-merge | none     |

## Rounds per PR

| PR   | Item                                  | Model  | Briefed | Files | Rounds | Corrections acted on | Cut      |
| ---- | ------------------------------------- | ------ | ------- | ----- | ------ | -------------------- | -------- |
| #259 | Hubcap restore clamp                  | Sonnet | yes     | 6     | 2      | 0                    | none     |
| #260 | Restore warning survives              | Sonnet | yes     | 10    | 5      | 4                    | none     |
| #261 | Empty-trace notice                    | Sonnet | yes     | 13    | 3      | 4                    | none     |
| #262 | Glued arc flags                       | Opus   | yes     | 5     | 6      | 8                    | one area |
| #257 | Tower footprint (stale worktree)      | Opus   | no      | 8     | 6      | ~4 (approx)          | none     |
| #264 | fix-campaign skill + allowlist (docs) | Fable  | n/a     | 3     | 15     | ~30                  | none     |

- Briefed code PRs: mean **4.0** (2+5+3+6 over 4). With #257: 4.4.
- No PR bundled findings. #262 promoted two extra defects to tech-debt
  instead of fixing them (`prevCtrl` after an arc, uppercase `E` exponent);
  #261 promoted one (source removal not retracting keyed notices).
- Clean final rounds are counted, per the baseline's own note that it
  undercounted them.

## Per-round corrections, with cause codes

Codes as in the baseline plus **TASTE** (found, judged not worth acting on),
which the baseline had no row for and is tallied separately.

### #259, 2 rounds

| Round | Correction | Cause | From prior fix? |
| ----- | ---------- | ----- | --------------- |
| 1     | clean      | —     | —               |
| 2     | clean      | —     | —               |

### #260, 5 rounds

| Round | Correction                                                                                | Cause  | From prior fix?  |
| ----- | ----------------------------------------------------------------------------------------- | ------ | ---------------- |
| 1     | Deleted tech-debt section dropped its open thread (part-switch confirm) without moving it | CTX    | no               |
| 2     | Two comments still cited the removed clear's old location                                 | DOC    | no               |
| 3     | clean                                                                                     | —      | —                |
| —     | Second look at the restore path: no clear before the loop; none in the failure catch      | FIX ×2 | no (in the diff) |
| 4     | clean                                                                                     | —      | —                |
| 5     | clean                                                                                     | —      | —                |

The two FIX rows were real gaps in the original diff (a removed clear with no
replacement on two paths), found by a deliberate re-read rather than a
`/code-review` round. The state sketch was already in the PR body and did not
prevent them; it made them quick to confirm.

### #261, 3 rounds

| Round | Correction                                                   | Cause | From prior fix?  |
| ----- | ------------------------------------------------------------ | ----- | ---------------- |
| 1     | "Missing troubleshooting section" — the section existed      | DIAG  | no               |
| 1     | `fracFloorPx` directly instead of `despeckleFloorPx(..., 0)` | PIPE  | no               |
| 1     | Docstring over the 2-4 line budget                           | CTX   | no               |
| 1     | `bench-raster.ts` passes no name                             | TASTE | —                |
| 1     | "Both noisy and small" edge unmeasured                       | TASTE | —                |
| 2     | `name` leaked into stored `RasterState` via spread           | CTX   | no (in the diff) |
| 2     | Dialog names the file twice                                  | TASTE | —                |
| 3     | `dot()` fixture duplicated across two test files             | TASTE | —                |

### #262, 6 rounds, one area cut

| Round | Correction                                                                     | Cause | From prior fix? |
| ----- | ------------------------------------------------------------------------------ | ----- | --------------- |
| 1     | Deleted section's `fill-opacity` thread had no home; added a clamp             | CTX   | no              |
| 1     | CHANGELOG said 6 new arc cases, 7 were added                                   | NUM   | no              |
| 1     | `flag()` comment claimed a remainder never starts with `e`; `11e2` leaves `e2` | DOC   | no              |
| 2     | "neither 0 nor 1" wording wrong for `1.0`                                      | DOC   | yes (r1)        |
| 2     | Silent skip on clamp-to-zero — promoted                                        | TASTE | —               |
| 3     | `%` test and `parseFloat` disagreed on `50% !important`                        | FIX   | yes (r1 clamp)  |
| 3     | `1.0` strictness re-raised — spec-correct                                      | TASTE | —               |
| 3     | `prevCtrl` survives an `A` — promoted                                          | SCOPE | no              |
| 4     | r3 regex made `0 !important` opaque: hidden shape imported visible. **Cut**    | FIX   | yes (r3)        |
| 5     | Docs overclaimed which flag position `1.0` breaks                              | DOC   | yes (r2)        |
| 5     | Uppercase `E` exponent rejected — promoted                                     | SCOPE | no              |
| 6     | CHANGELOG understated the `1.0` case                                           | DOC   | no              |
| 6     | CHANGELOG credited Illustrator with nothing behind it                          | NUM   | no              |
| 6     | Troubleshooting never said later subpaths go too                               | DOC   | no              |

The cut rule fired exactly as written: round 3 found a defect in round 1's
fix, round 4 found a worse one in round 3's, and `parseFillOpacity` went back
to what shipped with the three rounds written into tech-debt. The tokenizer
half came back clean in rounds 4, 5 and 6.

### #257, 6 rounds, approximate

No Rounds table (the agent predates the brief). Its body: rounds 1-4 found
"wrong claims and one real defect I had introduced (the tie-break ordering
lost to float noise)"; round 5 "two overstated claims"; round 6 nothing. Read
as NUM ×≥3, FIX ×1 (fix-introduced), clean ×1.

### #264, 15 rounds, docs and config only

Not a code PR and not in the baseline's population; recorded because it is
the campaign's own overhead. Rounds 1-14 each returned at least one real
finding (missing `git fetch` before a rebase, no `git add` before `rebase
--continue`, `git -C` not matching a plain allow rule, a branch `git
worktree remove` never deletes, `ln -s` and `git push --force-with-lease`
missing from the allowlist, one fix-introduced regression in round 14).
Round 15 returned nothing. Full table in the PR body.

## Tally against the baseline

Briefed code PRs only (#259-#262), 16 rounds, 4 PRs. #257 in parentheses.

| Cause | Baseline (11 PRs) | This campaign (4 PRs) | Per PR: baseline → now |
| ----- | ----------------- | --------------------- | ---------------------- |
| FIX   | ~30               | 4 (+1)                | 2.7 → 1.0              |
| DOC   | ~12               | 6                     | 1.1 → 1.5              |
| NUM   | ~10               | 2 (+≥3)               | 0.9 → 0.5              |
| VAC   | ~9                | **0**                 | 0.8 → 0                |
| CTX   | 5                 | 4                     | 0.5 → 1.0              |
| PIPE  | 3                 | 1                     | 0.3 → 0.25             |
| DIAG  | 3                 | 1                     | 0.3 → 0.25             |
| GATE  | ~12               | 0                     | 1.1 → 0                |
| SCOPE | 4 PRs bundled     | 0 bundled; 3 promoted | —                      |
| VIS   | 0                 | 0                     | — (see below)          |
| TASTE | not tracked       | 6, none acted on      | —                      |

Fix-introduced defects specifically: #262 ×2, #257 ×1, #264 ×1 (docs). The
baseline's worst cases were #229 (six in a row) and #230 (the same bug three
rounds running); nothing here repeated more than once before the cut rule
fired.

## Which levers were applied, and what each did

| Lever                                       | Applied to     | Evidence                                                                                                               | Effect                                                                                                                    |
| ------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1 One finding per PR                        | all four       | 3 defects promoted to tech-debt rather than fixed                                                                      | No bundled PR; the baseline's 4 bundled PRs were 24 of 57 rounds                                                          |
| 2 Test-first + mutation run for every guard | all four       | Each PR body pastes the failing run on `main` and the mutation output; #260 ran 4 mutation pairs, #262 ran 5 and cut 2 | **VAC 9 → 0**                                                                                                             |
| 4 State sketch before editing               | #259 #260 #261 | In each PR body                                                                                                        | Did not prevent #260's two gaps; did make them a one-line confirm. Null-ish                                               |
| 5 Numbers cite the command                  | all four       | Every CHANGELOG bullet names its vitest command; #262's counts still drifted twice                                     | NUM 10 → 2; both residuals were counts in prose, not measurements                                                         |
| 6 Trap file named                           | all four       | Brief named the file per item                                                                                          | CTX did not move (4). Two were "a rule in CLAUDE.md not applied", two were "the same diff already had the pattern"        |
| 7 Cut on the second repeat                  | #262           | `parseFillOpacity` reverted at round 4                                                                                 | Stopped a fourth patch; #230's counter-example did not recur                                                              |
| Merge on green                              | all            | Orchestrator merged each on `CLEAN`, rebasing the next                                                                 | VIS stays 0 by design: the user asked for this. The baseline's VIS=0 meant "nobody looked"; this one means "chose not to" |

## Null results and what the levers did not reach

- **DOC did not fall.** Six corrections, five in #262, all in CHANGELOG or
  troubleshooting prose about what the fix does. Rule 4 covers numbers, not
  claims like "neither 0 nor 1". No lever targets this.
- **CTX did not fall.** The trap file was read; the misses were CLAUDE.md
  rules (docstring length, "move out what a section owes") and a pattern in
  the same diff. Naming one file does not cover a rulebook.
- **The state sketch was a null result** in the one PR where it mattered.
- **The live check for #261 found nothing review missed**, and falsified
  my own assertion instead: at Detail 0 the fractional floor binds, so the
  "raise Detail" remedy is correct there and flips to "make it bigger" at
  Detail 50. The plan's "identical at 0/50/100" was the old bug's symptom.
  Output: `scratchpad/live-check-item4.txt` on this machine, not kept.
- **#257 was duplicated.** Agent E re-implemented the tower footprint while
  the earlier session's stale worktree (which the plan told E to read from)
  was already a merged PR. Cost: one Opus agent's full run. The skill's step
  0 now checks for exactly this.
- **Three of five agents stopped to wait on their own background task** and
  had to be messaged to continue. Not a round-trip cost; a wall-clock one.
- **Another session moved `main` mid-run** (#257, #258, then a
  branch switch in the shared checkout that dropped an uncommitted edit).
  Two rebases and one restored edit.

## The prose-review finding

#264 is three files, no source, and took 15 rounds to a clean one. Rounds
1-12 each returned something real (a missing fetch, an unstaged
`--continue`, a permission pattern that would not match). Rounds 13 and 14
returned real things too, one of them introduced by round 13's own fix. The
stop condition CLAUDE.md gives is "a round returns taste"; on a procedure
document the reviewer kept finding executable-adjacent defects because a
skill is a script a human runs. Two observations, no rule proposed:

- A skill file gets reviewed like code and finds defects like code, at
  roughly one per round, for as long as you keep running it.
- The "cut on second repeat" rule did not fire because no area repeated;
  each round hit a different line. That is the shape of a diff that is fine
  and a reviewer that is thorough, not a diff that is wrong.

## Reproduce

```bash
for n in 257 259 260 261 262 264; do gh pr view $n --json number,title,body; done
git show d61529b^:docs/process-review-2026-08.md   # the baseline
git log --oneline 66466db..3b10a2e                  # the campaign's merges (#259-#262, #264)
```
