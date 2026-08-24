# 2026-08-24: Despeckle floor recalibration, blur cutoff, fringe width

Raster trace quality on flat art was visibly degraded (user report: mario.png on the wheel
lost its eye, teeth, emblem; edges blocky; brown threads on every outline). Three defects
found; two fixes shipped, one cut in review. All measured on this commit's corpus cache on
the WSL2 dev box.

## Result

- mario.png at the app defaults (6 colors, Detail 50, wheel): eye with iris/pupil/highlight,
  teeth, red M, mustache and glove marks all trace again, no staircases, no fringe bands.
  Verified in the live app on wheel and hubcap, no console errors. One hair-thin thread on
  the mustache's top edge remains (defect 3, cut).
- Photographs and small placements byte-identical to #216/#217 results
  (stock-gravel 67 components at D50; makegood-logo on the 32mm hubcap keeps floor 185).
- 1133 tests pass. `despeckle` and `floor` bench invariants hold: nothing survives under
  its floor, nothing exceeds MAX_COMPONENTS.

## Defect 1: the fractional floor was calibrated against a broken pass

- #216 made the despeckle floor actually hold; the `despeckleFrac` endpoints were tuned
  while ~95% of sub-floor components survived by accident. Same constants + working pass =
  over-pruning.
- mario measures edgeDensity 0.253, partway to photographic, so its fraction lerps up:
  **759px² floor** at 1024 working width. At the wheel (0.27mm/px) that is **55mm² of
  printed area** despeckled away. The eye, teeth and emblem details are under it.
- Floor sweep at the wheel, 6 colors: every floor from 16 to 384px² traces visually
  identically (all features present); the cliff is between 384 and 759. Rings inflate the
  `shapeToFeature` quadratic below ~16px (cartoon: 79 rings at floor 16, 36 at 32).
- **Fix**: `despeckleFloorPx` (stats.ts). Placement known + flat art: floor =
  `max(printableFloorPx, min(fracFloor, (1.6mm)² at the placement × Detail strength))`.
  `DESPECKLE_FEATURE_MM = 1.6` (4 nozzle widths) sits inside the measured good band
  (1.1-5.3mm sides) with margin both ways. Photographs and unknown placements keep the
  fraction: a photo's floor is simplification taste (0.0022 of a photo is ~9mm of print on
  the footrest, by design), not a feature-size claim.
- The gate is `mmPerPixel > 0`, not `printableFloorPx > 0`: past ~0.4mm/px the printable
  floor rounds to 0 while the placement is known, and a small logo placed large
  (red-sox-logo on the wheel, 0.92mm/px) is exactly where the fraction despeckles multi-mm
  features. With the mm floor it keeps every stitch; `shapeToFeature` on its worst shape
  (396 rings) measured 10.6ms, inside the 30ms yield budget.

## Defect 2: photo denoise blur interpolated into the flat regime

- mario got blurRadius 2: 1 lerped from the photo endpoint + 1 detail-pass compensation.
  The lerped pixel widened every anti-aliased line boundary into a band that quantized to
  a third color (brown fringe on black outlines) and made label boundaries staircase
  through the gradient.
- Blur sweep at 6 colors, wheel floor: blur 2 has both defects; blur 1 has neither and
  keeps the eye clean (the striping DETAIL_PASS_BLUR exists for does not return); blur 0
  brings mild striping back inside the eye.
- **Fix**: the lerped share now stops at `isPhotographic` instead of interpolating.
  Only mario and red-sox-logo (both 0.253) change on the corpus; photographs unchanged.

## Defect 3: boundary ribbons survive any area floor — CUT, not shipped

- After the blur fix, thin threads remained (mustache top edge, a button squiggle): a
  fringe component as long as the boundary it hugs clears any area floor. Both print
  under one nozzle wide, so slicers drop them; they are a preview blemish.
- Three formulations of a width rule (absorb components under a mean-width threshold,
  2*area/perimeter) went through review, and each round found real defects:
  1. "Under 2px in an enlarged image": premise false at 1:1 (1-2px strokes are drawn
     content) and past 2:1 downscale (hairlines land under 2 working px).
  2. Same rule gated by a decoded downscale ratio: three premise holes, a plumbed field
     old sessions cannot restore, and a perimeter merge bug (double-subtracting the
     shared run, caught by the look bench as mario collapsing to 10 components).
  3. Width under one nozzle at the placement, capped at 2px: physically sound framing,
     but round 4 found it shipping unmeasured on placed photographs (banding cascade in
     a synthetic probe), able to absorb a whole sub-fringe line drawing into an error
     whose advice (raise Detail) cannot help, resting on a perimeter invariant false for
     big-big merges, and paying a full-image scan even when provably a no-op.
- Three consecutive rounds of real defects in one area is this repo's cut signal. The
  rule is out of the PR; the thread stays visible and is tracked in tech-debt.md
  ("Boundary fringe threads survive the trace") with all of the above as the bar any
  future attempt has to clear.

## Null results and open threads

- Absorption target choice (longest shared boundary, color-blind) was suspected for the
  black-blob eye; not guilty. The floor and blur fixes restore the eye without touching it.
- The left overall-button's dark accent (~2.5px wide in the source) still traces as a
  short jagged mark. It is drawn content just above the fringe width, so the width rule
  must not take it; fixing its look would need curve-fit work on thin diagonals. Left as
  is: sub-nozzle-adjacent at print size.
- Flat plates still have no placement-aware floor (open item in tech-debt.md, unchanged):
  they keep the recalibrated-in-name-only fractional floor, so a mario-like image on a
  flat plate still over-prunes. Closing that item now buys more than it did.
- The cartoon corpus source's three-tone eyes (white, light blue, dark blue) quantize to
  one gray at 6 colors, byte-identically before and after this work: k-means spends two of
  the six slots on yellow's shading tones because it weighs pixel count, not saliency. At
  8 colors the eyes separate fully. Filed in roadmap.md as palette allocation, not touched
  here.
- `look` bench mode added (bench-raster.ts): writes what the shipping path traces as SVGs,
  per source per placement. Counts cannot see a black-blob eye; renders can.
