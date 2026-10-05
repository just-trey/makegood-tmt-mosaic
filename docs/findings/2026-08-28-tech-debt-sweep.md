# 2026-08-28 tech-debt sweep: 8 items, net −2 by section count

**Result:** 8 items from `docs/tech-debt.md` dispatched, 8 PRs merged (#250–#257). Section count **53 → 55**. Five items closed outright, three split or shrunk, seven new narrower sections logged. Zero new TODOs, zero new suppressions.

Baseline and final both measured on `main` (d61529b before, f19616e after) with:

- `grep -c '^## ' docs/tech-debt.md` → 53 / 55 (an earlier draft of this report said 55 / 55; that 55 was read off a working tree before the baseline commit was checked out, and `git show d61529b:docs/tech-debt.md | grep -c '^## '` gives 53)
- `wc -l docs/tech-debt.md` → 1718 / 1849
- `grep -rnE 'TODO|FIXME|XXX|HACK' src scripts tests | wc -l` → 0 / 0
- `grep -rnE 'eslint-disable|@ts-expect-error|@ts-ignore' src scripts tests | wc -l` → 13 / 13 (all the same pre-existing `@ts-expect-error` for plain-JS tooling imports)
- `npm test` → 1214 / 1239 tests, all green both times

## Tally (the campaign prompt's format)

```
Items closed:              5   (A, D, E, F, G)
Items split / shrunk:      3   (B, C, H)
Items skipped:             0   of the 8 selected; 47 sections not attempted, reasons below
New TODOs/FIXMEs added:    0
New lint suppressions:     0
New items logged in doc:   7   (5 new, 1 thread carried out of a split section, 1 narrower replacement)
Net debt change:          −2   by section count (5 closed − 7 logged)
```

By count the sweep is net negative. By content it is not: every closed item was a shipping defect (a wrong cut, a WASM leak, a silent NaN in path data, a missing prime-tower position), and every logged section is narrower than the one it came out of. The count is the wrong instrument for that, and this report says so rather than inflating the closed number.

## Per item

| Item | Section closed                                 | PR   | Model  | Outcome                                                                                                                     | Review rounds | Sections logged                                                                           |
| ---- | ---------------------------------------------- | ---- | ------ | --------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------- |
| A    | `hubcap.ts` typographic apostrophes            | #250 | Sonnet | Closed                                                                                                                      | 1             | 0                                                                                         |
| C    | Restore assigns state as it goes               | #251 | Sonnet | Split: 24 scalar fields commit atomically; assembly-kind switch still doesn't                                               | 3 + 1         | 2 new (assembly-kind atomicity, hubcap clamp looser than live control) + 1 carried thread |
| F    | Duplicate keeps old design face                | #252 | Opus   | Closed; live-verified by 3MF readback, both halves now 18546 bodies                                                         | 3             | 1 (regenerated source mesh would strand its copies; unreachable today)                    |
| B    | Eight warnings with no troubleshooting section | #253 | Sonnet | Split: 8 sections written; re-audit found 13 more, section shrunk to list them                                              | 0 (prose)     | 0 net (rewritten in place)                                                                |
| D    | Raster notices dedupe by filename              | #254 | Sonnet | Closed                                                                                                                      | 5             | 1 (the reverted upsert attempt, see below)                                                |
| E    | Two unguarded `parseFloat` sites               | #255 | Sonnet | Closed (section stays: its subject is the missing lint rule)                                                                | 4             | 1 (tokenizer glues arc flags; pre-existing)                                               |
| H    | Cancel leaks WASM once cutting starts          | #256 | Opus   | Split: per-part `try/finally`, three cancel sites inside the cut; section shrunk to "the one Manifold call already running" | 3             | 0                                                                                         |
| G    | Round part scored by bbox for the tower        | #257 | Opus   | Closed; H2D 220mm now writes `wipe_tower_x/y` 270/240                                                                       | 6             | 1 (concave part scored as its convex hull; replaces the bbox one)                         |

Numbers in the table come from each PR body, which names the command behind each.

## Wrong turns worth not repeating

- **`git stash` is shared across worktrees.** Two parallel agents (F and H) each popped the other's stash. F recovered by hand and re-stashed the foreign diff labelled `NOT-MINE`; E later found its own early WIP circulating on the stack. No work was lost, but the brief for any parallel worktree run now has to say: prove pre-fix failures with `cp` + `git checkout --`, never stash.
- **The coordinator's own suggestion hit the cut-the-area guard.** On D, a reviewer flagged that `notice()`-then-`dismissNotice()` order was load-bearing; the coordinator told the agent to make `push()` upsert in place. Three rounds each found a real defect in that mechanism (unkeyed callers' `build` flag flipped; the × button matches by object identity; then a third fix in the same spot). Reverted to the shipped skip-if-present with key matching only; the attempt and its three failure modes are one tech-debt section.
- **Agents log twin bugs instead of fixing them.** Under a literal scope lock, D wrote a section saying "`warn()` needs the same key" and E wrote one saying "the gradient warning needs the same counter", each a one-line change in the same file. Both were folded in on instruction. A section that only says "do the same thing one line up" is net debt.
- **Agents act on taste.** G ran six rounds; rounds 4–5 were overstated claims in comments and docs, not wrong output. E's fourth round was mostly coordinator-consolidated doc fixes. The stop rule was applied by the coordinator reading the helper output, not by the agent.
- **Review helpers diff against stale local `main`.** D's first review rounds reported A's and C's already-merged changes as D's. Each batch-2 agent had to be told to rebase and confirm `gh pr diff` showed only its files.
- **Two review helpers looped resending the same findings** when their parent kept re-polling an address that could not be reached. Harmless, noisy.

