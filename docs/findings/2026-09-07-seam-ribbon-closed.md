# The seam ribbon does not warn, and no width makes it

**Commit** `f32e0ac` (after #296). **Machine** WSL2, RTX 2060. Every figure and
every table below prints from one command against the shipped
`public/stl/chair-body-zones.json`:

```
npx vite-node scripts/measure-seam-overlap.mjs
```

committed with this report.

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
is 41 pieces, and it is the correction that matters: by pair the thinnest is
0.0830mm by bounding box, by piece 0.0055mm. Both are printed by the script.

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
**0.220 to 0.589mm apart** on the two parts. They are distinct surfaces either
side of a printed join, not one surface cut twice. A mark there spans the seam,
which is what a mark crossing a join should do.

The sample has to be a point that is actually inside the piece.
`turf.centroid` is the vertex mean and falls outside a curved sliver — on 4 of
the 41 it sampled surface neither part owns, and published a 1.116mm maximum
that was not a separation at all. With `turf.pointOnFeature` the range is
0.220-0.589mm, which sits either side of the 0.530mm widest real contact gap in
`scripts/zone-configs/chair-body.json` rather than being claimed as it.

## There is no failure width

A first sweep held ribbons at 0.2mm² and narrowed them, and read `null` at
0.005mm wide. **That reading was wrong**, and the error is worth recording:
holding the area fixed made the ribbon longer as it narrowed, and at 0.005mm it
was 40mm long. Sweeping width against length separately shows the nulls follow
length, not width — every width from 0.2mm to 0.001mm behaves identically.

The nulls are not a thinness failure at all. They are the strip leaving the
chart, which is `buildCutter`'s `'outside'` return and correct. Clipped to the
chart's own cut region first, as the build always does, nothing fails at all:

| width   | 1mm | 5mm | 20mm | 40mm | 80mm | 120mm |
| ------- | --- | --- | ---- | ---- | ---- | ----- |
| 0.200mm | ok  | ok  | ok   | ok   | ok   | ok    |
| 0.050mm | ok  | ok  | ok   | ok   | ok   | ok    |
| 0.010mm | ok  | ok  | ok   | ok   | ok   | ok    |
| 0.002mm | ok  | ok  | ok   | ok   | ok   | ok    |
| 0.001mm | ok  | ok  | ok   | ok   | ok   | ok    |

A ribbon one micron wide and 120mm long extrudes without complaint.

## What this closes

- The tech-debt section goes. So does the one above it recording the `cutRegions`
  bake, which had no open thread left once this closed.
- **The min-width test it asked for is owed to nothing _by this item_.** What is
  closed is that item's claim: a seam remnant yields no cutter and so warns. A
  width guard may still be worth having for a different reason — the hairline
  #296 removed was 0.020 x 8.08mm, extruded perfectly well, and cut a visible
  0.4mm mark, which is a width problem that `CLIP_REMNANT_FLOOR_MM2` happened to
  catch on area by a factor of six. Nothing here says that case cannot recur
  wider. What is settled is that the seam overlaps are not it, and that a width
  guard would have to be sized against real features: the chair has genuine
  overlap pieces at 0.15mm.
- The overlap test in `tests/chair-zones.test.ts` stays. What it really guards is
  a claim creeping far from a seam, which is a different thing and still worth
  catching. Its comment said the overlap corrupts output; it now says what was
  measured.
- A new case pins the closure, asserting the piece count as well as the result so
  a re-bake cannot leave it passing while measuring nothing.

## The wrong turns

Three, all worth not repeating.

**Reaching for the filter.** The section names the shape (`narrowFeatureArea`)
and #296 had just finished a sibling fix, so writing it was the obvious next
move. It would have shipped a filter nothing needed. The section's own last line
said what to do instead: "Confirm one before spending the fix on it."

**Measuring at the wrong granularity, then quoting a margin from it.** The
"55x" in the first draft of this report came from per-pair widths and was wrong
twice over — the per-piece thinnest is 50x smaller than the per-pair figure, and
the failure it was a margin against turned out not to be a width failure at all.
A safety margin is a claim like any other, and it needs the same measurement.

**Sampling a shape by its centroid.** The vertex mean of a curved sliver is
outside it. Four of the 41 separations were measured on surface neither part
owns, and the largest of them became this report's headline maximum. Any figure
sampled from a shape needs the sample checked against the shape — and against
the surface too: `frameAt` snaps a query to the nearest triangle rather than
refusing it, so 7 of 82 samples had been quietly moved by up to 0.0863mm. Six
pieces are excluded for that now, and the range over the remaining 35 is
unchanged.
