# Tech debt

**Open** deferred work and known-wrong behavior. One section per item, each
stating what was measured, why it was deferred, and what closing it would
take. Update the relevant section instead of re-deriving the number from
scratch.

**When an item is fixed, delete its section — don't mark it `FIXED` and leave
it.** The CHANGELOG entry and the commit are the record of the fix. Anything a
future reader still needs — the measurement behind a constant, an approach
that was tried and lost — belongs in a comment next to the code it constrains,
not here: that is where someone changing the line will actually see it. Keep a
closed item only where it is still load-bearing for something open.

**Before deleting, read what the section still owes and move that out first.** A
section can be almost entirely closed and still carry the one thread that isn't
— a follow-up, an unclaimed optimization, a caveat nobody has measured. That
survives as its own section; only the closed part goes. Checking that the diff
removed only the lines you meant to remove is _not_ this check: it confirms the
scope of the edit, not that what left was finished.

**A section is a work item, not an archive.** The record of a measurement or an
approach that lost belongs in a comment next to the code it constrains, or in
[docs/pipeline.md](pipeline.md) for the geometry pipeline — not here. What stays
here is closeable: it names code work under a “Closing it” line.

## check:zone-occlusion's five-view identity sweep never inks four small zones

`scripts/check-zone-occlusion.mjs`'s per-zone identity pass (`IDENTITY_SWEEP`)
drives five camera views and requires every zone to land at least one interior
ink sample in one of them, so "never looked" can't read the same as "checked
and right." Four zones never do.

Measured `npm run build && MOSAIC_GPU=1 npm run check:zone-occlusion`, chair,
2026-09-24: `wing-left`, `wing-right`, `seat-left`, `seat-right` each report
"produced no interior ink sample anywhere in the sweep." Nothing else fails —
the through-pick and `*whole`-identity failures this same run used to report
are gone (see the CHANGELOG entry that closed them).

The previous version of this entry also recorded an orbit-drag throw ending
the run partway through this same sweep, and told the next reader to re-run
before trusting any count. Two full runs of the command above (one on
unfixed `main`-equivalent code, one after the fix) both completed all five
angles with no throw. Treating it as gone rather than chasing further: the
"stale zone name" cause that entry guessed at doesn't hold either way — the
sweep already reads zone ids live off the DOM, never a hardcoded one — so the
throw looks like the `orbitTo`/gizmo-drag flakiness `run-app`'s skill already
documents, not a defect specific to this check. The 4-failure count above is
from a full, un-thrown run and can be trusted.

- `wing-left`/`wing-right` predate this run: the sweep's angles never see
  enough of a fender face-on to sample one.
- `seat-left`/`seat-right` are new to the list. They're the two mount tops
  left behind when the seat pan (once its own zone, inked fine by `v0`) left
  every zone; both are apparently too small or too edge-on across all five
  views.
- Closing it: widen `IDENTITY_SWEEP` (or add a view) until each of the four
  lands an interior sample, then re-measure. Not attempted here — the sweep's
  own comment already called this out as separate from the classifier fix
  this run closed, and widening it deserves its own pass with a real
  chart-coverage measurement behind the new angles, not a guess.
- Not in CI (nothing runs this script), so it blocks nothing today. It is the
  only automated guard on convention 12, which is why it is worth repairing
  rather than deleting.

## The covers reference has no tires, so each flank keeps artwork the tire hides — unmeasured

`stubs/dead-zones.3mf` carries the printed wheel only: two halves plus the cap,
and the bake now replaces those halves with a solid 280mm disc of the same
diameter. The assembled chair runs a tire ring outside that, which the bake has
never seen, so the flanks treat the band under the tire as printable.

All three rows come from
`npx vite-node scripts/measure-wheel-shadow.mjs --tire-mm 30`, re-taken
2026-08-31 against the rebaked sidecar. That script's header defines each projection; the shadow and
tire-ring rows are geometry, independent of the bake algorithm, and the baked
row is the flank's whole dead area summed out of
`public/stl/chair-body-zones.json`.

|                                               | `left`    | `right`   |
| --------------------------------------------- | --------- | --------- |
| straight-on wheel shadow on the zone          | 36,737mm² | 36,894mm² |
| baked dead there (the rest is the 20mm bleed) | 23,486mm² | 23,777mm² |
| what a 30mm tire ring would add               | 18,619mm² | 18,441mm² |

- **The tire row is unmeasured, and only its arithmetic is reproducible.** 30mm
  is scaled off a photo — the hub reads ~340px for a stub-measured 280mm, the
  band ~37px — and the ring is grown radially about each cover's own axle in
  the script, not modelled. Read it as "about as much again as the stub
  covers", never as a number to build on. The two rows above it are measured.
- The earlier figures in this section (36,619 / 36,730 for the shadow, 22,447 /
  23,215 for the ring) named no command and could not be re-derived. The shadow
  reproduces to 0.2%; the ring does not, because whatever built that annulus is
  not what the script does.
- The direction is safe: surface under the tire is treated as printable, so it
  costs a filament change on plastic nobody sees. It never leaves blank plastic
  where artwork was expected, which is the failure that would matter.
- Closing it is now one number. The wheel reaches the bake as a declared solid
  (`covers.solids` in `scripts/zone-configs/chair-body.json`), so raising
  `radiusMm` from 140 to the tire's real outer radius and rebaking is the whole
  change. It still needs a measured radius: the disc is posed from the file and
  its diameter checked against the bodies it replaces, so a guessed number
  fails the bake rather than quietly hiding the wrong ring.
- The rows above moved when the four hollow half-dishes became two solid discs
  and the bleed moved after the smoothing. The shadow row is geometry and barely
  moved; the baked row rose because the wheel now hides across the mount/fender
  seam instead of stopping dead at it.
- The owner has seen the trade and chose to leave tires out for now.

## Corner handles and an axis handle compete for the same drag

Convention 14 of [ui-conventions.md](ui-conventions.md): only one manipulation affordance is
offered at a time. The placement gizmo draws corner handles and an axis handle that both answer
the same drag.

- A UI decision, not a geometry one: which affordance a drag on the frame belongs to.

**Closing it**: pick the one affordance each drag starts, in
[src/scene/designGizmo.ts](../src/scene/designGizmo.ts), and drop or separate the other.

## The chair's prime-tower positions have only been verified on one bed size

