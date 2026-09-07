# The seam ribbon does not warn, and no width makes it

**Commit** `f32e0ac` (after #296). **Machine** WSL2, RTX 2060. Every figure below
is node-side against the shipped `public/stl/chair-body-zones.json`, and
re-derivable with `npx vite-node scripts/measure-seam-overlap.mjs`, committed
with this report.

**Result: closed as not a defect.** `docs/tech-debt.md`'s "A seam sliver warns
as if artwork were lost" claimed a seam remnant "yields no cutter" and so raises
`Couldn't cut color … into …`. It does not, and there is no width at which it
would. Two earlier hunts failed to find a sighting
([seam-sliver-sighting.md](seam-sliver-sighting.md), 2026-08-08, and the
instrumented run of 2026-07-31) because there is nothing to find.

## What was measured

The overlap geometry went straight from the sidecar to the same
`ConformalZoneMapper.buildCutter` the build calls, rather than a third attempt
at driving the UI.

**The overlaps are real, and survived #296.** The cut clips to `cutRegions` now,
not `subRegions`:

| field        | overlapping pairs | worst                                                |
| ------------ | ----------------- | ---------------------------------------------------- |
| `subRegions` | 20                | 29.85mm² on `right` (wing-right / wheel-mount-right) |
| `cutRegions` | 17                | 19.21mm² on `right` (storage-right / handle-right)   |

**Measured per PIECE, not per pair.** A pair's intersect can be several polygons,
and the narrowest of them is what a design clipped down to one would face. That
is 41 pieces, and it is the correction that matters: by pair the thinnest looks
like 0.274mm, by piece it is 0.0055mm.

|                                             |                                                |
| ------------------------------------------- | ---------------------------------------------- |
| overlap pieces                              | 41                                             |
| clearing `CLIP_REMNANT_FLOOR_MM2` (0.16mm²) | 25                                             |
| thinnest that clears it                     | 0.0631mm by 2·area/perimeter, 0.1537mm by bbox |
| thinnest overall                            | 0.0022mm by 2·area/perimeter, 0.0055mm by bbox |
| **failing to build, on either part**        | **0 of 41**                                    |

Both parts were tried for each piece, since `Couldn't cut color … into <part>`
names one part and which of the two claims the strip is the whole question.

**They are not a doubled cut either**, which is what the overlap test's own
comment feared. Putting the same UV point through each part's warp lands it
**0.217 to 1.116mm apart** on the two parts. They are distinct surfaces either
side of a printed join, not one surface cut twice. A mark there spans the seam,
which is what a mark crossing a join should do.

That range straddles the 0.530mm widest real contact gap in
`scripts/zone-configs/chair-body.json`, so it is reported as what it is — how
far apart the two surfaces are — and not claimed to be the seam clearance.

## There is no failure width

A first sweep held ribbons at 0.2mm² and narrowed them, and read `null` at
0.005mm wide. **That reading was wrong**, and the error is worth recording:
holding the area fixed made the ribbon longer as it narrowed, and at 0.005mm it
was 40mm long. Sweeping width against length separately shows the nulls follow
length, not width — every width from 0.2mm to 0.001mm behaves identically.

The nulls are not a thinness failure at all. They are the strip leaving the
chart, which is `buildCutter`'s `'outside'` return and correct. Clipped to the
chart's own cut region first, as the build always does:

| width  | length | area      | buildCutter |
| ------ | ------ | --------- | ----------- |
| 0.01mm | 10mm   | 0.0695mm² | ok          |
| 0.01mm | 40mm   | 0.2430mm² | ok          |
| 0.01mm | 120mm  | 1.0430mm² | ok          |

A ribbon 0.01mm wide and 120mm long extrudes without complaint.

## What this closes

- The tech-debt section goes. So does the one above it recording the `cutRegions`
  bake, which had no open thread left once this closed.
- **The min-width test it asked for is owed to nothing.** A morphological opening
  at one nozzle would guard a case that does not exist and would cost real
  features: the chair has genuine overlap pieces at 0.15mm.
- The overlap test in `tests/chair-zones.test.ts` stays. What it really guards is
  a claim creeping far from a seam, which is a different thing and still worth
  catching. Its comment said the overlap corrupts output; it now says what was
  measured.
- A new case pins the closure, asserting the piece count as well as the result so
  a re-bake cannot leave it passing while measuring nothing.

## The wrong turns

Two, both worth not repeating.

**Reaching for the filter.** The section names the shape (`narrowFeatureArea`)
and #296 had just finished a sibling fix, so writing it was the obvious next
move. It would have shipped a filter nothing needed. The section's own last line
said what to do instead: "Confirm one before spending the fix on it."

**Measuring at the wrong granularity, then quoting a margin from it.** The
"55x" in the first draft of this report came from per-pair widths and was wrong
twice over — the per-piece thinnest is 50x smaller than the per-pair figure, and
the failure it was a margin against turned out not to be a width failure at all.
A safety margin is a claim like any other, and it needs the same measurement.
