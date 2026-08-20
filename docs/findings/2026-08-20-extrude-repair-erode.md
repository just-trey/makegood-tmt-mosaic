# Why a gravel photograph lost a color on the wheel

**Run**: 2026-08-20, on `main` at `a694330` plus the fix, WSL2 / Chromium 149.0.7827.55 / Node
24.18.0, GPU active (RTX 2060 via D3D12).

**Reproduce**: load `stubs/raster stock/gravel.jpg` (fetched by
`scripts/fetch-raster-stock.mjs`) onto the wheel in assembly mode.

## What was seen, and how

A driven run of the real app, screenshotted rather than measured. The warning was on screen and in
no bench output:

```
⚠ Couldn't cut color #7d7163 into "Bottom".
```

**Ten `/code-review` rounds and two findings reports never surfaced this.** They were pointed at the
raster pipeline, which stops after trace; the failure is two stages later, in geometry. Looking at
one screenshot found it in one run. That is the durable lesson from this investigation, more than
the fix.

## Cause

Not the boolean engine, and not the region count. `Couldn't cut color … into …` is the 2D-to-3D
extrude step: a region clipped to the part boundary can come out touching itself at a point, valid
to turf and un-watertight to Manifold. The app repairs that by eroding the region slightly, and
retried **once** at a fixed `0.01mm`.

Instrumenting the real build with gravel loaded:

| Part       | Color       | Rings  | First extrude    | Repaired? |
| ---------- | ----------- | ------ | ---------------- | --------- |
| Top        | #b29e84     | 40     | Not manifold     | yes       |
| Top        | #60482d     | 115    | Not manifold     | yes       |
| Top        | #7d7163     | 52     | Not manifold     | yes       |
| Bottom     | #b29e84     | 69     | Not manifold     | yes       |
| Bottom     | #60482d     | 129    | Not manifold     | yes       |
| **Bottom** | **#7d7163** | **53** | **Not manifold** | **no**    |
| Cap        | four colors | 43-269 | Not manifold     | yes       |

**The first extrude fails eleven times.** The repair rescues ten. The repair is not a rare safety
net on this artwork, it is load-bearing, and it was one case from failing.

`Top #7d7163` at 52 rings repairs and `Bottom #7d7163` at 53 rings does not. Near-identical regions
on opposite halves of the same wheel, on opposite sides of a numerical edge. That is what a single
fixed epsilon buys.

## The ladder, measured

Re-running the failing region across erode distances:

| Erode                | Result    |
| -------------------- | --------- |
| 0.005mm              | fails     |
| **0.01mm (shipped)** | **fails** |
| 0.02mm               | fails     |
| 0.05mm               | works     |
| 0.1mm                | works     |
| 0.25mm               | works     |

So `0.01mm` is simply too small for this region, and `0.02mm` is too. `REPAIR_ERODE_MM` is
`[0.01, 0.05]`: narrowest first so a region that repairs cheaply never pays more, stopping at an
eighth of a 0.4mm nozzle. 0.25mm also clears it and is over half a nozzle width, which is a visible
change to the recess rather than a repair of it.

## What the wider rung costs

Six net regions from the gravel trace, scaled to the wheel's 276mm face:

| Erode  | Area lost | Regions lost entirely |
| ------ | --------- | --------------------- |
| 0.01mm | 0.37%     | 0                     |
| 0.02mm | 0.74%     | 0                     |
| 0.05mm | 1.83%     | 0                     |
| 0.1mm  | 3.63%     | 0                     |

**A review round said that table understates the risk, and it was right to ask.** An erode is a
deletion below twice its distance, not a shrink: `repairSelfIntersections` returns null only when
_every_ contour vanishes, so a hair on a larger blob of the same colour would disappear while its
parent repaired. That is the shape [seam-sliver-sighting.md](seam-sliver-sighting.md) measures at
about 0.15mm.

**The argument that settles it is geometric, not statistical.** An inward offset of `e` removes
exactly those features thinner than `2e`. At the shipped 0.05mm that is 0.10mm, a quarter of a
0.4mm nozzle. Nothing a quarter of a nozzle wide can be printed, so whatever the wider rung removes
was never going to reach the part. That holds for any artwork, which no measurement over one
photograph can.

**Two attempts to measure the deletion instead, and why neither is quoted above.** Both are
recorded because the wrong turns are the useful part:

- _Counting contours per colour_ gave 10→10, 47→47, 40→40, 310→310, one lost on #b29e84, and
  321→**322** on #7d7163. But a count cannot separate a deletion from a split: the +1 could be one
  contour splitting and another disappearing in the same step. A review round caught that the metric
  was the very one an earlier docstring had rejected for exactly this reason.
- _Matching contours between rungs_ by centroid containment then reported a 45.39mm² contour
  disappearing on #2c231c, which an 0.05mm erode cannot do: removing 45mm² of material by thinning
  0.05mm from each side would need a feature some 450mm long. The heuristic mis-assigns nested and
  non-convex rings, leaving true parents unmatched. Discarded rather than reported.

What survives is the total-area table above and the geometric bound. The extra area the wider rung
costs (1.83% against 0.37%) is real; whether it is uniform shrink or includes whole sub-0.1mm
contours is **not established here**, and does not need to be, because neither could print.

An intermediate version of this fix raised a "some detail was too fine to print" notice when the
wider rung was used. It was removed. A review round showed its area test could never be false, an
erode being monotone, so it fired on every escalation regardless of whether anything was lost. A
warning that is always true is not a warning.

## Wrong turns

- **Measured in the wrong units, twice.** Area loss was first computed on the tracer's 512px output
  rather than the 276mm part, then with `turf.area`, which treats coordinates as WGS84 degrees. Both
  produced a flat 0.31%/0.37% across every erode distance. A shoelace with a self-check on a known
  square fixed it, and the numbers then scaled linearly as an erode must.
- **A third argument that was being ignored.** Four distances reported identical area because the
  probe passed `erodeMm` to a function that still took two parameters. The measurement looked
  stable and was one value repeated.
- **A synthetic disc did not reproduce it.** A clean 96-segment cylinder with the same artwork and
  the same 180 degree rotation cut clean. The real wheel mesh is required, which is why this was
  instrumented in the running app rather than in a unit test.
- **The `edge` case was nearly missed.** An edge slice stands on the part's outer wall and is
  recorded in `partEdgeColors` as "the rim prints in this colour". Eroding it 0.05mm pulls it off
  that rim. Edge slices keep the single narrow attempt.

## Still open

The repair block is unreachable on a conformal zone: `ConformalZoneMapper.buildCutter` absorbs an
invalid prism inside `tryWarp` and returns null, so `soup` is falsy and the ladder never runs. The
chair body gets nothing from this fix. Recorded in [tech-debt.md](../tech-debt.md); whether it needs
anything is unmeasured, because the chair body is hidden from the UI and nobody has driven dense
artwork through a conformal zone.
