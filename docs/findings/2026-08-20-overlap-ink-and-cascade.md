# The overlap warning against real ink, and how far a cascade step can be pushed

**Measured 2026-08-20.** Branch `overlap-ink-and-cascade-scale` against `f990679`, production
build (`npm run build`), `vite preview`, `MOSAIC_GPU=1`.
Renderer: `ANGLE (Microsoft Corporation, D3D12 (NVIDIA GeForce RTX 2060), OpenGL ES 3.1)`.
Machine: WSL2 kernel 6.18.33.2-microsoft-standard-WSL2, Node 24.18.0.
Script: a throwaway footrest driver (not kept), reproduced in "The live run" below.

Closes the hollow-design half of `tech-debt.md`'s design-overlap section, and part of the cascade
half. The rest of the cascade half survives as its own section, with the two cases it cannot reach.

## The hollow-design half: a bound, not a boolean

The section proposed skipping a pair when one design's ink is a small fraction of its bbox. That
was not built. It has a false negative the shipped behavior does not: line art covers little of its
sheet and would have gone unwarned at any offset, including dead-on.

What shipped is a second gate, run only on a pair the quads already flagged:

- Clip each design's placed cut regions to the rectangle the two quads share.
- Take the smaller of the two clipped areas.
- Drop the pair when that is under `OVERLAP_WARN_FRACTION` of the smaller design's own **ink**.

That number is an upper bound on the true ink-on-ink overlap, because ink sits inside its own quad,
so `ink(A) ∩ ink(B) ⊆ ink(X) ∩ shared` for either X. A bound under the threshold puts the truth
under it too, so the gate can only clear a pair, never raise one.

| Case                                              | Quads alone | With the ink gate | Right answer |
| ------------------------------------------------- | ----------- | ----------------- | ------------ |
| 20mm logo in a 60mm frame's hole                  | warns       | quiet             | quiet        |
| Same logo moved onto the frame's rim              | warns       | warns             | warns        |
| Two 40mm frames, rims nested clear of each other  | warns       | quiet             | quiet        |
| Two solid designs stacked                         | warns       | warns             | warns        |
| Two 60mm frames, 1.5mm border, exactly coincident | warns       | warns             | warns        |

The last row is the one that decided the denominator. Measured against the smaller **bbox** it came
to 9.75%, under the 10% threshold, so two designs covering each other completely went unwarned. The
quad gate keeps its bbox denominator and the ink gate uses ink; the two are deliberately different.

Cost: no boolean. Sutherland-Hodgman against a convex window, which the module already had for the
quads. Valid on a concave subject for area purposes, and the ink is only transformed for a pair
that already passed the quads, once per zone rather than once per part.

## The cascade half: what a stepped lattice can and cannot do

The step was a flat 8mm. Two `w`-wide designs stepped diagonally by `d` cover `((w-d)/w)²` of each
other, which reaches `OVERLAP_WARN_FRACTION` only at `w >= d/(1-sqrt(fraction))` = 11.7mm. So
designs between 8 and 11.7mm across were cascaded into a real overlap nothing warned about: two
10mm designs came out 4% covered, in silence.

Shipped: the step scales to the largest design on the surface, capped at that same 11.7mm.

Three attempts, two rejected by measurement.

| Attempt                                                     | Result                                                                                                                                                                                                                                       |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Step the incoming design's own size                         | **Rejected.** Different designs get different steps, so a later small one lands between an earlier big one's lattice spots. A 5mm design stepping 8mm past a 10mm one at 10mm ends up wholly inside it, where the flat 8mm step had it clear |
| Step the surface's largest, capped at 11.7mm                | **Rejected.** A single step `s` is silent from `s` to `1.4625s`, so this only moves the band: two 15mm designs go from warned at 8mm to 4.8% and silent at 11.7mm. A regression                                                              |
| Step the surface's largest **or** the constant above 11.7mm | Shipped. Below the cap every pair shaped alike lands clear; above it, the constant is what it always was                                                                                                                                     |

**The invariant is narrower than it first looked.** Two claims written into the first draft were
false and are not in the shipped comments:

- "No design size falls between separated and warned about." Only true for designs shaped alike, on
  a surface carrying nothing over 11.7mm. Any single step has a silent band, and one step per
  surface is forced by the lattice, so the band moves but does not close.
- "Any two designs are apart once the larger one's width separates them." A 5x200mm bar and a
  200x5mm bar both measure 5mm across their narrow axis, and no clearance read off that parts them.
  They cross in a 5x5mm patch at 2.5% of either, silently.

Both are recorded in `tech-debt.md` as the surviving section. Neither is a regression: both behave
exactly as the flat 8mm step did.

## The live run

Unit tests stub the placed ink, so the plumbing that produces it was checked in the app.

Footrest (`designFit: 'rect'`, which honours a declared mm size; the wheel scales every design to
the Design radius and makes two differently-sized files the same size, which cost one run):

1. Load an 80mm ring with a 40mm hole. No warning, one design.
2. Load a 20mm square. Cascade seeds it at (8, 8), inside the hole. **No warning.** On `main` this
   warns and nothing the user can do clears it.
3. Set Offset X to 30mm, putting the square across the rim. **Warns**, with the reworded string.

Screenshots confirmed the square really is in the hole in step 2 and across the rim in step 3, and
that the gizmo frame is drawn tight around it in both, which is what checks the scale context that
moved out of `scene/faceFrame.ts` into `assembly/kinds.ts`.

## Null results

- No measurable rebuild cost from the ink gate. It runs once per zone on a pair that already
  passed the quads, over regions the build has already computed.
- The `placedFootprintMM` fill-mode branch is reachable and gets the wrong number: a fill's
  footprint is computed without `forceRect`, so it is measured on the sticker branch. It does not
  always land over the cap either, which an earlier draft of this note claimed. A footrest tile
  declaring 10mm reads 10mm (`isRect` is already true there, so `forceRect` would be a no-op), and
  on the wheel `#p-asm-radius` has no `min`, so a Design radius of 5 gets there too. It is inert
  anyway, because the number only picks a cascade step and a fill covers its whole zone however it
  is stepped. Fill/fill pairs always warn and fill/sticker pairs are always skipped, both before
  the ink gate.
- Existing cascade tests kept asserting exactly 8mm without being touched, because `fakeParsed` on
  the wheel branch places 276mm across. That is the change being conservative, not the tests being
  weak: the sweep added beside them fails on `main` at 8.5mm.