## Null results

- No agent hit anything needing `DECISIONS-NEEDED.md`.
- The 13 `@ts-expect-error` suppressions are one shape (plain-JS tooling modules imported by tests) and were not in scope; a `.d.ts` for `scripts/lib/` would remove all 13 in one change, unmeasured.
- Live checks all confirmed: F (3MF readback), G (`wipe_tower_x/y` out of nine exports, `RESULT: clean`), H (`scripts/check-cancel-latency.mjs 6000 6`: cancel 0.04–0.06 s inside the cut, heap flat at 16.8 MB; 16.8 → 34.9 MB with the `finally` emptied).

## Not attempted, and why

- **Decisions, not fixes**: Fill tile with no mm size; placement table vs role (the doc says "re-scope or close as won't-do"); feedback popover vs warnings column; caster mounts / rear brace.
- **Needs a slicer by hand**: chair third bed; hubcap plate on H2D and above 220 mm.
- **Blocked on `withholdFill` / hidden chair**: chair Fill export script; Zebra + Fill on Handle (left); extrude repair on conformal; the two chair defects.
- **Needs a measurement pass first**: per-color union chunk size; edge-density size dependence; Colors default; blur vs downscale; despeckle floor retrace; `MAX_COMPONENTS`; fringe threads; seam sliver; Fill under sticker.
- **Too large for a small sweep**: flat-plate modes ship compiled (biggest single net win available); placement frame angle; depth field applied-depth plumbing; user-SVG tile-vertex ceiling; patch-boundary pinch vertex.
- **Reference sections that are the record**: turf pin; copy and troubleshooting gate gaps; export seal; wrap dead ends; zone-pick seam; instance cascade; CSG fault fixtures; sidecar size; `CHART_SNAP_MM`; STL shading; upload path removal; convention 19 neighbours; Colors-detected prose; auto-merge slider; session re-trace.

## Recommendation

Keep sweeps at this size or smaller. Eight items took eight PRs and about ten hours of wall-clock (the longest agent, G, reported 35,334 s; H 34,586 s; they ran in parallel), and the two Opus geometry items each ran three or more review rounds. The next sweep's best candidates are the flat-plate-mode deletion (one large PR, pure removal) and the `scripts/lib/` `.d.ts` (13 suppressions in one change).