All of its export placement — plate assignment, rotation, position,
the per-part brim/support/infill overrides, and now the tower — is baked by
[scripts/bake-chair-placement.mjs](../scripts/bake-chair-placement.mjs) into
[src/export/chairPlacement.ts](../src/export/chairPlacement.ts) from two
human-checked files: MakeGood's 12-plate Bambu Studio project for the poses
(the script re-verifies every shipped mesh against it before writing, worst
plate-space disagreement 0.024 mm), and a four-filament export with every
tower dragged into place for the towers. The second one had to exist
separately because the first prints in one or two filaments and never had a
real tower on it.
What's left: both shipped bed sizes have had that pass (270mm Snapmaker,
256mm A1), and the deltas are stored relative to each plate's anchor part so
they follow the part when a bed re-centers the group. Seven of the ten
transferred between the two beds unchanged, which is the evidence the
relative model works; the two wheel-mount plates (1.8mm and 3.9mm) and one
handle plate (1.2mm) did not, and carry a `primeTowerDeltaByPlate` entry for
256x256. **Any third bed size inherits the 270mm numbers untested** — the
350x320 `bambu-h2d` entry in [src/export/printers.ts](../src/export/printers.ts)
is the one that exists today, and the first non-square bed of the three.
Adding a bed means another pass:
`scripts/export-chair-examples.mjs` builds the files, and the bake takes one
`--towers` file per bed and works out for itself which plates disagree.
The caster plates stay on `suggestTowerPos` in
[src/export/threemf.ts](../src/export/threemf.ts), which is correct — they
print one filament and get no tower.
One loose end in the tooling: whether `wipe_tower_x/y` names the tower's
center or its origin corner isn't pinned down, so the export script only
checks that a tower lands on the bed, not that a given footprint clears the
edge. Both reference files put a tower at exactly x = 15 on a 256mm bed,
which a center-based check would wrongly reject.

## A depth on the chair body, or on a face the Y axis can't measure, has no upper bound

A pocket deeper than the wall cuts a hole through it and exports with no depth
warning. How thin the chair's walls get is **unmeasured**.

- A flat face bounds each colour region by the wall under it
  (`FlatZoneMapper.boundByWall`), inside the part-wide bound (`maxCutDepth`).
- A conformal zone declines both, and raises nothing. Its cut follows a normal
  field, so there is no one axis to measure along.
- A flat face declines both when its normal is not near Y or its plane lands
  off the mesh. Such a face already gets the "isn't vertical" warning, but not a
  depth one. In `scripts/measure-wall.ts`'s table: the wheel's ranks 3-5, the
  footrest's 2-5.
- Every shipped default face is flat and bounded: wheel, footrest and hubcap
  (`node_modules/.bin/vite-node scripts/measure-wall.ts`). The chair body is the
  one shipped part with conformal zones.

Closing it means measuring the material behind each point of a region along the
normal the warp cuts it at, then clamping and warning the way the flat mapper
does.

## Rebuild performance needs ongoing work — this is a heavy application

The flat-mode half of this closed on 2026-08-23. `computeNetRegionsByColor`
now calls the clipping engine n-ary (`COVERED_BATCH`,
[src/geometry/regions.ts](../src/geometry/regions.ts)) and measures **1.76x
faster on the 135-path SVG**, 1.5-2.9x across the corpus, with per-color areas
unchanged (0.000% worst relative drift). See
[docs/findings/2026-08-23-boolean-pass-and-weld.md](findings/2026-08-23-boolean-pass-and-weld.md).

**The ~9s figure this section used to quote was wrong, by 4.5x.** Measured in
Chrome against the real module, the pass on that SVG took **2066ms** before
the change and 1177ms after. Nothing was found that would have made it 9s, and
the reading was never reproduced. A whole flat rebuild of that file is ~5s, so
the pass was never the majority of it either.

Two leads from this section are now settled rather than open:

- **Turf's wrappers cost nothing.** `turf.union` is a one-line pass-through to
  the same engine. A pairwise loop calling the engine directly lands within 3%
  of the pairwise loop calling Turf, on every corpus file. The win came from
  n-ary sweeps, not from bypassing Turf.
- **`cleanFeature` re-scrubbing costs nothing.** The old loop scrubbed the
  accumulator three times per shape; skipping that measured 1.02-1.06x. It was
  5-7% of the pass, and 93-95% was inside the engine.

Still open here: the Web Worker lead (doesn't reduce compute, makes the wait
invisible). Still a measured dead end: bbox pre-filtered per-shape diffs, ~2x
SLOWER than the accumulator on real artwork (full-canvas backgrounds overlap
everything) — see the comment on `computeNetRegionsByColor`.

**Do not "improve" `COVERED_BATCH` by raising it.** Never folding the
accumulator is the fastest setting on a 140-shape file and **10x slower than
the old loop at 400 shapes**, because every difference then carries every shape
above it. The constant is measured over 50/100/200/400 shapes and 8 sits on a
flat plateau; the bench that produced it is `scripts/bench-regions.ts scaling`.

The chair-body/Fill combination is an order of magnitude worse than the
number above, measured on `MOSAIC_GPU=1` production build, 2026-08-02: the
bundled `public/patterns/zebra.svg` in Fill mode on the chair's Left side
alone (one of five zones) took **405.6s** to settle, non-linear progress
(41% at t+15s, 43% at t+60s, 52% at t+180s). The same design set to "All
zones" (all five zones, the conformal-recut cost `state/artwork.ts`'s
zone-binding-default comment already warns about) did not finish inside a
900s timeout. This is the conformal-wrap + per-part CSG path specifically,
not the flat-mode boolean pass measured above — the per-part cut solids and
the cross-part zone triangulation both scale with triangle count, and the
chair's zones carry hundreds of thousands of triangles (size and composition
are recorded next to the sidecar writer in
[scripts/bake-zones.mjs](../scripts/bake-zones.mjs)). See the next section for
the interaction consequence.

**Partly superseded, 2026-08-03.** Those numbers were taken against a zebra
asset carrying 13.6k vertices per tile, most of which were marching-squares
oversampling rather than shape (see "Turf's tile union has a vertex ceiling"
below). With the thinned asset the same single-zone case measures
**93.6s**, against **468.7s** re-measured on the old one — and it is doing
_more_ work, not less: 2.07M triangles against 853k, because the old asset's
tile union was failing and falling back to unmerged shapes. So a large share
of what was recorded here as "conformal-wrap + per-part CSG is slow" was one
bad asset. The path is still slow enough to want the accumulator or worker
fix above — 93.6s is not interactive — but re-measure before quoting the
405.6s figure as the cost of the pipeline itself. The "All zones" >900s
result has not been re-measured.

**Withheld from users, 2026-08-05.** The chair-body kind carries
`withholdFill` (`src/types.ts`), so Fill and the pattern strip are not offered
on it and no user can reach the numbers above. The kind itself is offered in the
Part dropdown; only Fill on it is not. This is a gate, not a fix: the path is
unchanged and every measurement here still stands. Clearing the flag
needs the accumulator-or-worker fix.
Sticker on the chair is unaffected and was measured at 19.5s for a full
five-zone rebuild on the same box, which is why only Fill was withheld.

**Don't quote that 19.5s without saying at what design size.** It used a design
covering the zones;
[docs/findings/zone-rebuild-cost.md](findings/zone-rebuild-cost.md) reproduces it
at 400% (17.0s) and measures an ordinary auto-fit sticker on all five zones at
4.0s — a 5x spread on the same path. What is paid for is pocket area, not
surfaces touched.

## Many disjoint shapes of one SVG make the flat pass superlinear

Unmeasured on real artwork; measured on a synthetic spotted design. One colour of
N non-overlapping blobs over a background, one run each
(`MOSAIC_BENCH_REPEATS=1 node_modules/.bin/vite-node scripts/bench-regions.ts merge dots:400 dots:800 overlap:800`):

