# Process review, 2026-08

**Headline: the round trips are not mainly caused by guardrails.** Across #229–#243
there were ~57 `/code-review` rounds and zero human review rounds (every PR merged
within minutes of opening). The dominant causes, in order: a fix in round N
introducing the defect round N+1 finds; several findings bundled into one PR; tests
that could not fail; and numbers in write-ups that did not reproduce. Guardrails
were the direct cause in exactly one cluster: the copy gate itself (#240–#242),
which cost ~13 rounds and has so far mostly caught damage its own sweep created.

Method: commit count and PR body per PR. All rounds happened pre-push, so
"round" = one `/code-review` pass acted on. Where a PR body gives no per-round
detail (#236) the count is taken from the body and the causes are marked guess.

## 1. Round trips per PR

| PR   | What                        | Files | Rounds | Commits | Kind                        |
| ---- | --------------------------- | ----- | ------ | ------- | --------------------------- |
| #229 | Session restore, six T0s    | 10    | 7      | 7       | code, stateful              |
| #230 | Assembly depth bound        | 13    | 4      | 5       | geometry                    |
| #231 | Tower warning + stale pills | 12    | ~6     | 7       | code, two T0s               |
| #232 | Cancel latency              | 11    | 3      | 4       | perf, measured              |
| #233 | Depth hint + radius guard   | 8     | 4      | 4       | UI validation               |
| #234 | Dropdown order              | 5     | 2      | 1       | trivial                     |
| #235 | px-as-mm SVG                | 13    | 3      | 1       | parser                      |
| #236 | Feedback widget             | 15    | 7      | 1       | feature, 842 lines          |
| #237 | Dead console filter         | 2     | 0      | 1       | tooling                     |
| #238 | CLAUDE.md judgment rules    | 1     | 0      | 1       | docs                        |
| #239 | ship-it 2c test-first       | 1     | 0      | 1       | docs                        |
| #240 | Copy gate + type-aware lint | 43    | 6      | 8       | guardrail, split at round 4 |
| #241 | Copy gate blind spots       | 5     | 4      | 6       | guardrail                   |
| #242 | Help dialog rewrite + gate  | 12    | 3      | 4       | copy + guardrail            |
| #243 | Hide Recess bg              | 11    | 4      | 1       | UI                          |

- Four docs/tooling PRs: 0–2 rounds. Eleven code PRs: mean ~4.6 rounds.
- Rounds correlate with **number of distinct findings in the PR** and with
  **statefulness**, not with line count alone: #235 (545 lines, one bug) took 3;
  #229 (six findings) took 7; #234 (24 lines) still took 2.

## 2. The specific corrections and their causes

Cause key: **FIX** fix-introduced defect · **VAC** test could not fail ·
**NUM** unmeasured or non-reproducing claim · **DOC** doc/quote drift ·
**PIPE** bypassed an existing helper/pipeline · **CTX** context existed in the
repo and was not read · **SCOPE** too many findings in one PR · **DIAG**
diagnosis wrong before fixing · **HARD** genuinely hard, iteration normal ·
**GATE** cost of a guardrail itself · **VIS** only the user could see it.

### #229 session restore (7 rounds)

| Round | Correction                                                                 | Cause     |
| ----- | -------------------------------------------------------------------------- | --------- |
| pre   | T0-6 first fix rejected older sessions as corrupt                          | DIAG      |
| 1     | hold defaulted on, never released → kept emptied sessions (regression)     | FIX, HARD |
| 2     | hold armed at boot but never ended on a bare boot                          | FIX, HARD |
| 2     | a test "pinning nothing": passed with feature removed                      | VAC       |
| 3     | save armed before Restore clobbered the restore; test passed regardless ×2 | FIX, VAC  |
| 4     | unparseable session held forever                                           | FIX       |
| 4     | test failed under `--coverage` only (guessed a microtask count)            | VAC       |
| 5     | failed-restore state written straight back by next save                    | FIX       |
| 5,6   | troubleshooting section wrong, corrected twice                             | DOC       |
| 6     | disabling writes silenced the unload prompt; message erased itself         | FIX       |

Three tests passed vacuously; only mutation runs showed it. Six findings in one
PR (SCOPE). The arm/hold/release state machine was designed by iteration inside
review rather than sketched first: that is the whole of rounds 1–6.

### #230 depth bound (4 rounds)

| Round | Correction                                                                                                 | Cause    |
| ----- | ---------------------------------------------------------------------------------------------------------- | -------- |
| pre   | measured upstream, broke five chair builds                                                                 | PIPE     |
| 1     | measured along `patchNormal`, not the Y cut axis (`throughDepth()` in the same class already did it right) | CTX, FIX |
| 1     | clamp landed coplanar with the back face; uncached O(vertices) scan per colour                             | FIX      |
| 2     | negative extent floored to 0.2mm; own test satisfied by `< 20`                                             | FIX, VAC |
| 3     | same defect, fixture used `topZ: -90`                                                                      | FIX, VAC |
| 4     | same defect a third time, fixture used `-90` again; rotated copy double-warned                             | FIX, VAC |
| 3,4   | tech-debt/pipeline/help said the wrong thing; 48.5 vs 48.45 in three docs                                  | DOC      |

The same bug three rounds running, each dodged by a sign. Memory's "cut the
area when a round finds a defect in the previous round's fix twice" existed and
was not applied here; it would have stopped this at round 3.

### #231 tower warning (~6 rounds)

| Correction                                                                      | Cause     |
| ------------------------------------------------------------------------------- | --------- |
| rewording over-corrected the mixed case; dropped the coordinates                | FIX       |
| rewording broke `export-hubcap-examples.mjs` (matched a stale fragment)         | FIX, DOC  |
| two assertions matched strings no source emitted                                | VAC       |
| per-caller clears in `.finally()` wiped pills on a cancelled confirm ×5 sites   | PIPE, FIX |
| hubcap diameter/silhouette controls cleared before deciding if anything changed | FIX       |
| help/README stated the wrong condition twice                                    | DOC       |
| **pre-existing** `allBlocked` counted single-filament plates                    | (win)     |

Two T0s plus a pre-existing exporter bug in one PR (SCOPE). The review that
found `allBlocked` ran the exporter: that is review earning its keep.

### #232 cancel latency (3 rounds)

| Correction                                                                 | Cause |
| -------------------------------------------------------------------------- | ----- |
| cycle's diagnosis pointed at the cutter loop; fix there gave 132s not 0.3s | DIAG  |
| "sat at 11% the whole time" (measured once, at t+10s)                      | NUM   |
| reused a 2026-08-17 heap figure for call sites added since                 | NUM   |
| flat-cancel rationale already false when written                           | NUM   |
| merge loop had the same yield point and no check                           | FIX   |
| all three cancel sites shipped unexercised                                 | VAC   |
| findings report written after review asked for it                          | DOC   |

The measurement caught the wrong diagnosis in the first commit. Normal.

### #233 depth hint + radius (4 rounds)

| Correction                                                                       | Cause |
| -------------------------------------------------------------------------------- | ----- |
| hint said "cut at"; `zeroDepthWarning`'s docstring says exactly not to           | CTX   |
| hand-rolled radius guard instead of `bindShapeInput` (1200mm radius on retype)   | PIPE  |
| restore assigned `asmRadius` verbatim, bypassing the guard                       | FIX   |
| `min="0.01"` under `step="0.5"`: field `:invalid` from page load                 | FIX   |
| restore guard `> 0` vs field floor `0.5`: two copies of one bound drifted        | FIX   |
| `state.globalDepth` unguarded ten lines above the new guard                      | CTX   |
| `bindShapeInput` last-good cache never followed a restore (latent, pre-existing) | (win) |

CLAUDE.md's "open every reader of a shared value" and Rule 2 (route through
the shared pipeline, landed #238 the next day) name both of these.

### #234 dropdown order (2 rounds): README ordering sentence left stale. DOC.

ship-it step 2 lists README as a drift doc and the skill did not catch it;
`/code-review` did.

### #235 px-as-mm (3 rounds)

"Set viewBox" export shape was a second silent 75% (FIX, missed case); a
single-axis fallback silently reproduced the headline bug (FIX); a pre-existing
Fill defect found and filed (win). Verified in the exported 3MF, not a string.

### #236 feedback widget (7 rounds): body says "six each fixing a real defect

the previous round introduced or missed", no per-round detail. FIX ×6, SCOPE
(842 lines, one PR). Guess. Also one infra hiccup: no `pull_request` webhook
fired, nudged by hand.

### #240 copy gate (6 rounds, split at round 4)

| Correction                                                                       | Cause                      |
| -------------------------------------------------------------------------------- | -------------------------- |
| em-dash ban scoped to code comments too; policy corrected                        | DIAG                       |
| sweeping 53 dashes created 7 comma splices and 8 run-ons                         | GATE, FIX                  |
| gate silently skipped 23 of 267 strings (three AST bugs)                         | GATE, FIX                  |
| lazy `^(.*?),` tested only the first comma                                       | GATE, FIX                  |
| 127 / 267 / 220 strings cited in the same doc; "26 across 4" was 26 across 10    | NUM                        |
| flag named for the help dialog exempted all of index.html                        | NUM                        |
| troubleshooting.md quotes drifted three separate times                           | DOC ×3                     |
| CLAUDE.md said the opposite of the new docs rule; CONTRIBUTING listed five gates | DOC                        |
| tech-debt note quoted a section in an unmerged sibling PR                        | SCOPE                      |
| **real**: off-plate warning "Reposition..." could never clear (case)             | (win, via test-first)      |
| **real**: `isFilamentList` narrowed on truthiness                                | (win, via type-aware lint) |

### #241 copy gate blind spots (4 rounds)

| Correction                                                                       | Cause          |
| -------------------------------------------------------------------------------- | -------------- |
| const map unscoped: two functions' `label` collided; `let` matched as const      | GATE, FIX      |
| `>text<` missed leading/trailing prose → split on tags                           | GATE, FIX      |
| shadowed parameter got a const substituted                                       | GATE, FIX      |
| quote-aware tag regex leaked past `title="depth > 0"`                            | GATE, FIX      |
| same regex broke on an apostrophe, measured a comment as copy, passed by 3 words | GATE, FIX      |
| markup splitting **cut** after the third defect                                  | (rule applied) |
| "read a pasted 0x as hex" was invented; 6→2 sites; 14→19; 5→8→9 parseFloat       | NUM ×4         |
| doc paragraph rewritten twice, neither landed (script threw before writing)      | tooling        |

### #242 help dialog (3 rounds)

| Correction                                                               | Cause                         |
| ------------------------------------------------------------------------ | ----------------------------- |
| parse5 entity decoding fooled `isMarkup()`, skipping four of five checks | GATE, FIX                     |
| round-1 fix dropped the SVG `<text>` path's markup fallback              | FIX                           |
| five facts dropped by the rewrite for length, restored over three rounds | GATE (word-count target), FIX |
| one "dropped" fact was stale; left out on evidence from a test           | (win)                         |
| design-system still described the '?' circle; hover tint lost            | DOC, VIS-adjacent             |

### #243 hide Recess bg (4 rounds): rounds 1–3 wrong output including one

introduced by round 2's fix (FIX ×3, no detail in body); audit drive script
sampled the now-hidden control (CTX, the trap was documented eight lines
above); design-system exemplar pointed at it (DOC). Falsified both ways: the
best-evidenced PR in the set.

### Tally

| Cause | Corrections | Where it concentrates                                                 |
| ----- | ----------- | --------------------------------------------------------------------- |
| FIX   | ~30         | every code PR; worst in #229, #230, #236, #241                        |
| GATE  | ~12         | #240–#242 only                                                        |
| DOC   | ~12         | troubleshooting quotes, help/README conditions, numbers in three docs |
| VAC   | ~9          | #229 ×3, #230 ×3, #231 ×2, #232                                       |
| NUM   | ~10         | #232, #240, #241                                                      |
| CTX   | 5           | #230, #233 ×2, #243                                                   |
| PIPE  | 3           | #230, #231, #233                                                      |
| SCOPE | 4 PRs       | #229, #231, #236, #240                                                |
| DIAG  | 3           | #229, #232, #240                                                      |
| VIS   | 0           | no correction in this window came from the user looking at the app    |
| HARD  | 2 areas     | #229 restore state machine, #230 tilted-face geometry                 |

**VIS = 0 is itself a finding.** Every PR merged within minutes of opening.
The user is not in the loop before merge, so "only I can verify visually" never
had a chance to be a cause. Whether that is a problem depends on whether the
maintainer wants to be; the data cannot say.

## 3. Which rules have earned their place

### Earned, with an incident

| Rule (where)                                                 | Incident it caught or would have                                                                                                                |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Review again after acting on findings (CLAUDE.md, ship-it 3) | #229 r4 save-clobber, #231 `allBlocked`, #232 memo gap, #235 single-axis, #243 r2-introduced defect. Also the source of most FIX rounds; see §5 |
| Cut the area on the second repeat (memory only)              | Applied in #241 after three; #230 ran three rounds on one sign bug without it                                                                   |
| Bug-fix test seen to fail (ship-it 2c, #239)                 | Caught the "Reposition..." case bug on #240 the day it landed; the suite was green                                                              |
| Open every reader of a shared value (CLAUDE.md)              | #233 radius floor in two places; `globalDepth` on restore                                                                                       |
| Rule 2 route through the shared pipeline (#238)              | #233 hand-rolled guard vs `bindShapeInput`; #231 five `.finally()` clears vs `onAssemblyPartsChanged`                                           |
| Rule 4 no perf claim without a measurement                   | #232 reused heap figure; #230 uncached scan was measured (16 × 53,904) before being called a cost                                               |
| Never invent a constant                                      | #233 radius rejected rather than floored at a number nobody measured                                                                            |
| Type-aware `no-unsafe-*` (lint)                              | 12 sites, `isFilamentList` truthiness narrowing (#240)                                                                                          |
| `radix` (lint)                                               | one latent site; cheap, keep                                                                                                                    |
| Troubleshooting section per warning                          | #231 added the missing placement family; but see drift under §4                                                                                 |
| Findings report per investigation                            | #232's null result (132s) is only recorded there                                                                                                |
| Verify by running the app                                    | #229 T0-1 seen only with the confirm hook removed; #235 measured in the 3MF; #243 smoke assertion                                               |
| Split a diff that needs four rounds                          | #240 split into #238/#239 at round 4                                                                                                            |

### Never caught anything in this window, low cost: keep

DECISIONS-NEEDED gate (ship-it 0), comments rules, docs writing style,
Opus/Sonnet split (no evidence either way; #242 ran on Fable), coverage floors
(one incidental cost: #229's test flaked under `--coverage`), convention
numbering (cited once, #243 conv 7). None generated a round.

### Cost exceeded evidence so far

| Rule                                  | Cost                                                                                                           | What it caught                                                                                                                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Copy gate `check:copy`                | ~13 rounds across three PRs, 18 commits, one built-and-reverted area, one help rewrite that dropped five facts | 7 splices + 8 run-ons **created by its own sweep**; one 22-word tower warning; the case bug came from 2c not the gate. Net value going forward is a **guess**            |
| ship-it step 2 drift table            | judgment, ran every PR                                                                                         | Missed README in #234, help/README in #231 twice, troubleshooting quotes in #240 three times. `/code-review` caught all of them, so the step is paying for a second pass |
| "Every number reproduces" (unwritten) | two full rounds in #240 and #241 spent on counts                                                               | Not a rule; Rule 4 covers perf only                                                                                                                                      |

### Enforced in the wrong place

- **Troubleshooting quote drift** is a judgment step that failed six-plus
  times. It is mechanical: a quote must be a substring of a string the gate
  already extracts. Lint that should exist.
- **Placement suffix registration** was the same shape; #231 built the test.
  Precedent for the quote check.
- **Mutation check** is done ad hoc (#229, #230, #231, #243 all say
  "mutation-checked") and is the thing that exposed every VAC. It is not in
  2c, which only covers bug fixes, not new guards or clears.
- **"Cut the area"** is in memory, not CLAUDE.md; #230 shows it being missed.
- Nothing here is a lint that should be judgment. The copy gate is the only
  candidate and its problem is scope, not placement.

## 4. Corrections caused by too little structure

- No sketch of states before a stateful fix: #229 (arm/hold/release, 6 rounds)
  and #231 (five clear sites then one hook). Each round redesigned one
  transition.
- No requirement that a new guard be shown to fail when deleted: 9 VAC cases.
- No mechanical quote check: 6+ DOC corrections.
- No "numbers cite the command" rule: ~10 NUM corrections.
- No PR-scope rule that binds at planning time: the review-cycle's tier list
  hands over six findings in one area and they become one PR (#229, #231).
- Session-start context: #230 (`throughDepth` in the same class), #233
  (`zeroDepthWarning` docstring), #243 (comment eight lines above). The trap
  was written down next to the code and not read. A prompt that names the
  file to read first is cheaper than another rule.
- Doc-edit tooling: #241 lost two doc edits to a script that threw before
  writing. Memory already says grep after editing.

## 5. What would reduce round trips, ranked

| #   | Change                                                                                                | Expected effect                                                                                       | Cost                     | Where                            |
| --- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------- |
| 1   | **One finding per PR.** Say it in the prompt; refuse tier bundles                                     | Largest. 4 bundled PRs = 24 of 57 rounds                                                              | none                     | **prompting**                    |
| 2   | **Mutation check for every new guard/clear/check**, not only bug fixes; extend ship-it 2c             | Removes the VAC class (~9) and shortens FIX chains that hid behind green tests                        | one paragraph in ship-it | repo                             |
| 3   | **Mechanical troubleshooting-quote check** reusing `check-copy`'s extraction                          | Removes ~6 DOC rounds; retires half of ship-it step 2                                                 | one script, ~1 day       | repo                             |
| 4   | **Sketch states before touching persistence or warning lifecycle**; put the sketch in the PR body     | #229-class chains from 6 rounds to ~2 (guess)                                                         | none                     | **prompting**                    |
| 5   | **Numbers cite the command that produced them** (extend Rule 4 to all measurements)                   | ~2 rounds per measured PR (#240, #241)                                                                | one line in CLAUDE.md    | repo                             |
| 6   | **Name the trap file in the prompt** for geometry/UI-guard work                                       | Removes CTX (5)                                                                                       | none                     | **prompting**                    |
| 7   | **Promote "cut on the second repeat" from memory to CLAUDE.md**                                       | #230 stops at r3; #241 at r2                                                                          | one bullet               | repo                             |
| 8   | **Freeze the copy gate's scope.** Do not reopen the markup hole without parse5 on extracted fragments | Prevents another #241                                                                                 | none                     | repo (tech-debt already says so) |
| 9   | Merge later, look first. VIS = 0 because nothing is looked at between open and merge                  | Unknown; may add a round trip that catches what review can't (#229 T0-1 was invisible to four rounds) | user time                | **workflow**                     |
| 10  | PR body template: measured / rounds / what was cut / docs touched                                     | Small; makes 5 and 1 checkable                                                                        | one file                 | repo                             |

Items 1, 4, 6, 9 are not repo changes. They are how sessions are scoped and
what the opening prompt names.

## 6. Tech-debt items this would remediate

| Tech-debt section                         | Recommendation | How                                                                                                                                                        |
| ----------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Numeric coercion has no lint rule         | 6, Rule 2      | Its stated close is "all external numbers land through one parsing helper". `bindShapeInput` is that helper for fields; #233 shows what bypassing it costs |
| A restore assigns state as it goes        | 4              | Its stated close is build-local-then-commit, which is what a state sketch would have produced in #229 round 1                                              |
| The copy gate's scope and known gaps      | 8              | Already records the cut; this review adds the cost figure (13 rounds)                                                                                      |
| Cancel still waits for the part being cut | none           | HARD; #232 measured it honestly                                                                                                                            |

No other open section is touched by a process change.

## 7. What this review could not see

- #236's six FIX rounds have no per-round record; the body summarises.
- Rounds that returned nothing are not counted, so "rounds" undercounts review
  cost by the clean final rounds (#234, #242, #243 each had one).
- Whether the copy gate prevents future defects is a guess; it has existed for
  one day.

## Action plan

Held until the release ships. Four PRs, one change each. Everything else in §5 is a prompting habit, not a repo change.

- **A — ship-it 2c covers new guards, not only bug fixes.** `.claude/skills/ship-it/SKILL.md`. For a new guard, clear or check, the proof is the mutation run: remove the guard, run the test, read the failure, restore. Cite #229 (three vacuous tests), #230 (three sign-dodging fixtures), #231 (two assertions on strings no source emitted). Docs only.
- **B — promote "cut the area on the second repeat" to CLAUDE.md.** One bullet under "Stop on the kind of finding": a defect in the previous round's fix, in the same area, twice, means revert the area to tech-debt, not a third patch. #241 is the worked example, #230 the counter-example. Then delete the memory that holds the rule today. Docs only.
- **C — Rule 4 covers every measurement, not only perf.** Retitle "No claims without a measurement". Any count in a PR body, commit, tech-debt section or findings report names the command that produced it and reproduces on re-run. #240 and #241 each spent a round on counts that did not. Docs only.
- **D — mechanical troubleshooting-quote check.** New `scripts/check-troubleshooting.mjs` as a seventh gate (`package.json`, `ci.yml`, ship-it step 1). Reuse `check-copy.mjs`'s AST string extraction, do not write a second one. Every quoted warning in `docs/troubleshooting.md` must match an admitted `src/**/*.ts` string, interpolations as wildcards, whitespace collapsed. Seed one drifted quote and see it fail first. Then drop the troubleshooting row from ship-it step 2. Executable, so `/code-review` twice.

Not doing: touching the copy gate, a PR template, a state-sketch rule. "One finding per PR" is already written down; the fix is the prompt.
