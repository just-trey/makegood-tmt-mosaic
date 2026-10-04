# Round-trip measurement: three-wave tech-debt campaign (2026-09-24 to 2026-09-28)

**Round counts dropped and the cause mix shifted.** Mean rounds per PR fell to
2.9 (18 PRs, #303-#320) against the 2026-08 baseline's ~4.6 (11 PRs,
#229-#243). FIX and VAC corrections fell relative to PR count; DOC
corrections roughly tripled. `docs/tech-debt.md` did not shrink toward the
plan's ~13 estimate: it moved from 33 sections to 30 over the campaign (this
report's own new section brings the live count to 31), because 13 of the 18
items split the residual half of their problem into a narrower or adjacent
section instead of closing clean.

Covers all 18 merged PRs: wave 1 #303-#310 (2026-09-24), wave 2 #311-#318
(2026-09-24/25), wave 3 #319-#320 (2026-09-27/28). Every number below cites
the command that produced it; PR round tables pulled with
`gh pr view <n> --json body`.

## 1. Rounds per PR

| PR       | Item | What                                              | Rounds                    |
| -------- | ---- | ------------------------------------------------- | ------------------------- |
| #303     | D    | Notice upsert in place                            | 2                         |
| #304     | H    | `MAX_COMPONENTS` raise loop                       | 3                         |
| #305     | B    | `!important` strip + fill-opacity clamp           | 3                         |
| #306     | C    | Delete flat-plate modes                           | 2                         |
| #307     | E    | Shared numeric-coercion helper                    | 4                         |
| #308     | A    | Hidden SVG group drop                             | 3                         |
| #309     | G    | Restore kind-switch rollback                      | 4                         |
| #310     | J    | `check:zone-occlusion` dead-region fix            | 4                         |
| #311     | M    | Per-colour union chunking (measured, not chunked) | 3                         |
| #312     | L    | Wall-depth-per-region clamp                       | 3                         |
| #313     | K    | Placement frame basis                             | 3                         |
| #314     | I    | Directed-edge patch boundary (Fable)              | 3                         |
| #315     | P    | Re-trace on resize                                | 3                         |
| #316     | O    | Chair conformal-repair ladder                     | 3                         |
| #317     | F    | Fill yields to sticker                            | 3                         |
| #318     | N    | Tile union past the segment cap                   | 3                         |
| #319     | R    | Edge density at fixed measuring size              | 3                         |
| #320     | Z    | Clip-ink floor sweep (docs-only)                  | 1                         |
| **Mean** |      | **18 PRs**                                        | **2.94** (53 rounds / 18) |

Baseline: 11 code PRs, mean ~4.6 rounds (`docs/process-review-2026-08.md`
via `git show d61529b^:docs/process-review-2026-08.md`).

**Counting basis differs from the baseline, in the direction that favors the
baseline.** This campaign's tables count the clean final round as its own
row, per the fix-campaign skill ("one row per review round including the
clean final one"). The baseline's own §7 says it does the opposite: "rounds
that returned nothing are not counted, so 'rounds' undercounts round trips by
the clean final rounds." So the 2.9 above already includes rounds the
baseline's 4.6 would have dropped — the real gap is at least this large, not
smaller.

## 2. Cause tally

Counted per correction row (not per round) across all 18 `## Rounds` tables,
using each row's own cause code.

| Code                    | This campaign                                            | Baseline (#229-#243)   | Where it concentrates now               |
| ----------------------- | -------------------------------------------------------- | ---------------------- | --------------------------------------- |
| FIX                     | 18                                                       | ~30                    | #309 (3), #318 (3), #314 (3)            |
| DOC                     | 34                                                       | ~12                    | spread across all 18; #305 alone has 6  |
| NUM                     | 16                                                       | ~10                    | #304 (3), #317/#318 (2 each)            |
| VAC                     | 8                                                        | ~9                     | #304, #308, #309, #311, #316 (1-2 each) |
| PIPE                    | 7                                                        | 3                      | #309, #315, #317, #318 (2)              |
| SCOPE                   | 5 corrections / 4 PRs                                    | 4 PRs                  | #307, #310 (2), #313, #318              |
| DIAG                    | 3                                                        | 3                      | #311 (2), #317 (1)                      |
| CTX                     | 1                                                        | 5                      | #304                                    |
| GATE                    | 1                                                        | ~12                    | #310 (added a missing branch test)      |
| HARD                    | 1 correction / 1 PR                                      | 2 areas                | #318 (engine crossing limit)            |
| VIS                     | 0 corrections (2 dedicated zero-finding passes — see §4) | 0                      | —                                       |
| **Total (excl. TASTE)** | **94**                                                   | not separately totaled | —                                       |

Per-PR rates: FIX 1.0/PR now vs 2.7/PR baseline; DOC 1.9/PR now vs 1.1/PR
baseline; NUM 0.9/PR both; GATE 0.06/PR now vs 1.1/PR baseline (baseline's
GATE cost was building the copy gate itself, a one-time guardrail-rollout
cost this campaign didn't repeat).

**Corrections caused by the previous round's own fix: 3 of 94** (#308's
`shapeCount + 1` fix, #315's and #316's stale-rename comments) — the
baseline's top-ranked cause ("a fix in round N introducing the defect round
N+1 finds") shows up far less here. The baseline didn't tabulate this as a
single count (it reads off per-PR narratives like #230's three repeated
sign-dodging fixtures), so this is a directional read, not a like-for-like
delta.

## 3. TASTE — no baseline counterpart

12 corrections tagged TASTE (found, judged not worth fixing, left as-is):
#304 (2), #308 (1), #311 (1), #312 (1), #313 (1), #314 (1), #316 (1), #317
(2), #318 (1). The 2026-08 review never coded this — it had no vocabulary for
"found, declined" separate from a real correction. Tallied here on its own,
per the fix-campaign skill step 5, not folded into FIX or any other baseline
bucket.

## 4. VIS — the docs-only gate

VIS is the review a docs-only PR gets in place of `/code-review`. Two PRs
qualified: #319 (behavior PR, code-reviewed normally, but also given a
separate VIS read since it touches the tech-debt narrative) and #320
(docs-only: a new skipped-by-default test plus tech-debt/CHANGELOG prose, no
production code path). Both VIS passes: **zero findings**
(run separately from this report; not reproducible by a command, since it is
a human/orchestrator read of the diff, same as the baseline's VIS
definition). Baseline VIS = 0 corrections because no PR in that window was
looked at before merge at all; here VIS ran on both eligible PRs and
confirmed clean rather than never running.

## 5. Score per PR

Defects closed = behaviour-layer corrections with a real cause (excludes
TASTE, excludes clean rows). Sections opened = new `## ` headings the PR's
own diff added to `docs/tech-debt.md`
(`git show <merge-sha> -- docs/tech-debt.md | grep '^+## '`). Fixed inline =
a second defect found on the way and closed in the same PR rather than
filed, per the campaign brief's triage rule.

| PR        | Defects closed | Sections opened                                                                                | Fixed inline                     | Rounds (of which prose-labeled)                                                                                    |
| --------- | -------------- | ---------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| #303      | 0              | 0                                                                                              | —                                | 2 (1)                                                                                                              |
| #304      | 2              | 1                                                                                              | —                                | 3 (1)                                                                                                              |
| #305      | 3              | 1                                                                                              | —                                | 3 (1)                                                                                                              |
| #306      | 0              | 0                                                                                              | —                                | 2 (1)                                                                                                              |
| #307      | 1              | 1                                                                                              | —                                | 4 (0 — no round separately labeled prose)                                                                          |
| #308      | 3              | 0                                                                                              | —                                | 3 (1, embedded in round 2)                                                                                         |
| #309      | 5              | 1                                                                                              | 1 (round 3, "second-defect fix") | 4 (1)                                                                                                              |
| #310      | 6              | 1                                                                                              | —                                | 4 (1, embedded in round 2)                                                                                         |
| #311      | 3              | 1                                                                                              | —                                | 3 (1)                                                                                                              |
| #312      | 2              | 1                                                                                              | —                                | 3 (1)                                                                                                              |
| #313      | 2              | 1 (planned split, see §6)                                                                      | —                                | 3 (1)                                                                                                              |
| #314      | 3              | 0                                                                                              | —                                | 3 (1)                                                                                                              |
| #315      | 2              | 1                                                                                              | —                                | 3 (1)                                                                                                              |
| #316      | 2              | 2                                                                                              | —                                | 3 (1)                                                                                                              |
| #317      | 2              | 1                                                                                              | —                                | 3 (1)                                                                                                              |
| #318      | 6              | 3                                                                                              | —                                | 3 (1)                                                                                                              |
| #319      | 3              | 1 (planned narrowing, see §6)                                                                  | —                                | 3 (1)                                                                                                              |
| #320      | 0              | 1 (planned narrowing, see §6)                                                                  | —                                | 1 (1 — its one pass stood in for the prose pass; no code rounds run, per the skill's "docs, one fixed target" row) |
| **Total** | **45**         | **17 raw opens** (16 net still open at campaign end; #305's opened heading was closed by #308) | **1 identified**                 | 53 rounds                                                                                                          |

"Fixed inline" is likely undercounted: it is only visible in a PR body when
the author calls it out as its own round or bullet, and this report reads
bodies, not full diffs. #309's round 3 is the only round explicitly labeled
this way.

## 6. Null results — hoped-for outcome didn't happen

- **R (#319), edge density.** Plan: "close the section if the classification
  of all 7 photos is kept." Result: all 7 kept, but the section is
  **narrowed, not closed** — under 384px, no cutoff separates flat art from
  photos at any measurement, and `FLAT_EDGE_DENSITY`/`PHOTO_EDGE_DENSITY`
  stay unmeasured. New section: "The flat and photo edge-density endpoints
  are unmeasured, and small photos read flat."
- **Z (#320), clip-ink floor.** Plan: sweep the floor and close the section.
  Result: **narrowed, not closed**. 9.4% of 8,056 recorded foreground-ink
  pieces sit below `CLIP_REMNANT_FLOOR_MM2`, and the narrowest survivor is
  0.1600478mm² — 1.00003x the floor, not "comfortably clear" as hoped.
  Whether the sub-floor population is clip-boundary dust or real zebra-stripe
  detail is unmeasured; new section: "Whether a near-floor clipped-ink piece
  is dust or a drawn detail is unmeasured."
- **O (#316), chair conformal repair, defect 1.** Plan: "Handle (left) keeps
  its black" (defects 1-2). Result: defect 2 fixed; **defect 1 does not
  reproduce** — 0 null cutters across the sweep, on `main` before and after
  the fix. Recorded as a null result in the PR body itself, not silently
  dropped.
- **N (#318), tile union vertex limit.** Plan assumed a "503k-600k band" as
  the trigger to batch. **The premise was wrong**: the limit is
  polygon-clipping's exact hard cap of 500,000 input segments per call, not a
  soft band. The fix landed at the boolean entry point (`boolOpUnderCap`)
  instead of a tile-union-specific batch, and it is the largest PR in the
  campaign (five review passes converged on the same two defects).
- **Wave 1**: no null result recorded. Each item's "done when" condition in
  the plan was met as stated; H, G and J each left a genuinely new, narrower
  defect as its own section (deChecker under-floor pieces, the caster-mount
  fetch failure, the zone-occlusion 4-zone gap) rather than a hoped-for
  outcome that failed to materialize.

## 7. What a live check or CI caught that review did not

- **Wave 2 (#318, N): a live check caught nothing review missed.** It
  cheaply confirmed the merged build was byte-identical at wheel size,
  reusing the #317 live-check worktree's drive script. Reported as a data
  point per the fix-campaign skill: a live check running clean is itself
  informative, not just a non-event.
- **A clean rebase broke typecheck, caught by CI, not by either PR's
  review.** #313 added a caller of `extractPatchBoundary`'s old return
  shape; #314 (which changed that shape) merged first. #313's own review
  rounds ran against the pre-#314 shape and could not have seen the
  mismatch. CI's typecheck gate caught it after the rebase; fixed with a
  one-line `.loops` change. Neither PR's `## Rounds` table records this,
  since it happened between review and merge, not inside a round.
- Wave 1: no live-check-vs-review discrepancy is recorded in this campaign's
  available records.

## 8. `areaPct` display bug — added to tech-debt

Found by #317 (F)'s live check while comparing sticker bands that should
split area evenly. Verified against current code (`src/app/rebuild.ts:672-708`,
`src/geometry/assembly.ts:1043-1045`) before writing the section: the
assembly color list's `areaPct` (`src/app/rebuild.ts:676-691`) is each
color's inlay triangle count divided by the total shipped triangle count —
not an area. A thin flush inlay's triangle count tracks its boundary
complexity, not its footprint, so equal-area sticker bands can read
1.0%/0.2%/0.0% instead of roughly a third each. `detectedColors.areaPct`
(`src/geometry/assembly.ts:1043-1045`, the pre-merge 2D palette) does not
have this bug — it's real planar area. New section added to
`docs/tech-debt.md`: "The assembly color list's area% is triangle count, not
area."

## 9. `docs/tech-debt.md` section count

- Before wave 1's first merge: **33** sections
  (`git show 408f681a2493ed77d05a87f829d0215172427f82^:docs/tech-debt.md | grep -c '^## '`).
  The campaign's own planning doc says 30 at the same point; this report
  measures 33 from git history rather than trusting that figure.
- After wave 3's last merge, before this report: **30** sections
  (`git show 939ce9b4ad935c05d3dd20a6e9f71bcd3512cfa5:docs/tech-debt.md | grep -c '^## '`).
- After this report's new section: **31**
  (`grep -c '^## ' docs/tech-debt.md`, this branch).
- Net change over the campaign: **-3**, not the plan's estimated ~30 → ~13.
  **20 headings were removed and 17 were added** (`git show <merge-sha> --
docs/tech-debt.md | grep -E '^\+## |^-## '`, all 18 merge commits): 19 of
  the 20 removals closed one of the original 33 sections outright (the 20th,
  #308, closed a heading #305 had opened three commits earlier in the same
  campaign). Of the 17 additions, 1 (from #305) was itself closed later in
  the campaign (by #308), leaving 16 new sections open at the end.
- Of the 33 original sections, **14 were never touched**: 13 match the
  plan's own "left open, with the reason" table (tires, third-bed/hubcap
  plate, Colors/downscale, fringe threads, faceted templates, cancel
  latency, concave footprint/rotated-copy mesh, turf pin/rebuild
  performance, thin cut-region strip). One, "Two traces still drop a color
  and say nothing about it," is untouched but **not listed** in the plan's
  left-open table — an accounting gap in the plan, not a decision recorded
  anywhere.
- 5 of the 18 items closed clean with no residual section (D, C — 2
  sections, A+B combined — 2 sections, I): 6 sections closed with zero
  successor.
- 13 of the 18 items closed their assigned section but spun a narrower or
  adjacent problem into a new one (H, G, J, M, L, K, P, O, F, N, R, Z, E).
  Two of these splits were explicitly planned in the campaign plan itself (K:
  "the competing-affordance half... gets its own section"; R and Z: "narrowed,
  not closed" was the named possible outcome). The other 11 splits were
  discovered during the work, not planned in advance.

## 10. Sources

- Baseline: `git show d61529b^:docs/process-review-2026-08.md`.
- PR bodies: `gh pr view <n> --json body` for `n` in 303-320.
- PR metadata (title, branch, merge SHA): `gh pr view <n> --json
title,headRefName,state,mergedAt,mergeCommit`.
- Tech-debt heading diffs: `git show <merge-sha> -- docs/tech-debt.md` per
  PR, merge SHAs listed in §9.