| Fixture     | Whole pass | Longest difference | Longest fold | Merge call |
| ----------- | ---------- | ------------------ | ------------ | ---------- |
| dots:400    | 15.9s      | 119ms              | 114ms        | 132ms      |
| dots:800    | 91.7s      | 434ms              | 281ms        | 371ms      |
| overlap:800 | 1.9s       | 15ms               | 16ms         | 30ms       |

One run per row, so read ±20%: `chunks dots:800` (median of 5) puts the same
merge call at 345ms.

- Twice the blobs cost 5.8x the time. Disjoint blobs never collapse the
  accumulator, so every difference and fold carries every blob above it.
- `COVERED_BATCH` bounds how many shapes one call takes, not how many
  vertices. No single call reaches 0.5s; the pass is long, not frozen.
- An image-traced SVG or a spotted pattern is the input that would do this. A
  PNG or JPG cannot: the tracer hands over one shape per colour.
- No corpus file comes close. Its largest per-colour list is 37 pieces
  (`bench-regions.ts merge` over the corpus files).
- Chunking the per-colour merge was measured and does not help. The numbers are
  on that merge in `computeNetRegionsByColor`.

**Why deferred**: no real file has shown it yet.

**Closing it**:

1. Measure a real image-traced SVG from Illustrator or Inkscape first.
2. The fix is to stop differencing against blobs that cannot overlap.
   A bbox pre-filter is the obvious one and was recorded ~2x slower on real
   artwork (full-canvas backgrounds overlap everything; no command was kept, so
   re-measure before relying on it). It needs a spatial
   index on the accumulator, or the disjoint fast path the
   `computeNetRegionsByColor` docstring describes.
3. Whatever lands must keep the corpus at or under its current time
   (`bench-regions.ts attribute`).

## A cancel still waits for the one Manifold call already running

The per-part body now has a `finally` over every solid it allocates, and checks
at each boundary between its atomic Manifold calls, so a press during the cut
aborts the part instead of waiting it out. Measured on a 6000-region wheel at
**0.04-0.06s** for every cancel after the first, and **0.07-0.29s** for the first
of a session, over five runs, with the WASM heap flat at 16.8 MB;
[2026-08-28 cancel inside the cut](findings/2026-08-28-cancel-inside-the-cut.md)
carries the run and the leak it was falsified against.

What is left is the floor: the checks sit between colours and between booleans,
so the wait is whatever the step already running takes. That is one union,
difference or intersection, or one colour's extrusions plus the repair ladder
behind them.

- **Unmeasured.** Only the wheel was driven, and its cut is short next to its
  region pass. The case that would show the floor is the chair in Fill, whose cut
  is heavy (93.6s for one zone, recorded on `showOverlay` in
  [src/ui/overlay.ts](../src/ui/overlay.ts)).
- Closing it needs the engine to yield mid-boolean, which Manifold does not
  offer. Measuring it first is the cheap half, and needs
  `scripts/check-cancel-latency.mjs` extended: it hardcodes a wheel fixture of
  rects and takes only a region count and a repeat count, so a chair run means
  teaching it a kind and a Fill mode.

## `export-chair-examples.mjs` can't reach Fill on the chair

Tooling, broken since #137. The script sets `.artwork-mode` to `fill` and
asserts it took. `chair-body` carries `withholdFill: true`, so
`artworkListPanel` never renders that select and the step times out.

- Not a selector to update. The script exists to put several colours on every
  part, so each plate's prime tower sees real swaps. Sticker on one zone isn't
  that.
- Closing it means either `withholdFill` coming off, or a different way to put
  several colours on every part.
- Clearing `withholdFill` needs the accumulator-or-worker fix in "Rebuild
  performance needs ongoing work" (above). Nothing else in this file blocks
  it.

## The pattern library is still switched off, and nothing measured blocks it

`PATTERN_LIBRARY_ENABLED` is `false` in
[src/state/patterns.ts](../src/state/patterns.ts), so the picker strip is empty
on every part. Its one named blocker was zebra + Fill dropping the black on
"Handle (left)", and that no longer reproduces.

- **Not reproduced, 2026-09-24**: patch `withholdFill: false` in
  `src/assembly/kinds.ts`, `npm run build`, open `?kind=chair-body` on a
  `MOSAIC_GPU=1` preview, load `public/patterns/zebra.svg` (it binds to Left
  side) and set Fill. No `Couldn't cut color`, and the exported 3MF gives
  "Handle (left)" a Black part.
- Same on the #137 tree (`04af2f9`): no `Couldn't cut color`. The 2026-08-03
  report can't be reproduced from what it recorded.
- Engine sweep, 47 builds: all four patterns in Fill on all eight chair
  zones, and zebra on "Handle (left)" at 4 scales x 3 offsets plus 3 more
  offsets at 100% (32 + 12 + 3). `ConformalZoneMapper.buildCutter` returned
  null 0 times in 228 calls. The three builds at 50% cut nothing: zebra is
  refused as too detailed there.
- One build of the sweep:
  `node_modules/.bin/vite-node scripts/measure-conformal-cutter-nulls.ts zebra left 1 0 0 chair-handle-left`.
  Arguments are pattern, zone, scale, offX, offZ and an optional part id. The
  full job list and the live drive are in the PR body of #PR.
- Turning the library back on is the maintainer's call. A kind carrying
  `withholdFill` hides the strip anyway, so the chair is unaffected.

## A zone template's outline is faceted, because nothing curve-fits a zone boundary

The remainder of the 2026-08-05 "templates have odd/wrong edges" report, after
the clip-region folds were removed. What is left is cosmetic, and is not a
reason to withhold anything.

A zone boundary is traced along mesh triangle edges and emitted vertex for
vertex, then simplified by `simplifyLoop` at `SIMPLIFY_TOL_MM` and written as
`L` commands. So an outline is as faceted as the tessellation under it.
Measured across all eight chair templates: **zero curve commands**, in every
one.

- Not wrong, just angular. The outline is the surface, to within 0.2mm.
- The repo already curve-fits, in `src/raster/curve.ts`, but that is built for
  the raster tracer's pixel-derived paths. Fitting a mesh-derived boundary is a
  different problem and an unmeasured one: nobody has established how much
  smoothing a 57.9 x 140.1mm opening's corners tolerate before the template
  stops matching the cut.
- Closing it means measuring that first. Until then any tolerance would be a
  number invented to satisfy the complaint.
- Applies to every part that ships zones, not only the chair.

## The raster edge-density reading depends on how big the file is

**Measured**: [2026-08-19 photo cluster](findings/2026-08-19-raster-photo-cluster.md) supersedes
result 1 of
[2026-08-19 raster corpus calibration](findings/2026-08-19-raster-corpus-calibration.md). Six of
seven photographs separate cleanly from the flat cluster and the 0.285 cutoff sits in that gap;
the seventh, a balloon against a clear sky, stays inside the flat band. The size dependence below
is what is left open.

`measureImage().edgeDensity` counts the share of pixels that differ from a neighbour, and that
share depends on the size the image is measured at. `MEASURE_EDGE` caps rather than resamples, so
a source under 512px is measured at its own size and reads higher for it.

