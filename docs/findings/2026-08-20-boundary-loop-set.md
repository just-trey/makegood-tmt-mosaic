# A design face's holes, and what they were costing

**Measured 2026-08-20.** Branch `feat/boundary-loop-set` against `65d3adc`, production build
(`npm run build`), `vite preview`, `MOSAIC_GPU=1`.
Renderer: `ANGLE (Microsoft Corporation, D3D12 (NVIDIA GeForce RTX 2060), OpenGL ES 3.1)`.
Machine: WSL2 kernel 6.18.33.2-microsoft-standard-WSL2, Node 24.18.0.
Scripts: [scripts/check-inner-rim.mjs](../../scripts/check-inner-rim.mjs), plus a throwaway
wheel/footrest export fingerprint (not kept).

Closes the `boundaryLoop` section of `tech-debt.md`. The face keeps every loop of its patch now,
and outer-vs-hole is resolved by containment depth.

## What the shipped parts' design faces actually look like

Every packed part in `public/stl/`, default patch, loops of that patch. Measured before writing
anything.

| Part                     | Loops | Structure                          |
| ------------------------ | ----: | ---------------------------------- |
| wheel-half               |     1 | outline only                       |
| wheel-hub-cap            |     1 | outline only                       |
| footrest                 |     3 | outline + 2 holes (277.6 mm² each) |
| chair caster mount (std) |     9 | outline + 6 holes + 2 islands      |
| chair caster mount (kit) |    12 | outline + 9 holes + 2 islands      |
| hubcap-clips (raw asset) |     4 | four disjoint pads, all depth 0    |

- A holed design face is **not** hypothetical: the footrest, the part a volunteer is most likely
  to decorate, has two.
- The caster mounts nest two deep. They take no artwork (no baked zone), so they are evidence the
  structure occurs, not a defect.
- `hubcap-clips` is never a design face: the hubcap role generates its own disc and unions the
  clips on, so the part's mesh is never the file that was fetched.

## The defect, on the real app

A 220 mm hubcap cut to a doughnut silhouette: a red disc with an off-centre hole, and a blue ring
hugging that hole and touching nothing else. Read off the exported 3MF, not off the viewport.

| Inlay                       |       Before |        After |
| --------------------------- | -----------: | -----------: |
| Red (touches the outline)   |     3.000 mm |     3.000 mm |
| **Blue (touches the hole)** | **1.000 mm** | **3.000 mm** |

The disc is 3 mm thick. Before, the blue stopped 1 mm down and left 2 mm of base colour standing
on the hole's wall, which is the exact band the edge-cut-through rule exists to remove. The app's
own notice agreed: it named only `#c1272d` before, and names both colours after.

Screenshots confirm it. The base-colour ring inside the hole is visible in the before shot and gone
in the after.

## The second hazard was reachable, and is now pinned

The old sort key was **vertex count**. On a face whose cut-out is more intricate than its outline
(a 64-point hole inside an 8-point ring, `tests/patch-boundary.test.ts`) that picks the hole, and
every downstream reader then treats the inside of the gap as the face: the clip, the design centre,
the fill extent, and the edge rule. Sorting by area cannot do this, because a hole is always
smaller than what encloses it.

No shipped part hits it today. Two chair parts (`chair-handle-left`, `chair-storage-left`) do have
a vertex-count winner that differs from the area winner, but their patches are X-facing, so every
X/Z area is 0 and neither ordering means anything there. Those parts take artwork through baked
zones, not through this path.

## What moved on the shipped parts

Same artwork, same printer, exported before and after, comparing `3D/3dmodel.model`.

| Part     | Export                                           |
| -------- | ------------------------------------------------ |
| Wheel    | **byte-identical** (sha `8632de3e6a98b931` both) |
| Footrest | **changed** (sha `2b53522…` → `61accc…`)         |

The footrest change was not predicted, and it is an improvement.

- Its two mounting slots are holes in the design face. Clipped only to the outline, a colour's
  1 mm recess was cut straight across them, shaving the chamfered lip around each slot and filling
  it with that colour.
- Clipped to the holed face, the recess stops at each slot. The lips survive and keep the base
  colour, which is what the part's **outer** rim has always done.
- Numbers: body 5336 v / 10700 t → 5620 v / 11268 t (it keeps geometry the cut used to remove);
  the blue inlay 382 v → 194 v; app triangle count 12540 → 12732.

