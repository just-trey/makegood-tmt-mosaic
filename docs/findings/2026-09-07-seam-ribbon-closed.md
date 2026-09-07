# The seam ribbon does not warn, and cannot at any width the chair has

**Commit** `f32e0ac` (after #296). **Machine** WSL2, RTX 2060, `MOSAIC_GPU=1`
where a browser was involved; every measurement below is node-side against the
shipped `public/stl/chair-body-zones.json`.

**Result: closed as not a defect.** `docs/tech-debt.md`'s "A seam sliver warns
as if artwork were lost" claimed a seam remnant "yields no cutter" and so raises
`Couldn't cut color … into …`. It does not. Every seam overlap on the chair
builds a valid cutter, and the width at which one stops doing so is 55x thinner
than the thinnest the chair has.

Two earlier hunts failed to find a sighting
([seam-sliver-sighting.md](seam-sliver-sighting.md), 2026-08-08, and the
instrumented run of 2026-07-31). They failed because there is nothing to find.

## What was measured

Rather than hunt through the UI a third time, the overlap geometry was taken
straight from the sidecar and handed to the same
`ConformalZoneMapper.buildCutter` the build calls.

**The overlaps are real, and still are after #296.** The cut clips to
`cutRegions` now, not `subRegions`, so both were counted:

| field        | overlapping pairs | worst                                                |
| ------------ | ----------------- | ---------------------------------------------------- |
| `subRegions` | 20                | 29.85mm² on `right` (wing-right / wheel-mount-right) |
| `cutRegions` | 17                | 19.21mm² on `right` (storage-right / handle-right)   |

**Every one of them extrudes.** All 17 pairs, at cut depths of 0.2, 0.6, 1.0 and
2.0mm: **0 of 68 attempts failed**. That includes the thin ones — narrow sides
of 0.274, 0.283, 0.296, 0.308, 0.344 and 0.594mm all produced valid solids of
1100 to 1850 triangles.

**They are not a doubled cut either.** For each pair, cutters were built on both
charts from the same UV strip and their centroids compared. Every pair lands
**0.679 to 0.916mm apart**, clustered near 0.72. That is the printed seam
clearance: the strip maps to surface on one part and surface on the other,
either side of the join, not twice into one place. A mark there spans the seam,
which is what a mark crossing a printed join should do, and what the README
already tells the reader to expect.

## Where the cutter actually fails

Synthetic ribbons on `back`/`chair-seat-back-top`, each held at 0.2mm² so it
clears `CLIP_REMNANT_FLOOR_MM2`, narrowed until something broke:

| width   | length | buildCutter |
| ------- | ------ | ----------- |
| 0.500mm | 0.4mm  | ok          |
| 0.100mm | 2.0mm  | ok          |
| 0.050mm | 4.0mm  | ok          |
| 0.020mm | 10.0mm | ok          |
| 0.010mm | 20.0mm | ok          |
| 0.005mm | 40.0mm | **null**    |
| 0.002mm | 100mm  | **null**    |

It breaks at about **5 microns**. The chair's thinnest overlap that clears the
area floor is **0.274mm**, 55x wider. Reaching the failure would need two clip
boundaries running within five microns of each other for 40mm.

## What this closes, and what it does not

- The tech-debt section goes. Its premise is measurably false and the two hunts
  it records are explained by that.
- **The min-width test it asked for is owed to nothing.** A morphological
  opening at one nozzle would be guarding a 5-micron case, and would cost real
  regions: the chair has genuine features at 0.274mm.
- The overlap test in `tests/chair-zones.test.ts` stays. It guards against a
  claim creeping far from a seam, which is a different thing and still worth
  catching. Its comment overstated the consequence as output corruption, and now
  says what was measured.
- A new case pins the closure: every overlap in the shipped `cutRegions` builds
  a valid cutter.

## The wrong turn worth recording

The first instinct was to write the min-width filter, since the section names
the shape (`narrowFeatureArea`) and #296 had just finished a sibling fix. That
would have shipped a filter nothing needed, tightened it against a case that
does not occur, and cost printable surface at 0.274mm to guard against 0.005mm.

The section's own last line said what to do instead: "Confirm one before
spending the fix on it." It took one probe against `buildCutter` — not a
browser, not a checkerboard sweep — to answer a question two UI hunts had left
open for a month.