| Source                                        | Measured         | Reads                                 |
| --------------------------------------------- | ---------------- | ------------------------------------- |
| `public/patterns/zebra.svg` exported at 128px | 0.6324           | photo                                 |
| the same file exported at 256px               | 0.3661           | photo                                 |
| the same file exported at 384px               | 0.2430           | flat, and this is where it flips      |
| the same file at 512px and above              | 0.1823 to 0.2086 | flat, a noisy band and not one number |
| `red-sox-logo`, a real 300px logo             | 0.2531           | flat, 0.03 from the cutoff            |

Two flat colours at every size. Only the export resolution changed.

The `sizes` bench mode shows the same effect from the other direction, on the measurement rather
than the file: `mario` reads 0.433 (photo) measured at 256 and 0.253 (flat) at 512. That rung is
diagnostic rather than shipping, since `mario` is always worked at 1024, but it isolates the
measurement size from the file size.

**Closing it**: derive the reading from something size-independent, or measure at a fixed size the
source is always resampled _to_ rather than capped at. The second is the smaller change and would
alter what every existing threshold means, so it wants its own measurement pass.

### Still unmeasured

Where volunteer uploads land. Six of the seven photographs are CC-licensed Commons files, which is
sound for asking whether the statistic _can_ score a busy photograph high and is not a sample of
what this app receives. `FLAT_EDGE_DENSITY` (0.12) and `PHOTO_EDGE_DENSITY` (0.45) are untested by
that run, which exercised only the midpoint. Flat art reaching 0.2532 is mild evidence against the
flat endpoint.

## Colors is the one trace control still fixed, and no single value suits real artwork

**Rejected, measured**: [2026-08-20 knee detector](findings/2026-08-20-knee-detector.md). Picking
the palette size from a knee in the region-count curve is right on two of the four sources that
have a column at their shipping size, moves with working size without a trend, and costs 3.5 to 5
seconds. Supersedes the "6 of 8" reading in
[2026-08-19 raster corpus calibration](findings/2026-08-19-raster-corpus-calibration.md), which
was hand-scored off one full-resolution curve. **The problem below is unchanged and unfixed.**

Working resolution, blur and despeckle are all chosen from the image. The default palette size is
not — it is a constant, and measured across the sample corpus (`stubs/raster test/`, 2026-08-04) no
constant works. Asking for more colours than an image actually has does not return fewer, the way
it does on synthetic flat art: real files are lossy and anti-aliased, so the quantizer always finds
more tones and spends the surplus on the fringe around every edge.

Measured on the 300x300 Boston Red Sox logo, which has three real colours:

| Colors | Regions | Slots | Result                                            |
| ------ | ------- | ----- | ------------------------------------------------- |
| 3      | 37      | 4     | clean                                             |
| 4      | 56      | 5     | clean                                             |
| 6      | 364     | 7     | pale halo rings around the ring, letters and sock |
| 8      | 712     | 9     | worse                                             |

The same default is right for a five-colour cartoon (Tweety traces cleanly at 6) and too low for a
nine-colour one (Mario loses its yellow buttons at 6, and recovering them at 8 costs the blue iris
to a desaturated entry). So the harm runs both ways, but not symmetrically: too few colours reads as
a simplification, while too many reads as a defect — halos look broken, cost filament slots, and
multiply region count tenfold.

The region count looked like a usable signal for choosing it automatically, and is not: see the
rejection above. The curve is unstable across working size, the full ladder costs seconds rather
than the tens of milliseconds a quantize pass suggested, and the rule is right on two of the four
sources that have a column at their shipping size.

What closing it needs is a different signal, measured. Distinct colours surviving a coarse
quantize, or the ΔE spread of the palette, are both single-pass and neither has been looked at.
Whatever the candidate, it has to be checked on photographs, where region growth is smoothest and
any signal weakest, and the traces have to be **judged by eye**: region count cannot tell a cleaner
trace from a coarser one.

## The trace parameters are calibrated against a downscale that is no longer constant

**Measured**: [2026-08-19 raster corpus calibration](findings/2026-08-19-raster-corpus-calibration.md)
quantifies the cost; [2026-08-20 blur vs downscale](findings/2026-08-20-blur-vs-downscale.md) is an
invalid test of the fix this section proposes. Read the second before designing another.

`decode.ts` has always noted that the downscale to the working size "doubles as the first noise
filter", and the blur/despeckle endpoints in [stats.ts](../src/raster/stats.ts) were tuned with
that filter in place. It was doing more work than the note implies: a 1588px source averaged 3:1
down to 512px loses the anti-aliased fringe on every colour boundary outright.

Making the working size adaptive broke that assumption without touching the parameters. Flat art
now averages about 1.5:1, the fringe survives, and those pixels sit between two palette entries and
get assigned alternately — a cartoon's eye came back striped blue and white. Flat art carries a
one-pixel blur to compensate, and quantization was split so that the palette is discovered from the
source while only assignment reads the blurred copy (otherwise a blend tone that exists nowhere in
the file wins an entry and costs a filament slot; `tests/raster-quantize.test.ts` pins both halves).

What is still unresolved: the compensation is a constant, not a function of how much downscaling
actually happened. A small source that is never downscaled at all gets the same one-pixel blur as a
1588px one that was halved, and neither is the case the endpoints were tuned for.

**Still open, and one attempt to test it was invalid.**
[2026-08-20 blur vs downscale](findings/2026-08-20-blur-vs-downscale.md) tried to check whether the
benefit tracks the ratio by re-rendering vector patterns at several sizes. It cannot: the working
size is always 1024, and a vector baked large then filtered down gives essentially the same raster
as one baked small, so the anti-aliased fringe the compensation exists to replace is never created.
Four of the five sources' control arms do not change at all across the ladder, and the fifth moves
with its own base-blur flip rather than with the ratio. Read it before designing another test.

A valid version needs genuinely different raster pixels per rung, one large flat-art image resampled
the way a user's exports would be. `bench-raster.ts blur` is the harness for it.

What is not in doubt, from the earlier corpus run: the constant is wrong for some artwork. It
quadruples region count on `cartoon` at the size the app ships it, and across five vector sources at
a fixed working size it helps exactly one and hurts or no-ops the rest.

**Closing it** still means deciding what the compensation should be a function of, and the ratio is
the untested candidate rather than a rejected one. Whatever the test, it needs raster inputs
resampled to several sizes on disk, since no mode here can produce them, and the traces need looking
at rather than counting: region count cannot tell a cleaner trace from a coarser one.

## A Fill under a sticker overlaps just like two stickers do, and isn't checked

The overlap check in
[src/geometry/designOverlap.ts](../src/geometry/designOverlap.ts) compares
two stickers by their placed footprints and then by how much of each one's
ink reaches the footprint they share, and treats two Fills on one zone as
always overlapping. It deliberately says nothing about a Fill paired with a
sticker, because a pattern background with a design on top is a real
workflow and flagging it would fire on the intended use.

But the geometry doesn't care about intent: the sticker's pockets and the
fill's pockets are separate cutters, so wherever the sticker's colors differ
from the pattern's underneath it, the export carries two inlay solids in the
same volume — exactly what the sticker-vs-sticker warning exists for. It is
unmeasured: no export of that combination has been opened in a slicer to see
what actually prints, and the app ships no example using it.

