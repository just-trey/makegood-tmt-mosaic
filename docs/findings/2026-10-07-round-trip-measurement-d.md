# Round-trip measurement: batch D review-cycle fixes (2026-10-07)

**Rounds are down against every earlier report and the 2026-08 baseline; the
cause tally is two corrections, both on #371.** Mean rounds per PR is 2.0
(2 PRs, #370-#371, 4 rounds) against ~4.6 (11 PRs, #229-#243), so down.
Against 3.0 for batch C (2026-10-06c), 3.25 for the earlier 2026-10-06
report (#355-#358) and 3.0 for 2026-10-05b it is also down. Corrections per
PR are 1.0 against 0.67 (c), 5.5 (2026-10-06) and 3.0 (b), so up on c. Codes
are PIPE (1) and DOC (1); every other code is 0. Two PRs: a small sample,
not a trend.

Covers #370 and #371 (merged 2026-10-07, 20:51Z and 20:55Z). PR round tables
pulled with `gh pr view <n> --json body,title,mergeCommit,mergedAt` for `n`
in 370-371. Format model: `docs/findings/2026-10-06-round-trip-measurement-c.md`.

## 1. Rounds per PR

| PR       | Agent         | What                                               | Rounds                 |
| -------- | ------------- | -------------------------------------------------- | ---------------------- |
| #370     | sonnet-medium | Chair zone coverage shown before Export, not after | 2                      |
| #371     | sonnet-medium | Sample loads once, and no size note for it         | 2                      |
| **Mean** |               | **2 PRs**                                          | **2.0** (4 rounds / 2) |

- Same counting basis as the earlier reports: the clean final round is its own
  row. The baseline left clean final rounds out, so 2.0 understates the drop.
- #370's 2: round 1 (`medium`), the `low` prose pass. #371's 2: round 1
  (`medium`), round 2 (`low`). Its body lists a third row, a prose pass, as
  "not run"; not counted.
- Live checks are not rounds here: both found no defect in the PR (§8).
- Agent column is inferred from the round-1 level and the brief (`medium` is
  `sonnet-medium`). Both are `src/ui/`, `src/app/` or state plumbing work.

## 2. Corrections per round

| PR   | Round          | Correction                                                                                                                                                  | Layer     | Cause | Introduced by previous fix? |
| ---- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----- | --------------------------- |
| #370 | 1 (medium)     | none                                                                                                                                                        | -         | -     | -                           |
| #370 | 2 (low, prose) | none                                                                                                                                                        | -         | -     | -                           |
| #371 | 1 (medium)     | A click on the existing sample only set the active id; fit inputs, gizmo and net overlays stayed on the other design. Extracted `selectArtwork`, test added | behaviour | PIPE  | No                          |
| #371 | 2 (low)        | `selectArtwork` was inserted between `renderArtworkList` and its docstring; moved                                                                           | prose     | DOC   | Yes                         |

- #371's round 1 is a shared-pipeline miss: the new "select the existing
  row" path skipped the refresh a row click does. Tallied PIPE per the body.
- #371's round 2 is the only correction caused by a previous fix, and it was a
  misplaced function, not a behaviour change.
- No orchestrator-relayed correction this time (§8).

## 3. Cause tally

Counted per applied correction row. TASTE: none this campaign.

| Code                    | This campaign | Batch C (#365-#367) | 2026-10-06 (#355-#358) | 2026-10-05b | Baseline (#229-#243) |
| ----------------------- | ------------- | ------------------- | ---------------------- | ----------- | -------------------- |
| FIX                     | 0             | 0                   | 1                      | 1           | ~30                  |
| DOC                     | 1             | 0                   | 6                      | 3           | ~12                  |
| NUM                     | 0             | 0                   | 3                      | 3           | ~10                  |
| VAC                     | 0             | 0                   | 1                      | 2           | ~9                   |
| PIPE, SCOPE, DIAG       | 1             | 1                   | 3                      | 0           | ~10                  |
| CTX                     | 0             | 0                   | 0                      | 1           | 5                    |
| GATE, HARD              | 0             | 0                   | 5                      | 0           | ~14                  |
| VIS                     | 0             | 1                   | 3                      | 2           | 0                    |
| **Total (excl. TASTE)** | **2**         | **2**               | **22**                 | **12**      | not totaled          |

- Per-PR codes: #370 0, #371 2.
- Within the PIPE/SCOPE/DIAG row: PIPE 1 (#371), SCOPE 0, DIAG 0.
- Corrections caused by the previous round's own fix: **1 of 2** (#371 DOC).
- Behaviour-layer corrections: 1 (#371 PIPE). Prose-layer: 1 (#371 DOC).
- "Moved vs baseline": every per-code count is at or below baseline, but 2
  corrections cannot say a code stopped happening.

## 4. TASTE

**0 items tagged TASTE.** Nothing was found and declined.

## 5. VIS

- **No VIS catch.** Neither live check found a defect in its PR (§8).
- **Orchestrator read of #371's prose diff** (VIS gate, no correction): #371
  skipped a separate prose pass because its only prose was two CHANGELOG
  bullets and one tech-debt line. The orchestrator read that diff instead and
  asked for nothing. Orchestrator-observed.
- #370 had its `low` prose pass, so no orchestrator read was needed.

## 6. Score per PR

Behaviour corrections = behaviour-layer corrections with a real cause
(excludes TASTE and clean rows). Defects closed = tech-debt defects the PR
fixed, counted from the body and
`git show <merge-sha> -- docs/tech-debt.md`. Sections opened =
`git show <merge-sha> -- docs/tech-debt.md | grep '^+## '`.

| PR        | Behaviour corrections | Defects closed | Sections opened | Fixed inline | Behaviour rounds | Prose rounds |
| --------- | --------------------- | -------------- | --------------- | ------------ | ---------------- | ------------ |
| #370      | 0                     | 1              | 0               | 0            | 1 (clean)        | 1 (clean)    |
| #371      | 1                     | 2              | 0               | 0            | 1 (1 PIPE)       | 1 (1 DOC)    |
| **Total** | **1**                 | **3**          | **0**           | **0**        | 2                | 2            |

- Behaviour rounds are `/code-review` round 1; prose rounds are the `low`
  passes. The two columns sum to 4.
- **#370: 1 defect** (cycle item 1): the "N of M zones still blank" message was
  informational and the real warning arrived after the download. Two bullets
  came out of "New chair artwork lands on one zone…" (the 7-of-8 bullet and the
  sample-on-the-far-flank bullet), counted as one defect because both are item
  1. The body says "first two bullets closed".
- **#371: 2 defects** (cycle item 13): the sample could be loaded twice, and
  the sample raised a "give it a size" note. Both were the sample clause of the
  section's "Closing it" line, which was trimmed to the zone-select text.
- **Section stays open.** "New chair artwork lands on one zone, so a one-sided
  chair is the default path" keeps the zone-select bullet (cycle item 14).
  Narrowed twice, not closed.
- `docs/tech-debt.md` section count is 39 before #370 and 39 after #371.
  Reproduce with `git show f2a0e16^:docs/tech-debt.md | grep -c '^## '` and
  `git show c4450db:docs/tech-debt.md | grep -c '^## '`.

## 7. Levers applied

| Lever                        | #370 | #371 |
| ---------------------------- | ---- | ---- |
| Test failing on `main` shown | yes  | yes  |
| Mutation run                 | yes  | yes  |
| Numbers cite their command   | yes  | yes  |
| State sketch in body         | yes  | yes  |
| Live check                   | yes  | yes  |

- #370: new tests fail on `main` (3 failures on main, 0 on the branch):
  `npx vitest run tests/exportPanel.test.ts tests/rebuild-scene.test.ts`. One
  mutation reported: widening or loosening `zoneCovered < zoneTotal` fails
  "adds nothing when every zone is covered".
- #371: `npx vitest run tests/sampleArtwork.test.ts` gave 5 failed | 3 passed
  with only `SAMPLE_SVG` exported. 4 mutants (notice guard, persisted origin,
  select-existing branch, `refreshFitInputsFromState`), each failing its test.
- #371 ran a readers check: `grep -rn "origin" src --include=*.ts`, the lever
  from the CLAUDE.md shared-value rule. Only the notice branch treats
  `'sample'` differently.
- Both bodies carry a state sketch for the warning lifecycle. #371's is "no
  warning added or cleared".
- The trap-file lever is not reported in the bodies; not scored.

## 8. Process misses and null results

- **Null result, #370 live check.** A separate sonnet-medium agent drove it
  after the PR opened. It marked step 3 FAIL for the "Saved …" status line
  under Export. That is #366's intended behaviour, so it is a checker misread,
  not a defect. No correction, not a round. Orchestrator-observed.
- **Null result, #371 live check.** No defect in the PR. It noted the
  drop-area filename is blank after a session restore. Pre-existing on main:
  restore never sets `#svg-fname` (`git grep -n "svg-fname" origin/main -- src`
  finds only `artworkListPanel.ts:219` and `artworkPanel.ts:34`). Not caused
  by #371, not filed here.
- **No cross-PR collision.** The PRs ran in parallel worktrees. #370 merged
  first and #371 rebased onto it; both touched the tech-debt section and
  CHANGELOG. The orchestrator relayed the rebase note. Nothing interacted,
  unlike #365 into #367.
- **Prose pass skipped on #371**, with the stated reason in §5. Its one prose
  correction (DOC, misplaced function) came from round 2.
- Neither live check counted as a round, unlike #366 in batch C.
- Orchestrator facts (live-check results, the rebase relay, the VIS read) are
  the orchestrator's account, not reproducible by command.

## 9. Sources

- PR bodies: `gh pr view <n> --json body,title,mergeCommit,mergedAt` for `n` in
  370-371. Merge SHAs: #370 `f2a0e16`, #371 `c4450db`.
- Baseline: `git show d61529b^:docs/process-review-2026-08.md`.
- Earlier figures: `docs/findings/2026-10-06-round-trip-measurement-c.md`,
  `docs/findings/2026-10-06-round-trip-measurement.md`,
  `docs/findings/2026-10-05-round-trip-measurement-b.md`.
- Section counts and defects: `git show <merge-sha> -- docs/tech-debt.md`.
