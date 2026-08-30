# Round trips on the 2026-08-30 fix campaign, against the 2026-08 baseline

**Result: the round count moved again, and FIX all but vanished.** Across the
six briefed PRs (#276-#281) plus the follow-up they produced (#283), the mean
was **3.0 review rounds** against the baseline's ~4.6 and the 2026-08-28
campaign's 4.0. **FIX went from ~30 to 1**, VAC and GATE to **0**. What did
not fall is DOC (5) and NUM (4): every campaign so far has found its prose
harder to get right than its code.

The finding that matters most is not in the tally. **A live run caught a
defect that four clean review rounds and a cross-file tracer missed** on
#279, and closing it took another PR. That is the campaign's one VIS, and it
is the second time in three campaigns that the driven run found what review
did not.

Pinned to `main` at `326679e` (#283). Machine: WSL2, RTX 2060, `MOSAIC_GPU=1`
on every live check. Every number below comes from the PR bodies: `gh pr view
<n> --json body` for `n` in 276 277 278 279 280 281 283, with the Rounds
tables copied, not re-derived. File counts are `gh pr view <n> --json
changedFiles`.

## Baseline

From `docs/process-review-2026-08.md` (deleted in #249; `git show
d61529b^:docs/process-review-2026-08.md`), over the 11 code PRs #229-#243,
with the 2026-08-28 campaign for the nearer comparison.

| Metric               | Baseline | 2026-08-28 | This run |
| -------------------- | -------- | ---------- | -------- |
| Mean rounds, code PR | ~4.6     | 4.0        | **3.0**  |
| FIX                  | ~30      | 4          | **1**    |
| GATE                 | ~12      | 0          | **0**    |
| DOC                  | ~12      | 4          | 5        |
| NUM                  | ~10      | 2          | 4        |
| VAC                  | ~9       | 0          | **0**    |
| CTX                  | 5        | 3          | 2        |
| PIPE                 | 3        | 0          | 1        |
| DIAG                 | 3        | 0          | 0        |
| SCOPE                | 4 PRs    | 1 PR       | 1 PR     |
| VIS                  | 0        | 1          | 1        |

**TASTE has no baseline counterpart.** The original review did not track
"found, judged not worth fixing" as its own code, so the one TASTE row here
(#279 round 3) is tallied separately and not folded into any baseline
bucket. Comparing it to anything above would be comparing two taxonomies.

## Rounds per PR

| PR   | Item                            | Agent         | Files | Rounds | Corrections | Behaviour | Prose |
| ---- | ------------------------------- | ------------- | ----- | ------ | ----------- | --------- | ----- |
| #276 | Dropzone hover vs drag-over     | sonnet-medium | 3     | 2      | 0           | 1         | 1     |
| #277 | Audit drive-sequence hash       | sonnet-medium | 5     | 2      | 1           | 1         | 1     |
| #278 | Empty-trace message alignment   | opus-high     | 5     | 2      | 1           | 1         | 1     |
| #279 | Depth clamp display, pills, doc | sonnet-medium | 14    | 4      | 1           | 3         | 1     |
| #280 | SVG path and fill tokenizer     | opus-high     | 7     | 3      | 7           | 2         | 1     |
| #281 | Tile-union vertex ceiling       | opus-high     | 17    | 5      | 4           | 4         | 1     |
| #283 | Rotated copy clamp (follow-up)  | opus-high     | 4     | 3      | 2           | 2         | 1     |

Mean rounds 3.0. Every PR ran exactly one prose pass, at the end, and none
re-entered code review for a prose finding — the rule that cost #270 nine
rounds and #264 fifteen held in all seven.

## Corrections by cause

| Cause | Count | Where                                                   |
| ----- | ----- | ------------------------------------------------------- |
| DOC   | 5     | #277 ×1, #278 ×1, #280 ×2, #281 ×1                      |
| NUM   | 4     | #280 ×1, #281 ×2, #283 ×1                               |
| SCOPE | 3     | #280 ×3 (all round 1)                                   |
| CTX   | 2     | #279 ×1, #283 ×1                                        |
| FIX   | 1     | #280 ×1                                                 |
| PIPE  | 1     | #281 ×1                                                 |
| TASTE | 1     | #279 ×1 (tallied apart, see above)                      |
| VIS   | 1     | #279, caught by the orchestrator's live run after merge |

Fix-introduced defects: 3 of 16 corrections (#280 round 2, #281 rounds 2 and
4, #283 round 2), against ~2.7 per PR at baseline and 1.0 in the 2026-08-28
campaign. Here it is 0.43 per PR.

## Scored per PR

Sections is `docs/tech-debt.md`, which went 37 → 29 across the campaign.

| PR   | Defects closed | Sections opened | Fixed inline | Notes                                   |
| ---- | -------------- | --------------- | ------------ | --------------------------------------- |
| #276 | 1              | 0               | 0            | docs already stated the correct split   |
| #277 | 1              | 0               | 0            |                                         |
| #278 | 1              | 0               | 0            |                                         |
| #279 | 3              | 0               | 0            | three consecutive sections              |
| #280 | 3              | 1               | 1            | inline: `S`/`T` cross-family reflection |
| #281 | 1 (partial)    | 0               | 0            | batching deliberately left open         |
| #283 | 1              | 0               | 0            | never had a section; found by live run  |

The one section opened (#280's ancestor `display="none"` not inherited) was
the right call under the inline-vs-section rule: it needs a product decision
about whether a vanishing layer is silent, which is exactly what a section
is for. The one inline fix was a one-line spec correction in a file the PR
already touched — the case the rule says not to turn into a section.

## What the live checks caught that review did not

**#279, the campaign's VIS.** On the default wheel, all three colours showed
"cut at 48.45" in the colour list while the warning pill named only two. The
`colorAppliedDepth` display value was set whenever a region landed at the
setting; the warning additionally required `!part.isDuplicateOf`. A colour
landing only on the wheel's rotated copy therefore displayed a clamp that no
warning mentioned — the display/warning disagreement the PR existed to
remove, in the same file.

Four code rounds, a cross-file tracer that walked every reader of the new
field, a removed-behaviour audit and a conventions pass all returned clean on
that diff. The single driven run found it in one read. The footrest, a
single-part kind, was correct throughout, which is why unit tests built on
one part could not see it.

The follow-up (#283) then rejected the fix its brief proposed. Filing a
copy's clamp under its source part's name would have printed `deeper than
"Top" goes` for a colour that only lands on `Bottom` — a wrong part name in a
user-facing string, worse than the silence. The special case went instead,
and the "sixteen pills" concern that had justified it turned out to be
already solved by #279's own grouping key: measured worst case on the real
wheel is 2 pills.

## Null results and disproved numbers

- **The ~800k turf vertex ceiling was wrong.** #281 was briefed with the
  300k asset-test budget, round 1 showed it refuses patterns that measure
  clean, and the sweep that followed put first failures at **537,199
  (dalmatian) and 600,201 (zebra) points**, not the ~800k this repo had
  quoted in a tech-debt section, an asset test's docstring and
  `gen-patterns.mjs`. Budget set to 500k. `scripts/bench-tile-union.ts` and
  `docs/findings/2026-08-30-tile-union-ceiling.md`.
- **A tech-debt section's own suggested fix would have shipped a
  regression.** #278's section proposed a bare `!detailLowersFloor`.
  `mmPerPixel` is undefined in plate mode, so an emptied trace with Detail
  already spent would have advised making a part bigger when there is no
  part. The second half of the condition holds that case.
- **A PR's own first claim was false.** #280's `pathCount` fix still missed
  `<path>` inside `<defs>` — the ordinary Illustrator and Inkscape clip-mask
  case — so the warning numbering it advertised was still wrong. Round 1
  caught it.
- **A review finding was wrong and was rejected.** A simplification pass on
  #279 claimed flat-mode `appliedDepth` is always undefined. `ColorMeshEntry.depth`
  is a non-optional `number` set from `resolveDepth`, and two earlier
  sub-passes had already confirmed it. Acting on it would have added a guard
  to a non-nullable field. Three passes, two correct.
- **Nine sub-passes on #279 converged on one duplication theme** (parallel
  warning functions, parallel accumulators, staging maps) across four
  separate reports. One correctness finding hid inside them, the duplicated
  `landedAtSetting` guard, and was acted on; the rest was taste and was not.

## Harness findings

- **`npm test` from the main checkout sweeps `.claude/worktrees/*/tests/`.**
  A running agent's in-progress edits can redden the main suite: one run
  reported 1 failure of 2638, and the same command passed on re-run.
  Main-only is 83 files and 1330 tests
  (`npx vitest run --exclude '**/.claude/worktrees/**'`).
- **`gh pr merge --delete-branch` leaves the remote branch behind whenever an
  agent worktree holds the local one.** It deletes both together, so the
  local failure aborts both, and the half it reports succeeding is the merge.
  All six campaign branches survived on `origin`; the prune that cleared them
  took ten more from earlier campaigns. Fixed in #282, which added the sweep
  to the `fix-campaign` skill's step 6.
- **The account session limit killed four of six agents mid-run.** All four
  resumed from their transcripts with uncommitted work intact; none had to
  restart. The two that had not yet renamed off their auto-generated branch,
  or still held a throwaway probe file, needed that named in the resume
  message.