Two ways to close it, neither cheap enough to bundle with the check that
prompted this note. (1) Make it correct rather than warned: subtract the
sticker's pockets from the fill's before the inlay intersection, so the
background yields to what sits on it. That is the behavior a user expects,
and it makes the pairing supported instead of merely tolerated — but it is a
per-color boolean on the fill's full tiled region, on the path already
measured at 405s for one chair zone (see the rebuild-performance section).
(2) Warn only where the fill's ink actually lies under the sticker. The
plumbing for that now exists: `placedInk` in
[src/geometry/assembly.ts](../src/geometry/assembly.ts) hands the sticker
comparison each design's placed cut regions. A fill's are the tiled ones, so
this still needs the grid, and the check would have to stop skipping the
mixed pair. Start by measuring (1) on the wheel, where the fill region is
small enough to time honestly.

**Decided 2026-08-30**: go with (1), make it correct — subtract the sticker's pockets from the
fill's before the inlay intersection. Not yet scheduled; still needs the wheel measurement above
before committing to the full-tiled-region cost on the chair.

## Two traces still drop a color and say nothing about it

`rasterColorLossNotice` ([src/raster/parse.ts](../src/raster/parse.ts)) raises a dropped-color
notice only where its remedy is both true and available: raise Detail, or make the design or the
part bigger when the nozzle-width floor pins it. Two cases are left silent, both
`droppedColors > 0`.

| Case                      | Suppressed by                | Reproduced by                                                    |
| ------------------------- | ---------------------------- | ---------------------------------------------------------------- |
| Capped, and short a color | `capped`                     | `npx vitest run tests/raster-parse.test.ts -t "leaves a capped"` |
| Detail already at 100     | `!detailLowersFloor`, no pin | `npx vitest run tests/raster-parse.test.ts -t "DETAIL_MAX"`      |

- **Capped**: the trace shows `rasterCappedMessage` only, which says detail "was merged into its
  surroundings" and never that a color left the palette. The two remedies are opposites — capped
  says lower Colors or Detail, dropped-color says raise Detail — so both on one image contradict
  each other. Reproduced synthetically (1024 six-pixel blocks over two flat bands plus one-pixel
  specks, 320x320 at Colors 5 and Detail 100: `capped: true`, `droppedColors: 1`), never on the
  corpus.
- **The cap now raises until the count is under, so a capped floor can go much higher.** On
  512px 8-label noise at placed floor 1 it settles at 47px
  (`node_modules/.bin/vite-node scripts/bench-raster.ts cap`). The same command against the
  previous `src/raster/trace.ts` stops at 7px with 9237 components. The higher the floor, the
  likelier a whole color goes under it on a source that caps.
- **Detail at 100** with no placement pinning the floor has no remedy to offer. A bigger size
  can still lower the feature floor there, so saying nothing is not always right, but no
  measured rule says when it is.
- **A partly-pinned floor still fires, with a weak remedy.** Where the nozzle floor sits just under
  the fractional one, raising Detail lowers the floor by a little and may not bring the color back.
  The notice is still true — it says what Detail does, never that the color returns — and no notice
  can promise recovery, since a quartered floor can still be above a color's pieces. Drawing a "how
  much movement is enough" line would be an invented constant, so it is left as is. **Unmeasured**:
  how often that band is where real artwork lands.
- **The notice can also vanish mid-remedy, which reads as fixed.** Its presence tracks "Detail can
  still move this floor", not "a color is missing". On `sprinkled(384)` with no placement, Detail 90
  gives floor 7 and the notice; Detail 95 gives floor 6, `detailLowersFloor` false, and the notice is
  retracted — with `droppedColors` still 1 and the readout still one color short.
- **The capped split also gives a round trip.** Raising Detail on a dropped-color notice lowers the
  floor, raises the component count, and can trip the cap. The next trace is capped, the notice is
  retracted, and the user is told to lower the Detail they just raised, with the color still gone.
- **The trigger has never been run against the corpus.** Every test uses a synthetic fixture, and
  the five sources the notice exists for (dalmatian, zebra, cartoon, gravel, foliage) sit in the
  gitignored `stubs/`. `scripts/bench-raster.ts` already reports `painted` per source and is where a
  `droppedColors`/`detailLowersFloor` column would go, which would answer whether the two
  suppressions above silence any of those five at their own placements. **Unmeasured.**
- Closing either takes a message carrying both facts, or a measured rule for which remedy wins.
  Neither is a wording change: the capped one needs an answer to whether raising Detail can recover
  a color on a capped trace at all.

## A hubcap cut to its artwork may re-trace on every edit — unmeasured

A resize re-traces a raster once its placed floors move (`retraceMovedSources` in
[src/state/artwork.ts](../src/state/artwork.ts)). On a hubcap cut to its artwork, the part's size
follows the trace: when the outline overhangs the wheel, the shrink that fits it
(`generatedFitFactor`) comes from the traced outline's reach.

- A re-trace that removes or restores a speck at the outline's far edge changes that shrink, and
  with it the floors. The trace is then stale again.
- **Bounded**: a settled pass never asks for another, so this costs at most one re-trace per edit,
  not a loop.
- **Unmeasured**: whether any real image has a speck at its edge between the two floors. No test
  or bench builds one.
- Closing it needs that measurement first. If it happens, the fix is a fit that does not read the
  trace's own specks, not a cap on re-traces.

## `deChecker` can leave a component under the despeckle floor

`despeckle` leaves nothing under the floor, but `deChecker` runs after it
([src/raster/trace.ts](../src/raster/trace.ts)). Breaking a 2x2 checkerboard rewrites one cell,
which can shave a pinch point and split a surviving component in two. One half can be under the
floor the trace reports.

- **Off-corpus it happens**: 2 of 24 uniform-noise rows return a component under their floor.
  Reproduce with `node_modules/.bin/vite-node scripts/bench-raster.ts cap`.
- **No corpus source does it**, so what it costs a real image is unmeasured.
- **Swapping the order is not the fix.** `despeckle` relabels whole components and can create the
  checkerboard `deChecker` exists to remove, and a self-touching ring is the worse failure.
- The cap is not affected: its loop rechecks the count after `deChecker`, so a split can cost it a
  further raise but not the bound.
- **The bench's `despeckle` mode can miss one.** Its `under` column reads the components the trace
  _returns_: background components and any whose ring collapsed are already gone. A transparent
  speck left under the floor would be a real defect, and this check would not see it.
- Closing it needs a way to absorb the split pieces that cannot recreate a checkerboard, and a
  check that counts background components too.

## Keep `@turf/turf` pinned to 6.5.0 — v7 is a measured perf regression here

A 7.3.5 upgrade was fully implemented and benchmarked (2026-07):
correct output, but its new polygon-clipping engine ran **5–10x slower**
on this app's union-accumulation hot path (40ms → 215ms at 20 shapes,
76ms → 726ms at 120), turning slow rebuilds into multi-minute ones. Don't
re-attempt without benchmarking that path first. The 6.5 quirks remain:
the boolean-failure workarounds in
[src/geometry/regions.ts](../src/geometry/regions.ts) (degenerate-ring
scrubbing, precision-truncation retries) target 6.5's exact
polygon-clipping bugs, and 6.5's package typings don't resolve under
modern TypeScript, hence the shim in [src/turf.d.ts](../src/turf.d.ts).