So "the wheel and footrest are unchanged" was the wrong expectation. The wheel is; the footrest
changes, and the change makes its holes behave like its edge.

## What review changed, over three rounds

**Two fixes landed.**

_A sideways design face stopped clipping at all._ A patch facing along X has no X/Z area, so the
nesting returns nothing. Returning that as the boundary means "no clip", and the cut then runs
unbounded at an arbitrary plane. Verified the old path: `turf.polygon` built the degenerate ring
fine and `turf.intersect` returned null, so the colour was simply dropped. A zero-area polygon is
kept as the fallback, so that stays what happens.

_`scripts/gen-templates.mjs` picked a part's outline by the same rule, and was missed._ It sorts a
patch's loops by point count, with a comment stating that is what the app keeps. Changing the app
to area and leaving the script would trace a new part's true-size template from a hole. Both sort
by area now, and each comment points at the other. Found only in round 3: the first sweep grepped
for `boundaryLoop`, and this reader calls `extractPatchBoundary` directly.

**One measured ceiling, recorded rather than fixed.** Many holes defeat `SegmentGrid`'s prefilter,
because every hole rim is eroded too and "near the boundary" stops being rare.

| Holes in the face | `splitAtBoundary`, 600 artwork polygons |
| ----------------: | --------------------------------------- |
|                 0 | 13 ms                                   |
|                50 | 40 ms                                   |
|               200 | 351 ms                                  |
|               293 | 599 ms                                  |

Per colour per part, so at 293 holes an 8-colour image would add ~5 s to every rebuild. Not
reachable: the whole raster corpus, driven through the real app on the hubcap with the silhouette
on, traces to faces of 353, 257, 16 and 15 points **in total**, and the silhouette rebuild is the
same before and after (1.3 / 0.9 / 0.5 / 0.8 s, best of three each). The numbers are in a comment
on `SegmentGrid`, with the despeckle floor and `MAX_COMPONENTS` named as what holds it off. No code
changed: no measurement would justify a threshold here, and inventing one to close a finding is
worse than the finding.

**One finding was split out, after two attempts to fix it made things worse.** A pinch vertex, two
boundary loops of one patch meeting at a point, makes `extractPatchBoundary` return a truncated
chain as if it were a ring, which the new nesting can read as a hole where the face is solid.

- Round 1's fix discarded chains that did not close, marking vertices consumed as the walk went. A
  chain running off the end then ate a genuine loop it had entered and both were lost: six patches
  returned no loops at all, and `chair-seat-center` patch 0 dropped its 2101.5 mm² outline for a
  1097.1 mm² sub-loop. Round 2 caught it.
- Round 2's fix consumed vertices only on close. A chain entering a cycle it did not start on then
  ran to the 100000-iteration guard. `chair-seat-center` patch 0 is the **default** patch, hit on
  every chair load: under 2 ms → **317 ms**, emitting 1.6 M points of garbage. `wheel-half` patch 2
  → 2162 ms. Round 3 caught that, plus a script caller of the changed signature.

Three rounds, and every finding but one landed on that one bolted-on subsystem while the loop-set
change itself came back clean each time. So it is out of this branch and in `tech-debt.md`, with
these numbers and the shape of a real fix (key the walk by directed edge, pair by angle at the
pinch, per-walk visited set). It is not reachable from the shipped workflow: no design face of any
of the four kinds contains an open chain.

| Patch                                    | Closed | Open |
| ---------------------------------------- | -----: | ---: |
| wheel-half patch 0 (**the design face**) |      1 |    0 |
| wheel-hub-cap patch 0 (**design face**)  |      1 |    0 |
| footrest patch 1 (**design face**)       |      3 |    0 |
| wheel-half patch 2 (-Y back, selectable) |      7 |   99 |

## Null results

- Clipping to the holes does **not** change the geometry over a through-hole on its own. The
  boolean against the real mesh already bounded the cut there. The footrest moved only because its
  slots have chamfered lips, which is material inside the recess depth.
- `erodeBoundary` and `splitAtBoundary` needed no change. They already took multi-ring features:
  the erosion flattens every ring into one `NonZero` cross-section, so a `-tol` offset shrinks the
  outline inward and grows each hole outward in one call.
- Nothing needed a new nesting implementation. `shapeToFeature` already resolves rings by
  containment depth, and `erodeBoundary` already round-trips through it for the same reason.
