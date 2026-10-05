# Round trips on the second 2026-08-29 fix campaign (#267-#270)

**Result: the code-defect classes improved and the round count got worse, because
the rounds moved into prose.** Across the three code PRs the mean was **6.7
review rounds** against the baseline's ~4.6 — but VAC fell to 1 across the whole
campaign and FIX per PR fell from ~2.7 to 2.0, while **NUM and DOC roughly
quadrupled per PR**. On the two long PRs the shipped code was correct early and
every later round found a defect in documentation the agent had written during
the review itself. #270 makes this measurable: its author tagged each round
`behaviour` or `prose`, and **every round from 2 to 10 is `prose`**.

This is the second campaign running to land on that. The prior report's #264
(15 rounds on 3 files) was called "a finding about reviewing prose, not about
the levers"; this run reproduces it twice without a docs-only PR involved.

Pinned to `main` at `ae71833` (#270). Campaign run 2026-08-29 by four
worktree subagents, one per item, on the models the plan assigned. Round tables
are copied from the PR bodies, not re-derived — recover them with
`gh pr view <n> --json body` for n in 267 268 269 270. File and line counts are
`gh pr view <n> --json changedFiles,additions,deletions`.

## Rounds per PR

| PR   | Item                          | Model  | Files | +/-      | Rounds | Corrections | Cut       |
| ---- | ----------------------------- | ------ | ----- | -------- | ------ | ----------- | --------- |
| #267 | Part-switch confirm dropped   | Sonnet | 4     | +125 -60 | 2      | 0           | none      |
| #268 | 13 troubleshooting sections   | Sonnet | 3     | +284 -67 | n/a    | 1 (VIS)     | none      |
| #269 | Traced-image color loss       | Opus   | 11    | +628 -60 | 8      | 16          | one area  |
| #270 | Zero-depth warning collection | Opus   | 9     | +301 -30 | 10     | 19          | two areas |

- Code PRs (#267, #269, #270): mean **6.7** rounds, against the baseline's ~4.6
  over 11 code PRs. Worse on the headline number.
- #268 is docs-only and took no `/code-review`, per CLAUDE.md's prose exemption.
  It is excluded from the round mean and carries the campaign's only VIS row.
- Clean final rounds are counted, matching the prior two reports.
- No PR bundled findings. #269 promoted three items to `tech-debt.md` rather
  than fixing them; #270 promoted the clamp half of its parent section.

## Cause tally, against the 2026-08 baseline

Baseline is 11 code PRs (#229-#243, ~57 rounds). Per-PR columns are the fair
comparison, since this campaign has 3 code PRs against the baseline's 11.

| Cause | Baseline total | Baseline per PR | This run | Per PR | Direction  |
| ----- | -------------- | --------------- | -------- | ------ | ---------- |
| FIX   | ~30            | 2.7             | 6        | 2.0    | **better** |
| VAC   | ~9             | 0.8             | 1        | 0.3    | **better** |
| DOC   | ~12            | 1.1             | 12       | 4.0    | **worse**  |
| NUM   | ~10            | 0.9             | 13       | 4.3    | **worse**  |
| SCOPE | on 4 PRs       | —               | 1        | 0.3    | comparable |
| GATE  | ~12            | 1.1             | 0        | 0      | **better** |
| CTX   | 5              | 0.5             | 0        | 0      | better     |
| PIPE  | 3              | 0.3             | 0        | 0      | better     |
| DIAG  | 3              | 0.3             | 0        | 0      | better     |

**TASTE (2) is tallied separately and has no baseline counterpart** — the
original review did not track "found, judged not worth fixing" as its own code,
so folding it into any baseline bucket would compare two different taxonomies.
Both rows are round-ending: #269 round 8 and #270 round 10.

**VIS (1) is not comparable to the baseline's 0 either.** The baseline scored 0
because #229-#243 all merged within minutes with no human look — VIS measured
the absence of that look, not its success. This campaign's PRs got an
orchestrator read before merge, so a VIS row appearing is the mechanism working,
not a regression. Detail below.

### Fix-introduced defects

| PR   | Corrections from the previous round's fix |
| ---- | ----------------------------------------- |
| #267 | 0 of 0                                    |
| #269 | 6 of 16                                   |
| #270 | 10 of 19                                  |

Baseline was ~2.7 per PR; the prior campaign got it to 1.0. This run is **5.3
per code PR**, the worst of the three. Every one of #270's ten is in prose.

## What the rounds were actually spent on

#270's author added a `Layer` column to its Rounds table, splitting each
correction into `behaviour` (shipped code) and `prose` (comments, CHANGELOG,
tech-debt, troubleshooting, PR body). The result:

| PR   | Behaviour rounds | Prose rounds |
| ---- | ---------------- | ------------ |
| #267 | 2 (both clean)   | 0            |
| #269 | 1-6              | 7-8          |
| #270 | 1                | 2-10         |

#270's shipped diff was correct and complete after round 1. Rounds 3-10 each
independently re-verified the geometry and found nothing wrong with it, then
found something wrong with a sentence. Nine consecutive rounds of that is the
single clearest measurement this campaign produced.

#269 is the mixed case and the more interesting one: its behaviour rounds were
real, and they converged rather than accreting. Round 4 cut the two-armed
message rather than patch it a third time; round 6 replaced three accumulated
rules with the single measurement they approximated. That is the cut-the-area
guard and the don't-invent-a-constant guard both firing as written. Its prose
rounds (7-8) then behaved exactly like #270's.

### Two areas cut, per the same-area-twice rule

- **#269, the printable arm of the empty-trace message.** Round 3 found a wrong
  claim, round 4 found the fix's replacement claim also wrong in the other arm.
  Cut rather than patched a third time.
- **#270, a troubleshooting sentence enumerating when a too-deep depth is
  named.** Three drafts each named a different incomplete set; the fourth
  attempt failed too. Deleted, and the thread recorded deliberately _without_ an
  enumeration, on the finding that writing one from outside the code kept
  failing.
- **#270, a duplicate tech-debt section.** Produced a defect in three
  consecutive rounds; deleted, measurements folded into the existing
  "An interpolation counts as one word" row rather than split across two
  destinations.

## The VIS row: what the pre-merge look caught

#268 is docs-only, so no `/code-review` ran on it. The orchestrator read
caught a real defect the gates could not: deleting the closed
"More shipped warnings have no troubleshooting section" section orphaned a
`(above)` cross-reference in the surviving quote-gate section, which also still
cited **73 quotes found / 62 checked / 11 skipped / 7 of 42 sections unpinned** —
figures that PR itself moved. Sent back rather than fixed in the merge, since
inventing corrected numbers inside a conflict resolution is the exact
unmeasured-number failure CLAUDE.md names. The author then found and fixed a
fifth stale figure nobody had asked about ("one of the seven" → "one of the
nine"), and re-measured the leading-capital count rather than assuming it,
confirming only its denominator moved.

`npm run check:troubleshooting` on the merged result: **85 quotes checked
against 2577 shipped strings, 19 too short to pin, 9 of 57 sections unpinned**,
PASS.

**The same look also rejected a finding.** A review sub-pass on #267 reported a
stale comment in `partPanel.ts` justifying an eager `renderWarnings()` by
pointing at a cancel path the diff deletes. It is not stale: the comment cites
`cancelHonoured()` in `app/scheduler.ts`, the _rebuild_ cancel, which the diff
never touches. Acting on it would have removed an accurate comment. Null result,
recorded because a wrong finding relayed to a working agent costs a full round.

## Null results and things that did not happen

- **No live driven check was required or run.** The plan called none of the four
  items as needing one, and nothing in the merged result contradicts that.
  #270's author drove one anyway (GPU Playwright, four-colour design, Depth 0 →
  one pill) and it agreed with the unit tests. No trap from the skill's step 4
  fired, because no step-4 check ran.
- **`push()` in `src/warnings.ts` was not touched**, by any agent. The
  tech-debt section warning against it is doing its job; #269 in particular
  needed a new keyed notice and routed around it with its own key
  (`${sourceId}:colors`) and the existing dismiss-before-notice ordering.
- **`gh pr merge --admin` was never used.** Every merge waited for `CLEAN`.
- **Three of four agents stalled waiting on their own background gate runs**
  and needed a `SendMessage` to continue — the same trap the skill records from
  the previous campaign, at the same rate (3 of 5 then, 3 of 4 now). The skill
  documents it; documenting it has not reduced it.

## Not fixed here

`package.json`'s version drifts 0.6.0 → 0.7.0 in `package-lock.json` on `npm
install` in a fresh worktree. All four agents hit it; all four reverted it by
hand to keep their diffs scoped. It wants its own one-line PR and nobody has
opened one.

## What this suggests

The levers introduced by the previous campaign are working on what they were
aimed at: VAC is nearly gone, GATE/CTX/PIPE/DIAG are at zero, FIX is down. The
cost has moved rather than disappeared. It now sits in the write-ups the process
itself mandates — tech-debt sections, troubleshooting entries, CHANGELOG bullets
and PR bodies — where a reviewer will always find another sentence to sharpen
and where a wrong sentence is cheap to introduce and expensive to catch.

Two candidate readings, neither measured:

- **Prose rounds have no natural stopping rule.** "Wrong output" is decidable;
  "this sentence overstates it" is not, so the stop-on-taste rule does not bite
  where it is most needed. #270 ran nine prose rounds and its author still
  described round 10 as clean rather than as the point the rule should have
  stopped it at round 2.
- **The write-ups are being reviewed at the same effort as the code**, though
  they ship nothing. A cheaper pass over prose, or one pass at the end instead
  of one per round, would have cost this campaign little and saved most of its
  rounds.

Testing either means running a campaign with an explicit prose-round budget and
comparing. That is a process change, not a measurement, so it is written here
rather than acted on.