**Nothing re-measures this on demand.** The 5–10x figure came from a one-off harness built for
that attempt and not kept, so the pin is enforced by prose and an exact `package.json` version. A
standing `bench-geometry` script is deliberately not built: it would only ever be exercised by an
active turf upgrade, and writing it now costs about what re-deriving it later costs. When an
upgrade becomes live work it is step one rather than an afterthought, over the
union-accumulation path at a few shape counts, with the numbers above as the baseline to beat.

## Turf's tile union has a vertex ceiling, and the fix is a refusal rather than a batch

Fill mode unions one copy of the design per tile, and `@turf/turf` 6.5's polygon
clipping gives up on a big union without throwing: it returns a partial result,
so the part loses geometry behind a `Couldn't merge the shapes …` warning naming
no cause. That message used to assert a cause it could not know ("likely a
self-intersecting path in the source SVG"), which was wrong here: the paths were
fine, there were simply too many of them.

**Where the ceiling is: a 503k-600k band, swept 2026-08-30.** Not the 800k this
section used to quote, which was an estimate off one live build.
[2026-08-30 tile-union ceiling](findings/2026-08-30-tile-union-ceiling.md)
carries both sweeps and the command.

| pattern   | points per tile | highest clean | lowest failure |
| --------- | --------------- | ------------- | -------------- |
| zebra     | 1361            | 544,400       | 600,201        |
| dalmatian | 559             | 503,100       | 537,199        |

The two overlap, so no point count separates clean from failing, and neither
does tile count. The band replaces the 800k figure in `scripts/gen-patterns.mjs`
and `tests/patterns-assets.test.ts`; their constants and assertions are untouched.

The original 2026-08-03 observation, zebra in Fill mode on one chair zone
(`MOSAIC_GPU=1` production build), is what made it concrete:

|                                      | 13.6k verts/tile  | 1.3k verts/tile |
| ------------------------------------ | ----------------- | --------------- |
| vertices across the zone's 143 tiles | 1.95M             | 187k            |
| union failures                       | 8, across 4 parts | 0               |
| triangles produced                   | 853k              | 2.07M           |
| rebuild                              | 468.7s            | 93.6s           |

The doubled triangle count is the tell that this was data loss rather than
slowness: the failing run produced _less_ geometry because four parts fell back
to unmerged shapes.

**Fixed: nothing crosses the ceiling unannounced now.** Two mechanisms, one per
source of tiles.

- Bundled patterns, at build time. `scripts/gen-patterns.mjs` thins zebra's
  contours (`simplifyEps`), and `tests/patterns-assets.test.ts` fails any
  pattern whose vertex count times a chair zone's tile count would approach the
  ceiling.
- User SVGs, at build time in the app. `tileCoverage()`
  ([patterns.ts](../src/geometry/patterns.ts)) multiplies the real tile count by
  the heaviest colour's points, refuses past `TILE_UNION_VERTEX_BUDGET` (500k),
  and reports `too-detailed` through the same refusal path the other four causes
  use. The user gets one tile and a message naming the numbers.

**Still open: a refusal is a cap, not a cure.** 500k gives up two measured
successes (zebra's 544,400 and dalmatian's 503,100). A volunteer who wants that
fill has no way to get it. A design that is over budget even with Scale wound to
its 400% maximum is refused outright, and the message says so rather than
sending the user up the slider.

Closing it means chunking the union into batches small enough to stay under the
ceiling and merging the results. That removes the ceiling for the bundled
patterns too, which would make the asset budget a performance concern rather
than a correctness one. Upgrading turf past 6.5 may move the ceiling but is
separately blocked — see the `@turf/turf` pin section.

**`TILES_PER_CHAIR_ZONE = 143` is still frozen by hand**, not derived from live
zone geometry: `tileCoverage()` needs a real placer and extent, which only exist
mid-build, and pulling the full chair build into an otherwise fast,
dependency-light asset test is not worth it. Its 300k budget is a 1.8x margin
under the measured onset. What changed is the consequence of letting it rot. A
zone that outgrows 143 tiles now reaches the runtime refusal instead of dropping
tiles, so a shipped pattern stops filling and says so. That is a visible
regression for the user rather than a hidden one, and still nothing flags the
stale constant to the maintainer.

## A concave part's prime-tower footprint is scored as its convex hull

`suggestTowerPos` ([src/export/threemf.ts](../src/export/threemf.ts)) measures
each part along `FOOTPRINT_AXIS`'s 16 directions and scores the tower corner
against the 32 supporting half-planes that result. That wraps a **convex** part
to 0.48%, which is what closed the round-hubcap item. A concave part is
over-reported by its whole concavity on top of that.

Shipped chair parts in their baked `plateR` poses. The four casters are the only
ones that reach `suggestTowerPos`: `chairPlacement.ts`'s generated header says
two plates have no `primeTowerDelta` and fall back to it, and reading the entries
shows those are plates 9 and 10, the caster plates. `chair-seat-center` is worse
and never reaches the search, so it is here as the ceiling rather than as a case
that bites.

| Part                     | True projection | Support polygon | Bounding box    |
| ------------------------ | --------------- | --------------- | --------------- |
| `chair-caster-std-left`  | 8372 mm²        | 14223 mm² 1.70x | 19422 mm² 2.32x |
| `chair-caster-std-right` | 8372 mm²        | 14223 mm² 1.70x | 19422 mm² 2.32x |
| `chair-caster-kit-left`  | 8372 mm²        | 14223 mm² 1.70x | 19422 mm² 2.32x |
| `chair-caster-kit-right` | 8372 mm²        | 14223 mm² 1.70x | 19422 mm² 2.32x |
| `chair-seat-center`      | 7868 mm²        | 15191 mm² 1.93x | 44810 mm² 5.70x |

**It costs nothing on any shipping part today.** Those two caster plates print
one filament, so no tower is placed there at all. The reachable case is a hubcap
**cut to its artwork shape**: a silhouette with a deep notch can be told its
corners are blocked when the notch leaves one open. Conservative in the right
direction — a tower parked through a part is worse than one the slicer places —
so this is a precision item, not a correctness one.

Closing it means a real 2D footprint rather than a support polygon: the
silhouette outline `hubcapOutline.ts` already builds, mapped through the part's
plate rotation, with a polygon-polygon overlap in place of the half-plane clip.
That only helps parts that carry an outline, which is the hubcap and nothing
else, so it is worth doing when a second concave part reaches the fallback.

Reproduce the table from the repo root:

```bash
node --input-type=module -e "
import { readMesh } from './scripts/lib/mesh.mjs';
const PARTS = [                                             // part, and its baked plateR
  ['chair-caster-std-left', [[0,0,-1],[0,1,0],[1,0,0]]],
  ['chair-caster-std-right', [[0,0,1],[0,-1,0],[1,0,0]]],
  ['chair-caster-kit-left', [[0,0,-1],[0,1,0],[1,0,0]]],
  ['chair-caster-kit-right', [[0,0,1],[0,-1,0],[1,0,0]]],
  ['chair-seat-center', [[0,0,-1],[0.707107,0.707107,0],[0.707107,-0.707107,0]]]];
const AX=[]; for (let k=0;k<8;k++) { const a=Math.PI*k/16; AX.push({x:Math.cos(a),y:Math.sin(a)}); }
for (let k=0;k<8;k++) AX.push({x:-AX[k].y,y:AX[k].x});      // FOOTPRINT_AXIS, verbatim
const clip=(P,d,l,s)=>{ const o=[]; for (let i=0;i<P.length;i++) { const A=P[i], B=P[(i+1)%P.length];
  const fa=s*(A.x*d.x+A.y*d.y-l), fb=s*(B.x*d.x+B.y*d.y-l); if (fa<=0) o.push(A);
  if ((fa<0&&fb>0)||(fa>0&&fb<0)) { const t=fa/(fa-fb); o.push({x:A.x+t*(B.x-A.x), y:A.y+t*(B.y-A.y)}); } } return o; };
for (const [id, R] of PARTS) {
  const v = await readMesh('public/stl/' + id + '.3mf'), p = [];
  for (let i = 0; i < v.length; i += 3)
    p.push([v[i]*R[0][0]+v[i+1]*R[1][0]+v[i+2]*R[2][0], v[i]*R[0][1]+v[i+1]*R[1][1]+v[i+2]*R[2][1]]);
  const x0=Math.min(...p.map(q=>q[0])), x1=Math.max(...p.map(q=>q[0]));
  const y0=Math.min(...p.map(q=>q[1])), y1=Math.max(...p.map(q=>q[1]));
  const N=1200, g=new Uint8Array(N*N);                      // true area: rasterise the projection
  for (let t=0; t<p.length; t+=3) { const [a,b,c]=[p[t],p[t+1],p[t+2]];
    const gi=(u,lo,hi)=>Math.round((u-lo)/(hi-lo)*N);
    for (let gy=Math.max(0,gi(Math.min(a[1],b[1],c[1]),y0,y1)-1); gy<=Math.min(N-1,gi(Math.max(a[1],b[1],c[1]),y0,y1)+1); gy++)
    for (let gx=Math.max(0,gi(Math.min(a[0],b[0],c[0]),x0,x1)-1); gx<=Math.min(N-1,gi(Math.max(a[0],b[0],c[0]),x0,x1)+1); gx++) {
      const X=x0+((gx+0.5)/N)*(x1-x0), Y=y0+((gy+0.5)/N)*(y1-y0);
      const d1=(X-b[0])*(a[1]-b[1])-(a[0]-b[0])*(Y-b[1]), d2=(X-c[0])*(b[1]-c[1])-(b[0]-c[0])*(Y-c[1]),
            d3=(X-a[0])*(c[1]-a[1])-(c[0]-a[0])*(Y-a[1]);
      if (!((d1<0||d2<0||d3<0)&&(d1>0||d2>0||d3>0))) g[gy*N+gx]=1; } }
  const mn=AX.map(()=>Infinity), mx=AX.map(()=>-Infinity);
  for (const q of p) AX.forEach((d,a)=>{ const t=q[0]*d.x+q[1]*d.y; mn[a]=Math.min(mn[a],t); mx[a]=Math.max(mx[a],t); });
  let P=[{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}];
  AX.forEach((d,a)=>{ P=clip(P,d,mx[a],1); P=clip(P,d,mn[a],-1); });
  let ar=0; for (let i=0,j=P.length-1;i<P.length;j=i++) ar+=P[j].x*P[i].y-P[i].x*P[j].y;
  const A0=g.reduce((s,q)=>s+q,0)*((x1-x0)/N)*((y1-y0)/N), A1=Math.abs(ar)/2, A2=(x1-x0)*(y1-y0);
  console.log(id, { true_mm2:+A0.toFixed(0), support_mm2:+A1.toFixed(0), bbox_mm2:+A2.toFixed(0),
    support_over:+(A1/A0).toFixed(2), bbox_over:+(A2/A0).toFixed(2) }); }
"
```

## The hubcap's plate is verified on two beds and up to one diameter

`HUBCAP_PLATE` ([src/export/threemf.ts](../src/export/threemf.ts)) carries
hand-verified arrangements for the 256×256 and 270×270 beds, both checked at
220mm. `hubcapPlacement` ([src/geometry/hubcap.ts](../src/geometry/hubcap.ts))
applies them only within that, and everything outside falls back to centring the
part with `suggestTowerPos` picking a corner — correct, and it says so, but it
is the outcome that needs a slicer pass every time.

What that leaves open, in the order it is likely to bite:

- **The H2D (350×320) has no verified plate at any size.** It is also the bed
  with the most room — a 220mm disc leaves a ~90mm corner, so the computed
  fallback is very likely fine. Nobody has confirmed it.
- **Nothing above 220mm is verified on any bed.** The control goes to the plate
  size, so a 250mm hubcap on a 270mm bed is reachable and unverified. On the
  256mm bed the verified clearance is only 7mm, so this is not a case where the
  existing numbers could be stretched a little.
- **A hubcap cut to its artwork's shape never gets the verified plate, at any
  size.** `hubcapPlacement` is withheld outright once "Cut to artwork shape"
  is on ([src/assembly/kinds.ts](../src/assembly/kinds.ts)), because
  `HUBCAP_PLATE` was checked against a round disc and a silhouette can reach
  further off-axis than a circle of the same longest-side reading. There is no
  obvious way to close this the way the two items above close — a verified
  arrangement would need to be re-checked per silhouette shape, which isn't a
  fixed set the way bed sizes are, so it likely stays computed-and-flagged
  rather than becoming baked.

Closing either is the same job and needs no code: export at the size and
printer in question (`scripts/export-hubcap-examples.mjs` produces the files),
position the part and the prime tower in the slicer, save, and add the numbers
as another `HUBCAP_PLATE` entry — plus raising `HUBCAP_VERIFIED_DIAMETER_MM` if
the new check is at a larger diameter. Read the provenance comment on
`HUBCAP_PLATE` first: the part position and the tower position are one claim,
because on both verified beds the disc had to move off centre to free a corner
at all, and transferring one without the other puts the tower through the part.

Worth knowing why this can't be solved once and for all the way the fixed parts
were: a generated part has no stable mesh to seal a pose against, so every
arrangement is only ever verified for the parameters it was checked at. More
entries narrow the gap; they don't close the category.

## Boundary fringe threads survive the trace

A hair-thin thread of a third color can hug a high-contrast boundary in a traced image
(mario's mustache top edge, a button accent): the anti-aliased band quantizes to its own
label, and it is as long as the boundary, so no area floor catches it. Prints under one
nozzle wide, so slicers drop it; a preview blemish, not a bad print.

Three width-rule formulations (absorb components under a mean-width threshold) were built
and cut on this branch after three consecutive review rounds each found real defects.
The full history is in
[2026-08-24](findings/2026-08-24-despeckle-floor-recalibration.md), defect 3.

Closing this again means clearing, at minimum:

- Placed photographs: quantized gradients are long 1-3px iso-color bands; a probe showed
  a width rule cascade-collapsing sixteen bands into one component. Photos need an exemption
  or a measurement.
- Sub-fringe line art: a drawing whose every stroke is under the threshold must not trace
  to nothing, and the "raise Detail" advice in the empty-trace error cannot be the remedy,
  since Detail does not scale a width rule.
- Perimeter bookkeeping through union-find merges: the despeckle adjacency maps only tally
  pairs with a speck side, so a union's internal big-big runs are not subtractable from a
  perimeter without a fuller tally. Two of the three attempts got this wrong.
- The no-op regime: mean width is never under 0.5 (a lone pixel is 2*1/4), so any threshold
  at or under 0.5 must skip the O(w*h) perimeter scan entirely.

## `noUncheckedIndexedAccess` is not enforced

Split out from the now-closed "Numeric coercion has no lint rule" section,
which decided the parsing-helper convention (`src/util/number.ts`) for that
half. This half is unrelated and still open.

Measured at **2727 errors** (`npx tsc --noEmit --noUncheckedIndexedAccess`)
on `main` @ 8db8c6d, up from 2240 @ 04c2c81. Enabling it is a real project,
not a flag flip.

## A caster-mount fetch that fails leaves the chair on the new variant with the mount missing

**Needs a decision: what a partly failed variant switch should leave.** `switchChairVariant`
([src/assembly/parts.ts](../src/assembly/parts.ts)) ignores `asmLoadLibraryEntryIntoPart`'s
result.

- It sets `variantId` and drops the old mounts before fetching the new ones.
- A failed fetch shows an alert naming the file. The variant stays switched, and that mount stays
  unloaded, so the chair renders and exports without it.
- Unmeasured: not driven live. Reached only if a caster file is unreachable mid-visit.
- Options: roll back to the previous variant and its mounts, the way a restore now rolls back its
  kind (`asmSwitchKindAndLoad`, [src/assembly/switchKind.ts](../src/assembly/switchKind.ts)); or
  keep the switch and warn in the panel until the mount loads.

## A regenerated source mesh would leave its rotated copies on the old geometry

`asmAddDuplicate` ([src/assembly/parts.ts](../src/assembly/parts.ts)) shares
`positions`, `vertices`, `indexed`, `patches` and `zones` with the source by
reference. `asmAdoptMesh` assigns _new_ arrays to those on the source, so a
re-adopted source would keep its copies pointing at the previous mesh.

**The mismatch is inconsistent, not merely stale.** `syncDuplicateFaces` pushes
`boundaryLoops` and `restPositions` derived from the source's _new_ mesh onto a
copy whose `positions` still reference the _old_ one, so the copy carries a face
outline that does not belong to its own geometry. Before that sync existed the
copy was at least self-consistent on the previous mesh.

**Unreachable today**, on two greps of `src/assembly/kinds.ts`:

- `grep -n "allowRotatedCopies: true"` → 1 hit, the `wheel-half` role.
- `grep -n "buildMesh:"` → 1 hit, the `hubcap` role, which sets
  `allowRotatedCopies: false`.

So the only role with copies never re-adopts a mesh. `asmAdoptMesh` re-runs on
an already-loaded part by three routes, and each is closed:

| Route                      | Why it can't hit a copy                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `asmRebuildGeneratedParts` | Needs `buildMesh`, which only the copy-less hubcap has                                                          |
| `asmLoadFullAssembly`      | Clears `state.assembly.parts` before loading anything                                                           |
| `switchChairVariant`       | Filters the variant roles' parts out first, copies with them; every chair role sets `allowRotatedCopies: false` |

Found while enumerating readers for the design-face fix, not measured against a
running app.

**Closing it** means either extending `syncDuplicateFaces` to the mesh fields
too, or rebuilding a source's copies when it re-adopts. It stays open because
the first role to pair `buildMesh` with `allowRotatedCopies` makes it real, and
nothing today can produce a case to test against.

## Nothing says whether a thin cut-region strip is surface a cover hides

`MIN_CUT_PIECE_MM2` (0.16mm², one nozzle square) is shipping three pieces that
clear it while looking exactly like the #296 hairline that motivated it:

| piece                                | width  | length | area     | x the floor |
| ------------------------------------ | ------ | ------ | -------- | ----------- |
| `seat-left/chair-wheel-mount-left#2` | 0.19mm | 30.4mm | 2.860mm² | 17.9x       |
| `right/chair-wheel-mount-right#5`    | 0.19mm | 32.5mm | 3.159mm² | 19.7x       |
| `left/chair-wheel-mount-left#4`      | 0.20mm | 32.5mm | 3.172mm² | 19.8x       |

Ten times wider and four times longer than the #296 hairline (0.020 x 8.08mm,
0.025mm²), and still the same shape: a thin ribbon riding a clip boundary.

**A width guard on top of the area floor is ruled out.** A morphological
opening swept over the 87 `cutRegions` pieces the sidecar ships — the survivors
of 142, the other 55 already dropped at `MIN_CUT_PIECE_MM2` — found no gap to
put a threshold in: the widest step among
the 46 sub-millimetre pieces is 1.445x, between two pieces of the same ribbon
shape, not a boundary between populations. Full sweep, method, and the two
retired worries — the 1.43mm slot (a hole, survives every width) and the
0.15mm seam overlaps (a different population, 0 of 41 in `cutRegions`) — are in
[docs/findings/2026-09-08-cut-region-width.md](findings/2026-09-08-cut-region-width.md).
Re-derive with `npx vite-node scripts/measure-cut-width.mjs`.

**What's still open** is a different question: is any of these strips hidden
surface the cover subtraction should have removed entirely, the way the #296
mark actually harmed the print? Nothing in the sidecar records which of the 87
pieces sit under a cover — that's a driven run (load the chair, place a cover
over each candidate zone, check visibility), not something the bake output can
answer on its own.

