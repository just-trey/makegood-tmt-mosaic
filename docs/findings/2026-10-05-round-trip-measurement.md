# Round-trip measurement: UI fix campaign (2026-10-05)

**Round counts fell again; the cause tally is too small to compare.** Mean
rounds per PR is 2.3 (3 PRs, #344-#346, 7 rounds) against the 2026-09-24
campaign's 2.9 and the 2026-08 baseline's ~4.6. Three corrections in total
(2 DOC, 1 VIS), against 94 over 18 PRs last time, so no cause moved in
a way that means anything. Only 3 PRs, all `sonnet-medium` UI or state
items: a small sample, not a trend.

Covers #344, #345, #346 (merged 2026-10-05). PR round tables pulled with
`gh pr view <n> --json body` for `n` in 344-346.

## 1. Rounds per PR

| PR       | What                                                  | Rounds                  |
| -------- | ----------------------------------------------------- | ----------------------- |
| #344     | Corner handle wins over the rotate handle on a pick   | 2                       |
| #345     | Undo a chair variant switch when a mount fails        | 2                       |
| #346     | Color list percentages by surface area, not triangles | 3                       |
| **Mean** | **3 PRs**                                             | **2.33** (7 rounds / 3) |

All three: `sonnet-medium`, round 1 `/code-review medium`. Same counting basis
as 2026-09-24 (the clean final round is its own row), so the 2.3 compares
directly with that campaign's 2.9. The baseline left clean final rounds out,
so counting them here makes 2.3 conservative: it understates the drop against
the baseline's 4.6.

## 2. Corrections per round

| PR   | Round            | Correction                                                       | Layer     | Cause | Introduced by previous fix? |
| ---- | ---------------- | ---------------------------------------------------------------- | --------- | ----- | --------------------------- |
| #344 | 1 (medium)       | none                                                             | -         | -     | -                           |
| #344 | 2 (low, prose)   | Comment overstated "clear of the corners"; CHANGELOG misreadable | prose     | DOC   | No                          |
| #345 | 1 (medium)       | none                                                             | -         | -     | -                           |
| #345 | 2 (low, prose)   | none                                                             | -         | -     | -                           |
| #346 | 1 (medium)       | Test comment said footprint 50, helper returns 25                | prose     | DOC   | No                          |
| #346 | 2 (orchestrator) | XZ projection read 2-7% of design area on sideways chair zones   | behaviour | VIS   | No (first-version design)   |
| #346 | 3 (low)          | none                                                             | -         | -     | -                           |

## 3. Cause tally

Counted per correction row.

| Code                    | This campaign | 2026-09-24 | Baseline (#229-#243) |
| ----------------------- | ------------- | ---------- | -------------------- |
| FIX                     | 0             | 18         | ~30                  |
| DOC                     | 2             | 34         | ~12                  |
| NUM                     | 0             | 16         | ~10                  |
| VAC                     | 0             | 8          | ~9                   |
| PIPE, SCOPE, DIAG, CTX  | 0             | 16         | ~15                  |
| GATE, HARD              | 0             | 2          | ~14                  |
| VIS                     | 1             | 0          | 0                    |
| **Total (excl. TASTE)** | **3**         | **94**     | not totaled          |

- Per PR: 1.0 corrections now, 5.2 last campaign.
- Corrections caused by the previous round's own fix: **0 of 3**.
- Only VIS is new. It is the one behaviour-layer correction in the campaign.

## 4. TASTE

**0 corrections tagged TASTE.** No baseline counterpart (the 2026-08 review
never coded it); tallied on its own per the fix-campaign skill step 5.

## 5. VIS

- **#346 round 2 is the campaign's only behaviour correction, and `/code-review`
  did not find it.** Round 1 (medium) found only a test-comment DOC.
- The first fix projected each inlay soup onto XZ (inlays are cut along Y).
  The orchestrator read the diff and doubted it for sideways zones.
- The agent measured it on the real chair build: Y footprint read 60-250 mm²
  on four zones whose cap area is 3669-3719 mm² (design 3600 mm²), 2-7%.
  Switched to 3D cap area (`soupCapArea`). Measurement and reproduction
  script are in #346's body.
- A unit test with flat bands passed either way. Only the real chair build
  showed the gap, the same "look at the output" lesson as earlier campaigns.

## 6. Score per PR

Defects closed = behaviour-layer corrections with a real cause (excludes
TASTE and clean rows). Sections opened =
`git show <merge-sha> -- docs/tech-debt.md | grep '^+## '`.

| PR        | Defects closed | Sections opened | Fixed inline | Behaviour rounds | Prose rounds |
| --------- | -------------- | --------------- | ------------ | ---------------- | ------------ |
| #344      | 0              | 0               | -            | 1 (clean)        | 1 (1 DOC)    |
| #345      | 0              | 0               | -            | 1 (clean)        | 1 (clean)    |
| #346      | 1              | 0               | -            | 2 (1 VIS)        | 1 (1 DOC)    |
| **Total** | **1**          | **0**           | **0**        | 4                | 3            |

- #346's round 1 is counted behaviour (a code review) and its DOC row prose;
  its prose pass shared the round. Totals are not additive to 7 rounds.
- Each PR closed one tech-debt section and opened none. `docs/tech-debt.md`
  went from 32 to 29 sections (`git show 928a716^:docs/tech-debt.md | grep -c '^## '`
  and `grep -c '^## ' docs/tech-debt.md` on `c09aa9e`).
- Fixed inline: none identified. The bodies carry no second-defect bullet.
- No narrowed-not-closed result: each item closed clean.

## 7. Levers applied

| Lever                        | #344 | #345 | #346 |
| ---------------------------- | ---- | ---- | ---- |
| Test failing on `main` shown | yes  | yes  | yes  |
| Mutation run                 | no   | yes  | yes  |
| Numbers cite their command   | yes  | yes  | yes  |
| Measured on the real build   | no   | no   | yes  |

- #344 body does not report a mutation run. Its test was shown failing on
  `main` by swapping the two pick lines back.
- #346 is the only one with a real-build measurement, and the only one with a
  behaviour correction.

## 8. Process misses (not in the round tables)

- **Skipped prose pass.** #344 and #345 ended their first turn without the
  final `low` prose pass the brief required; the orchestrator sent each back
  once. #346's agent listed a round-2 row it had not run; the orchestrator had
  it removed and the round was run for real. The Rounds tables above are the
  corrected ones.
- **Rebase conflicts, all CHANGELOG.** #345 conflicted once; #346 twice (one
  per commit). Orchestrator resolved. Same shape as the skill's step 3 note.
- **Flaky test.** `tests/build-worker.test.ts` failed once under full-suite
  load in two agents' local runs and passed on rerun alone. CI never failed.
  Not investigated here.

## 9. Null results and live checks

- No null result: all three items closed as planned.
- **Live checks caught nothing review missed.** The user ran all three by
  hand on merged `main`; all passed. #346's miss was caught before merge by
  the orchestrator read (§5).

## 10. Sources

- PR bodies: `gh pr view <n> --json body,mergeCommit` for `n` in 344-346.
  Merge SHAs: #344 `928a716`, #345 `fa41f55`, #346 `c09aa9e`.
- Baseline: `git show d61529b^:docs/process-review-2026-08.md`.
- 2026-09-24 figures: `docs/findings/2026-09-24-round-trip-measurement.md`.
- Section counts and CHANGELOG bullets:
  `git show <merge-sha> -- docs/tech-debt.md CHANGELOG.md`.
- Orchestrator facts in §8 and §9 (skipped passes, rebases, flake, live
  checks) are the orchestrator's account, not reproducible by command.
