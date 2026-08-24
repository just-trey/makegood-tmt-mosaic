# Beta scope narrowing — driven verification

**Run:** 2026-08-24, branch `beta-scope-narrowing`, WSL2 + `MOSAIC_GPU=1`
(ANGLE / D3D12 / RTX 2060). `npm run build` + `vite preview` on :4175, driven
headless via `scripts/lib/harness.mjs`.

**What was checked:** that the Part dropdown offers exactly wheel, footrest and
hubcap; that all three still work end to end; that no path supplies a custom
mesh; that a library failure reports an error; and that a session on a retired
kind restores onto something the dropdown can show.

The drive script was a one-off and is not in the repo. Everything it asserted
that a unit test can hold is now held by `tests/assemblyPanel.test.ts`,
`tests/chair-variant.test.ts`, `tests/persist-hidden-kind.test.ts` and
`tests/session-restore.test.ts`.

## Results

| Check                              | Result                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------- |
| Part dropdown options              | `["asm:wheel","asm:footrest","asm:hubcap"]` — 3, all assembly kinds         |
| Switching between all three        | select keeps its value each time, never blank                               |
| Pattern strip                      | renders nothing on every part                                               |
| Mesh drop target / "+ Add" buttons | 0 matches on every part, and in the failure state                           |
| Wheel export                       | 46,350 tris, 3 colors, 3.1 MB, 2 plates (Top+Cap, Bottom), 3 filaments each |
| Footrest export                    | 11,412 tris, 3 colors, 0.8 MB, 1 plate, 4 filaments                         |
| Hubcap export                      | 9,848 tris, 3 colors, 0.7 MB, 1 plate, 4 filaments                          |
| Placement warnings                 | none on any of the three — every part kept its verified pose                |
| Console errors                     | none, except the deliberate `parts.json` abort below                        |

Screenshots of all three parts cut and colored were read, not just the
assertion output: the artwork lands on the design face of each, cleanly, with
no CSG damage.

## The library-down state

`page.route('**/stl/parts.json*', abort)` is the only way to reach it, which is
the point: every shipped role declares a library part, so nothing but a broken
deployment gets here.

Renders `Couldn't load this part. Reload the page to try again.` and nothing
else — no drop target, no per-role add buttons, no "↻ Reload assembly" (which
would retry the fetch that just failed).

**First wording was wrong and the run caught it.** `Couldn't load the parts for
the ${kind.name}` interpolates the dropdown label, so it read "Couldn't load the
parts for the Wheel (Top ×2 + Cap)" — the parenthetical is a parts list and
reads as part of the sentence. The kind name came out; the user can see which
part is selected.

## Round 2: what `/code-review` found that the run had not

The first pass of this branch went green on all five gates and on every driven
check above, and was still wrong in five places. Recorded because four of the
five are things a passing test suite cannot see.

| Defect                                                                         | How it was missed                                                    |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| The error state flashed on **every healthy boot**, ~1s                         | No test covered the window; the driven check only tested the failure |
| `asmLoadFullAssembly` alerted on a **pending** fetch, not a failed one         | Same root cause                                                      |
| `npm run smoke` selected the removed `disc` option                             | Reported green because the invocation piped to `tail`                |
| `check-view-fit.mjs` and `export-chair-examples.mjs` selected `asm:chair-body` | Neither runs in CI, and neither was run                              |

**The root cause of the first two was one confusion.** An empty
`state.assembly.library` is equally "the fetch has not come back" and "there is
no manifest", and the two need opposite things said. `partsLibraryFailed()` now
separates them, and both the panel and the alert read it.

`main.ts` calls `setShapeKind('assembly')` on the line _before_
`loadPartsLibrary()`, so the pending state is not an edge case: it is what every
single boot passes through. Measured live before the fix at 578ms to 1573ms. The
copy made it worse than a cosmetic flash, because it told the user to reload,
which reproduces it.

Re-verified with the manifest held back 3s and the DOM polled every 100ms for
4s: no error at any point, and none once the parts arrive.

**One defect the flag exposed, caught by its own test.** `libraryFailed` was
first cleared on success only, so it stayed true across a retry and leaked
between tests in one file. It is cleared when a fetch _starts_: while one is in
flight there is no known failure to report.

**Two things `smoke` lost, and one it never had.** Its disc steps went (see
`docs/tech-debt.md`). The "Recess bg too" step went with them rather than moving
to the assembly part: `state.recessBg` is read only inside `flat.ts`, so the
Background row it waits for is never produced on any offered part. That control
is therefore live and inert on screen — written up, not fixed, since it blocks
nothing. And the PNG step needed the sample SVG removed first: designs stack
rather than replace, so with the flat-mode detour gone the trace's 3 colors were
being compared against 6 rows.

## Two checks that passed while testing nothing

Both worth recording, because both looked green first.

1. **The screenshot helper takes a filename, not a stem.** `shot(page, dir,
name)` passes `name` straight to Playwright, which needs the extension to
   pick a mime type. Without it the run throws mid-way rather than silently
   skipping, so this one announced itself.

2. **The retired-kind restore initially proved nothing.** Rewriting
   `localStorage` in an already-booted page is too late: the app's own save
   overwrites the fixture before the restore banner can be clicked, and the
   check then passes against an ordinary wheel session. The log said
   `saved kind at the time of restore: wheel` — the tell. Seeding through
   `page.addInitScript` before any app code runs fixed it, and the rerun printed
   `the retired kind survived boot (saw kind-that-no-longer-exists)` before
   asserting the fallback.

   With the path actually exercised: restore lands on `asm:wheel`, the value has
   a matching option, and the part loads. Before this branch it would have set
   `shapeKind = 'disc'`, which now has no option at all.