A second candidate, unmeasured: fix `subtractRegions`
(`scripts/lib/zonebake.mjs`) so it stops emitting a ribbon along a boundary
shared by two loops traced from the same triangles, rather than filtering the
ribbons out afterward. Worth sizing on its own measurement if someone wants it.

## Nobody has swept the design ink `CLIP_REMNANT_FLOOR_MM2` actually guards

`docs/findings/2026-09-08-cut-region-width.md` swept the bake's population, part
geometry, and found no width separating dust from surface. That says nothing
about the runtime floor, which sees something else entirely: a placed design's
ink clipped to a part (`placedInk` and `dropSpecks`, `src/geometry/assembly.ts`).
Those pieces have never been measured.

The floor stays an area there deliberately, and that part is not open:

- A width test on ink would delete a deliberate 0.3mm stroke in someone's
  artwork. That is a real choice, honoured the way a sub-layer depth is
  (`MIN_CUT_DEPTH_MM`, docs/audience.md).
- The #296 hairline was removed at the bake, not here, so the one worked example
  never reached this floor.

What is open is that the claim rests on the argument, not on a measurement. What
would close it: sweep clipped ink across the shipped example designs and say how
narrow real artwork gets. If the narrowest deliberate stroke turns out to be far
above the floor, the argument gains a number. If artwork routinely runs at 0.2mm,
the speck notice is firing on content people meant, which is a different bug.
