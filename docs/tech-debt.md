# Tech debt

**Open** deferred work and known-wrong behavior. One section per item: what was measured, why it was
deferred, what closing it takes. Update the section instead of re-deriving its number.

- When an item is fixed, delete its section. Rules for deleting, and for what must move out first, are in
  [docs/CLAUDE.md](CLAUDE.md#docstech-debtmd).
- A section is a work item, not an archive. A measurement or lost approach belongs in a comment next to
  the code it constrains, or in [docs/pipeline.md](pipeline.md). What stays here is closeable: it names
  code work under a “Closing it” line.

## The covers reference has no tires, so each flank keeps artwork the tire hides — unmeasured

`stubs/dead-zones.3mf` carries the printed wheel only: two halves plus the cap. The bake replaces those
halves with a solid 280mm disc of the same diameter. The assembled chair runs a tire ring outside that,
which the bake has never seen, so the flanks treat the band under the tire as printable.

All three rows come from `npx vite-node scripts/measure-wheel-shadow.mjs --tire-mm 30`, re-taken
2026-08-31 against the rebaked sidecar. The script's header defines each projection. The shadow and
tire-ring rows are geometry, independent of the bake algorithm. The baked row is the flank's whole dead
area summed out of `public/stl/chair-body-zones.json`.

|                                               | `left`    | `right`   |
| --------------------------------------------- | --------- | --------- |
| straight-on wheel shadow on the zone          | 36,737mm² | 36,894mm² |
| baked dead there (the rest is the 20mm bleed) | 23,486mm² | 23,777mm² |
| what a 30mm tire ring would add               | 18,619mm² | 18,441mm² |

- **The tire row is unmeasured, and only its arithmetic is reproducible.** 30mm is scaled off a photo
  (hub ~340px for a stub-measured 280mm, band ~37px), and the script grows the ring radially about each
  cover's own axle, not modelled. Read it as "about as much again as the stub covers", never as a
  number to build on. The two rows above it are measured.
- Superseded figures (36,619 / 36,730 shadow, 22,447 / 23,215 ring) named no command. The shadow
  reproduces to 0.2%; the ring does not.
- The rows moved when the four hollow half-dishes became two solid discs and the bleed moved after the
  smoothing. The shadow barely moved. The baked row rose because the wheel now hides across the
  mount/fender seam instead of stopping dead at it.
- The direction is safe: surface under the tire is treated as printable, which costs a filament change
  on plastic nobody sees. It never leaves blank plastic where artwork was expected.
- **Closing it** is one number. The wheel reaches the bake as a declared solid (`covers.solids` in
  `scripts/zone-configs/chair-body.json`), so raise `radiusMm` from 140 to the tire's real outer radius
  and rebake. It needs a measured radius: the disc is posed from the file and its diameter checked
  against the bodies it replaces, so a guessed number fails the bake.
- The owner has seen the trade and chose to leave tires out for now.

## The chair's prime-tower positions have only been verified on one bed size

**Any third bed size inherits the 270mm numbers untested.** Both shipped sizes have had the pass (270mm
Snapmaker, 256mm A1). The 350x320 `bambu-h2d` entry in
[src/export/printers.ts](../src/export/printers.ts) is the one that exists today, and the first
non-square bed of the three.

- All export placement (plate assignment, rotation, position, the per-part brim/support/infill
  overrides, the tower) is baked by
  [scripts/bake-chair-placement.mjs](../scripts/bake-chair-placement.mjs) into
  [src/export/chairPlacement.ts](../src/export/chairPlacement.ts) from two human-checked files:
  - MakeGood's 12-plate Bambu Studio project for the poses. The script re-verifies every shipped mesh
    against it before writing, worst plate-space disagreement 0.024 mm.
  - A four-filament export with every tower dragged into place. It had to exist separately: the first
    prints in one or two filaments and never had a real tower.
- Deltas are stored relative to each plate's anchor part, so they follow the part when a bed re-centers
  the group. Seven of the ten transferred between the two beds unchanged, which is the evidence the
  relative model works. The two wheel-mount plates (1.8mm and 3.9mm) and one handle plate (1.2mm) did
  not, and carry a `primeTowerDeltaByPlate` entry for 256x256.
- Adding a bed means another pass: `scripts/export-chair-examples.mjs` builds the files, and the bake
  takes one `--towers` file per bed and works out which plates disagree.
- The caster plates stay on `suggestTowerPos` in [src/export/threemf.ts](../src/export/threemf.ts),
  which is correct: they print one filament and get no tower.

## A depth on a flat face the Y axis can't measure has no upper bound

A pocket deeper than the wall under it cuts a hole through it and exports with no depth warning.

- A flat face declines both depth bounds when its normal is not near Y or its plane lands off the mesh.
  In `scripts/measure-wall.ts`'s table: the wheel's ranks 3-5, the footrest's 2-5.
- No shipped default face is one of them. The part panel offers them as alternatives.
- Such a face already gets the "isn't vertical" warning: its cutter extrudes down Y, not along the
  face's normal, so the cut itself is wrong there, depth or not.

**Closing it** means cutting a sideways face along its own normal first. Its wall can then be measured
the way the flat or the conformal mapper does it.

## A chair wall clamp leaves 0.05mm, but the warped cutter's floor is only exact at its vertices

**Unmeasured.** The bound is the wall sampled along -N̂, less `CUT_FLOOR_MM` (0.05mm). The warped
cutter's floor is flat between vertices `WARP_REFINE_MM` (1.5mm) apart, so over convex curvature it
dips below the curved floor between them.

- Sag is L²/8r: 0.03mm at L = 1.5mm on a 10mm radius, under the floor. `FILL_REFINE_MM` (3mm) gives
  0.11mm, but the chair withholds Fill.

**Closing it** means measuring breakthrough per chart at its clamped depth, then widening the floor
by the sag where it is needed.

## A depth warning can name a cut that then failed

`thinWallClamps` and `tooDeepClamps` are staged in `buildColorPrism`
([src/geometry/colorPrism.ts](../src/geometry/colorPrism.ts)) before the cutter is built. If no
cutter comes out, the colour also gets "Couldn't cut color … into …", while the depth warning still
says "It was cut at … mm instead".

- Old on flat faces. The chair body is new to it, where a warp that stays non-manifold at both
  refinements (`ConformalZoneMapper.buildCutter`) leaves no cutter.

**Closing it** means staging the clamp only for a region whose cutter was kept.

## Cutting the chair's left fender adds handles to it at the default depth

A design over the whole left side, cut 1mm deep, raises chair-wing-left's genus from 0 to 4 and leaves
4 zero-volume pieces beside it. A recess should change neither. The other three left parts keep their
genus. Run `node_modules/.bin/vite-node scripts/measure-cut-genus.ts [zone] [depthMm]`:

| Depth | chair-wing-left genus | zero-volume pieces |
| ----- | --------------------- | ------------------ |
| 1mm   | 0 -> 4                | 4                  |
| 3mm   | 0 -> 5                | 5                  |

- Still one solid over 1mm³ at both depths, so no piece is cut off.
- Whether the handles print as anything is **unmeasured**: they could be slivers on the surface or
  real tunnels. The other zones are unmeasured too.
- Probably not the depth: at the 3.35mm wall clamp this part's cutter had as much volume outside
  the part as at 1mm. That came from a throwaway script and can't be reproduced.

**Closing it** means finding where the handles sit (`decompose` the cut body, then compare the cutter
with the part around them) and deciding whether the warp or the boolean makes them.

## Rebuild performance needs ongoing work — this is a heavy application

The flat-mode half closed 2026-08-23. `computeNetRegionsByColor` now calls the clipping engine n-ary
(`COVERED_BATCH`, [src/geometry/regions.ts](../src/geometry/regions.ts)): **1.76x faster on the 135-path
SVG**, 1.5-2.9x across the corpus, per-color areas unchanged (0.000% worst relative drift). See
[docs/findings/2026-08-23-boolean-pass-and-weld.md](findings/2026-08-23-boolean-pass-and-weld.md).

- **The ~9s figure this section used to quote was wrong, by 4.5x.** In Chrome against the real module
  the pass on that SVG took **2066ms** before and 1177ms after. A whole flat rebuild of that file is
  ~5s, so the pass was never the majority.
- **Settled leads.** Turf's wrappers cost nothing: `turf.union` is a pass-through, and a pairwise loop
  calling the engine directly lands within 3% of one calling Turf on every corpus file. The win came
  from n-ary sweeps. `cleanFeature` re-scrubbing costs nothing: skipping it measured 1.02-1.06x, 5-7% of
  the pass, with 93-95% inside the engine.
- **Worker landed**: the build runs off the page's thread. Compute is unchanged
  (`npm run build && MOSAIC_GPU=1 node scripts/bench-zone-rebuild.mjs`: 48.6s on 5c7f898 vs
  48.4s, summed medians of its 20 rows). On a chair rebuild the longest
  main-thread stall while computing went from 720-784ms to 26-41ms, and Cancel from 410-532ms to
  16-27ms (`npm run build && MOSAIC_GPU=1 node scripts/check-rebuild-worker.mjs`, checks (a) and (b);
  "before" is 5c7f898).
- **What the 1.2s floor of a one-zone edit is spent on is unmeasured.** Nine designs on the chair,
  the Right-fender one rescaled, takes 1.2-1.3s with the part cache (4.0-4.1s on 230a5a7;
  `npm run build && MOSAIC_GPU=1 node scripts/bench-zone-rebuild.mjs`). Candidates: the region
  pass, whose memo holds one design (`regionsCacheKey`), so nine designs recompute every build;
  the ~0.7s draw stall below; the one part cut.
- **Measured dead end**: bbox pre-filtered per-shape diffs, ~2x SLOWER than the accumulator on real
  artwork (full-canvas backgrounds overlap everything). See the comment on `computeNetRegionsByColor`.
- **Do not "improve" `COVERED_BATCH` by raising it.** Never folding the accumulator is fastest on a
  140-shape file and **10x slower than the old loop at 400 shapes**, because every difference then
  carries every shape above it. 8 sits on a flat plateau over 50/100/200/400 shapes
  (`scripts/bench-regions.ts scaling`).

**Chair-body Fill is an order of magnitude worse.** `MOSAIC_GPU=1` production build, 2026-08-02: the
`tests/fixtures/patterns/zebra.svg` in Fill on the chair's Left side alone (one of five zones) took
**405.6s** to settle, non-linear (41% at t+15s, 43% at t+60s, 52% at t+180s). "All zones" (the
conformal-recut cost the zone-binding-default comment in `state/artwork.ts` warns about) did not finish
inside a 900s timeout.

- This is the conformal-wrap + per-part CSG path, not the flat boolean pass. Per-part cut solids and
  cross-part zone triangulation both scale with triangle count, and the chair's zones carry hundreds of
  thousands of triangles (recorded next to the sidecar writer in
  [scripts/bake-zones.mjs](../scripts/bake-zones.mjs)).- **Partly superseded, 2026-08-03.** That zebra asset carried 13.6k vertices per tile, mostly
  marching-squares oversampling (see
  [2026-08-30 tile-union ceiling](findings/2026-08-30-tile-union-ceiling.md)). With the thinned asset
  the single-zone case measures **93.6s**, against **468.7s** re-measured on the old one. It does
  _more_ work, 2.07M triangles against 853k, because the old asset's tile union was failing and falling
  back to unmerged shapes. 93.6s is still not interactive, so the path wants the accumulator fix, or a
  decision that the wait is acceptable now it neither freezes the page nor resists Cancel. Re-measure before quoting 405.6s as the pipeline's cost. The "All zones" >900s result has not
  been re-measured.
- **Withheld from users, 2026-08-05.** The chair-body kind carries `withholdFill` (`src/types.ts`), so
  Fill is not offered on it and no user can reach these numbers. The kind itself
  is in the Part dropdown. This is a gate, not a fix: the path is unchanged. Clearing the flag needs the
  accumulator fix, or a decision that a 93.6s wait is acceptable now it runs in the worker. Sticker on the chair is unaffected, measured at 19.5s for a full five-zone
  rebuild on the same box, which is why only Fill was withheld.
- **Don't quote that 19.5s without the design size.** It used a design covering the zones.
  [docs/findings/2026-08-08-zone-rebuild-cost.md](findings/2026-08-08-zone-rebuild-cost.md) reproduces it at 400% (17.0s) and
  measures an ordinary auto-fit sticker on all five zones at 4.0s, a 5x spread on the same path. What
  is paid for is pocket area, not surfaces touched.
- **A Fill now cuts itself back from under every sticker on its zone**: one polygon difference per fill
  color per part. On the wheel it measures 0.3-0.6s of the build with a three-band sticker and 0.9-1.1s
  with `snoopy.svg` (`node_modules/.bin/vite-node scripts/bench-fill-yield.ts [sticker.svg]`, the
  `yield ms` column). **Unmeasured on the chair**, where Fill is withheld. Expect it to grow with the
  fill's points per part: the Left zone's `uvBounds` are 642x509mm (`public/stl/chair-body-zones.json`)
  against the wheel's 276mm design circle, over four parts. Estimate: a few seconds on the 93.6s
  single-zone figure. Measure it before clearing `withholdFill`.

## Many disjoint shapes of one SVG make the flat pass superlinear

Unmeasured on real artwork; measured on a synthetic spotted design. One colour of N non-overlapping
blobs over a background, one run each
(`MOSAIC_BENCH_REPEATS=1 node_modules/.bin/vite-node scripts/bench-regions.ts merge dots:400 dots:800 overlap:800`):

| Fixture     | Whole pass | Longest difference | Longest fold | Merge call |
| ----------- | ---------- | ------------------ | ------------ | ---------- |
| dots:400    | 15.9s      | 119ms              | 114ms        | 132ms      |
| dots:800    | 91.7s      | 434ms              | 281ms        | 371ms      |
| overlap:800 | 1.9s       | 15ms               | 16ms         | 30ms       |

One run per row, so read ±20%: `chunks dots:800` (median of 5) puts the same merge call at 345ms.

- Twice the blobs cost 5.8x the time. Disjoint blobs never collapse the accumulator, so every
  difference and fold carries every blob above it.
- `COVERED_BATCH` bounds how many shapes one call takes, not how many vertices. No single call reaches
  0.5s; the pass is long, not frozen.
- An image-traced SVG or a spotted pattern is the input that would do this. A PNG or JPG cannot: the
  tracer hands over one shape per colour.
- No corpus file comes close. Its largest per-colour list is 37 pieces (`bench-regions.ts merge` over
  the corpus files).
- Chunking the per-colour merge was measured and does not help (the numbers are on that merge in
  `computeNetRegionsByColor`).

**Why deferred**: no real file has shown it yet.

**Closing it**:

1. Measure a real image-traced SVG from Illustrator or Inkscape first.
2. Stop differencing against blobs that cannot overlap. A bbox pre-filter was recorded ~2x slower on
   real artwork (full-canvas backgrounds overlap everything; no command was kept, so re-measure before
   relying on it). It needs a spatial index on the accumulator, or the disjoint fast path the
   `computeNetRegionsByColor` docstring describes.
3. Keep the corpus at or under its current time (`bench-regions.ts attribute`).

## A cancel still waits for the one Manifold call already running

The per-part body has a `finally` over every solid it allocates and checks at each boundary between its
atomic Manifold calls, so a press during the cut aborts the part instead of waiting it out.

- **Measured** on a 6000-region wheel, 3 colors, WSL2 + `MOSAIC_GPU=1`, 2026-08-28:
  `npm run build && MOSAIC_GPU=1 node scripts/check-cancel-latency.mjs 6000 6`. Cancel took
  **0.04-0.06s** after the first and **0.07-0.29s** for the first of a session, over five runs. WASM heap
  stayed at 16.8 MB. The region pass before the cut moved most: 156.6s, 160.9s, 215.2s.
- **The heap figure is falsified.** With the `finally` emptied, the same command grows the heap 16.8 to
  34.9 MB over six cancels (+18.2 MB by the script's own byte counts). It reads the instance's
  `WebAssembly.Memory`, not `usedJSHeapSize`, which does not count a leaked solid.
- **Why the first cancel is slower is not established.** It is the only one arriving straight off the
  region pass. Nothing separates a cold allocator from a longer first boolean.
- **Each latency carries about a frame**: the click and the curtain-down reading both come from rAF, so
  figures are quantised to ~16ms. The 0.29s outlier is eighteen frames and is not that.
- The click is armed inside the page and fires when the curtain's readout crosses 42%. Driving it from
  node missed the window. Every round asserts Export came back disabled, which separates an aborted cut
  from one that happened to finish.
- The region pass's own cancel (0.3s, and why a click at t+10s lands in it) is in
  [2026-08-25 cancel latency](findings/2026-08-25-cancel-latency.md).

What is left is the floor: the checks sit between colours and between booleans, so the wait is whatever
the step already running takes. That is one union, difference or intersection, or one colour's
extrusions plus the repair ladder behind them.

- **Unmeasured.** Only the wheel was driven, and its cut is short next to its region pass. The case that
  would show the floor is the chair in Fill, whose cut is heavy (93.6s for one zone, recorded on
  `showOverlay` in [src/ui/overlay.ts](../src/ui/overlay.ts)).
- **Closing it** needs the engine to yield mid-boolean, which Manifold does not offer. Measuring first
  is the cheap half, and needs `scripts/check-cancel-latency.mjs` extended: it hardcodes a wheel fixture
  of rects and takes only a region count and a repeat count, so a chair run means teaching it a kind and
  a Fill mode.

## A zone template's outline is faceted, because nothing curve-fits a zone boundary

What remains of the 2026-08-05 "templates have odd/wrong edges" report after the clip-region folds were
removed. Cosmetic, and not a reason to withhold anything.

A zone boundary is traced along mesh triangle edges, emitted vertex for vertex, simplified by
`simplifyLoop` at `SIMPLIFY_TOL_MM` and written as `L` commands, so an outline is as faceted as the
tessellation under it. Measured across all eight chair templates: **zero curve commands**, in every one.

- Not wrong, just angular. The outline is the surface, to within 0.2mm.
- `src/raster/curve.ts` already curve-fits, but for the raster tracer's pixel-derived paths. Fitting a
  mesh-derived boundary is a different, unmeasured problem: nobody has established how much smoothing a
  57.9 x 140.1mm opening's corners tolerate before the template stops matching the cut.
- Closing it means measuring that first. Until then any tolerance would be invented to satisfy the
  complaint.
- Applies to every part that ships zones, not only the chair.

## The flat and photo edge-density endpoints are unmeasured, and small photos read flat

**Open**: `FLAT_EDGE_DENSITY` (0.12) and `PHOTO_EDGE_DENSITY` (0.45) in `src/raster/stats.ts` have
never been measured. Only their midpoint, the 0.285 cutoff, has; its numbers sit on the constant.

- **Measured**: [2026-08-19 photo cluster](findings/2026-08-19-raster-photo-cluster.md), which
  supersedes result 1 of
  [2026-08-19 raster corpus calibration](findings/2026-08-19-raster-corpus-calibration.md). Its
  flat-art readings predate measuring at a fixed size: `mario` then read 0.2532, now 0.2042.
- Real flat art reaches 0.2042 (`mario`), 1.7x the flat endpoint. Mild evidence against it.
- Six of the seven photographs are CC-licensed Commons files. They show the statistic _can_ score a
  busy photograph high. They are not a sample of volunteer uploads.
- Moving an endpoint moves blur, despeckle and curve fit for every image between the two. Judging that
  needs traced output looked at, not readings.

### Under 384px no cutoff separates the corpus

Every image is measured with its opaque artwork enlarged to 512px by repeating pixels
(`measureAtReferenceSize` in `src/raster/decode.ts`). Small flat art no longer reads photographic. Small
photographs now read flatter instead.

App readings for each file exported small, from
`vite-node scripts/bench-raster.ts sizes pattern-zebra mario red-sox-logo cartoon photo stock-gravel stock-foliage stock-brick stock-crowd stock-night stock-bokeh-food`:

| Exported at | Flat art, highest  | Stock photos, lowest | Stock photos reading flat         |
| ----------- | ------------------ | -------------------- | --------------------------------- |
| 128         | 0.252 zebra        | 0.160 foliage        | 4 of 6: foliage crowd night bokeh |
| 192         | 0.296 zebra, photo | 0.220 foliage        | 3 of 6: foliage night bokeh       |
| 256         | 0.254 zebra        | 0.247 bokeh          | 2 of 6: foliage bokeh             |
| 384         | 0.245 zebra        | 0.275 bokeh          | 1 of 6: bokeh                     |
| 512         | 0.204 mario        | 0.290 bokeh          | none                              |

- Flat art is `pattern-zebra`, `mario`, `red-sox-logo` and `cartoon`. The balloon `photo` reads flat at
  every size, as it does at full size.
- `pattern-zebra` at 192 is downscaled from a 1024px render and still reads photo. Rendered straight at
  192 it reads 0.2637, flat (`vite-node scripts/bench-raster.ts render`).
- Measured at their own sizes, every stock photo reads photo at every size. So do all four flat sources
  at 192 and below, zebra and mario at 256, and mario at 384.
- A small photo reading flatter gets less blur and a lower despeckle floor, so it traces busier.
- A cutoff near 0.26 would separate the table's 384 and 512 rows. It was not moved: at full size it cuts
  the margin over flat art from 0.081 to 0.056, and there the cutoff decides working resolution. The
  photo set is not a volunteer sample either.

**Closing it**: a statistic that separates at small sizes, or a photo corpus showing volunteers never
upload small photographs.

## Colors is the one trace control still fixed, and no single value suits real artwork

**Rejected, measured**: a knee in the region-count curve picks the right Colors on at most 2 of 6
sources at any working size ([2026-08-20 knee detector](findings/2026-08-20-knee-detector.md)). This
supersedes the "6 of 8" reading in
[2026-08-19 raster corpus calibration](findings/2026-08-19-raster-corpus-calibration.md).
**The problem below is unchanged and unfixed.**

Working resolution, blur and despeckle are all chosen from the image. The default palette size is a
constant, and measured across the sample corpus (`stubs/raster test/`, 2026-08-04) no constant works.
Asking for more colours than an image has does not return fewer, as it does on synthetic flat art: real
files are lossy and anti-aliased, so the quantizer always finds more tones and spends the surplus on the
fringe around every edge.

Measured on the 300x300 Boston Red Sox logo, which has three real colours:

| Colors | Regions | Slots | Result                                            |
| ------ | ------- | ----- | ------------------------------------------------- |
| 3      | 37      | 4     | clean                                             |
| 4      | 56      | 5     | clean                                             |
| 6      | 364     | 7     | pale halo rings around the ring, letters and sock |
| 8      | 712     | 9     | worse                                             |

- The same default is right for a five-colour cartoon (Tweety traces cleanly at 6) and too low for a
  nine-colour one (Mario loses its yellow buttons at 6, and recovering them at 8 costs the blue iris to
  a desaturated entry).
- The harm is asymmetric: too few colours reads as a simplification, too many reads as a defect. Halos
  look broken, cost filament slots, and multiply region count tenfold.
- Region count is not a usable signal for choosing it automatically (see the rejection above): the
  curve is unstable across working size, and the full ladder costs seconds rather than the tens of
  milliseconds a quantize pass suggested.

**Closing it** needs a different signal, measured. Distinct colours surviving a coarse quantize, or the
ΔE spread of the palette, are both single-pass and neither has been looked at. Whatever the candidate,
it has to be checked on photographs, where region growth is smoothest and any signal weakest, and the
traces have to be **judged by eye**: region count cannot tell a cleaner trace from a coarser one.

## The trace parameters are calibrated against a downscale that is no longer constant

**Measured**: [2026-08-19 raster corpus calibration](findings/2026-08-19-raster-corpus-calibration.md)
quantifies the cost; [2026-08-20 blur vs downscale](findings/2026-08-20-blur-vs-downscale.md) is an
invalid test of the fix this section proposes. Read the second before designing another.

- `decode.ts` has always noted that the downscale to the working size "doubles as the first noise
  filter", and the blur/despeckle endpoints in [stats.ts](../src/raster/stats.ts) were tuned with that
  filter in place. It did more than the note implies: a 1588px source averaged 3:1 down to 512px loses
  the anti-aliased fringe on every colour boundary outright.
- Making the working size adaptive broke that assumption. Flat art now averages about 1.5:1, the fringe
  survives, and those pixels sit between two palette entries and get assigned alternately (a cartoon's
  eye came back striped blue and white).
- Compensation so far: flat art carries a one-pixel blur, and quantization was split so the palette is
  discovered from the source while only assignment reads the blurred copy. Otherwise a blend tone that
  exists nowhere in the file wins an entry and costs a filament slot. `tests/raster-quantize.test.ts`
  pins both halves.
- **Unresolved**: the compensation is a constant, not a function of how much downscaling happened. A
  small source that is never downscaled gets the same one-pixel blur as a 1588px one that was halved,
  and neither is the case the endpoints were tuned for.
- **Not in doubt**, from the earlier corpus run: the constant is wrong for some artwork. It quadruples
  region count on `cartoon` at the size the app ships it, and across five vector sources at a fixed
  working size it helps exactly one and hurts or no-ops the rest.
- **The one attempt to test it was invalid.** The blur-vs-downscale run re-rendered vector patterns at
  several sizes to see whether the benefit tracks the ratio. The working size is always 1024 and a
  vector baked large then filtered down gives essentially the same raster as one baked small, so the
  anti-aliased fringe is never created. Four of the five sources' control arms do not change across the
  ladder, and the fifth moves with its own base-blur flip rather than with the ratio.
- A valid test needs genuinely different raster pixels per rung: one large flat-art image resampled the
  way a user's exports would be. `bench-raster.ts blur` is the harness.

**Closing it** means deciding what the compensation should be a function of. The ratio is the untested
candidate, not a rejected one. The test needs raster inputs resampled to several sizes on disk, since no
mode here produces them, and the traces need looking at rather than counting: region count cannot tell a
cleaner trace from a coarser one.

## "Raise Detail" on a dropped-color notice can lead nowhere

`rasterColorLossMessage` ([src/raster/parse.ts](../src/raster/parse.ts)) fires wherever raising Detail
lowers the floor at all. Lowering the floor is not getting the color back, and two cases show the gap.

| Case                | What raising Detail does                                         | Measured                            |
| ------------------- | ---------------------------------------------------------------- | ----------------------------------- |
| Raise trips the cap | Next trace is capped and says lower Detail; color still gone     | synthetic only; corpus 0/190, 0/138 |
| Floor partly pinned | Nozzle floor just under the fractional one; floor moves a little | **unmeasured**                      |

- **Cap round trip**, on a synthetic fixture at Colors 5
  (`npx vitest run tests/raster-parse.test.ts -t "leaves a capped"`). Detail 80 is uncapped at floor 41
  with 1 color dropped, so it says raise Detail. Detail 90 and 100 are capped at floor 33, still 1
  dropped, and the capped notice says lower Detail. No Detail setting brings the color back.
- **Corpus**: no source caps with a color dropped. 19 sources x 5 placements x Detail 50/100 is 190
  rows; 2 are capped (red-sox-logo, wheel and footrest at Detail 100), both with 0 dropped
  (`node_modules/.bin/vite-node scripts/bench-raster.ts dropped`, needs the gitignored `stubs/`).
- **Partly pinned**: the notice stays true, since it says what Detail does, never that the color returns.
  A "how much movement is enough" cutoff would be an invented constant.
- **Next step caps**: 0 of 138. Of 475 corpus rows at Detail 0/20/40/60/80, 138 say raise Detail, and
  none is capped with a color still dropped 20 points up (the slider steps by 5)
  (`node_modules/.bin/vite-node scripts/bench-raster.ts dropped-next`, needs the gitignored `stubs/`).
- **Cost of the notice that knows**: it needs a trace at the higher Detail on every dropped-color
  announce. 613 traces averaged 363 ms each, so about 0.36 s per slider settle
  (same command; one machine, WSL2).
- **Closing it** takes a measured rule for when a lower floor brings a color back. Until a source
  shows the capped round trip, the notice that knows the next step caps is cost with no measured benefit.

## A hubcap cut to its artwork may re-trace on every edit — unmeasured

A resize re-traces a raster once its placed floors move (`retraceMovedSources` in
[src/state/artwork.ts](../src/state/artwork.ts)). On a hubcap cut to its artwork, the part's size
follows the trace: when the outline overhangs the wheel, the shrink that fits it (`generatedFitFactor`)
comes from the traced outline's reach.

- A re-trace that removes or restores a speck at the outline's far edge changes that shrink, and with it
  the floors. The trace is then stale again.
- **Bounded**: a settled pass never asks for another, so this costs at most one re-trace per edit, not a
  loop.
- **Unmeasured**: whether any real image has a speck at its edge between the two floors. No test or
  bench builds one.
- **Closing it** needs that measurement first. If it happens, the fix is a fit that does not read the
  trace's own specks, not a cap on re-traces.

## A `deChecker` break can still leave a piece under the despeckle floor — no grid known

`breakChecker` in [src/raster/trace.ts](../src/raster/trace.ts) rewrites a 2x2 checkerboard's bottom-left
cell when the bottom-right one strands a piece under the floor that no label can take. Two cases can
still leave a piece there:

- **Both bottom cells strand one.** The bottom-left rewrite stands, and its piece stays.
- **A later break moves the labels around a piece judged takeable.** Takeable is decided when its
  checkerboard breaks, not when the checker-free despeckle after the scan runs.
- **No grid known**: no test grid reaches either, and 0 of 24 `cap` rows and 0 of 38 corpus rows leave
  anything under the floor. Reproduce with `node_modules/.bin/vite-node scripts/bench-raster.ts cap` and
  `... despeckle`.
- **Closing it** needs such a grid first.

## Keep `@turf/turf` pinned to 6.5.0 — v7 is a measured perf regression here

A 7.3.5 upgrade was fully implemented and benchmarked (2026-07): correct output, but its new
polygon-clipping engine ran **5–10x slower** on this app's union-accumulation hot path (40ms → 215ms at
20 shapes, 76ms → 726ms at 120), turning slow rebuilds into multi-minute ones. Don't re-attempt without
benchmarking that path first.

- The 6.5 quirks remain: the boolean-failure workarounds in
  [src/geometry/regions.ts](../src/geometry/regions.ts) (degenerate-ring scrubbing, precision-truncation
  retries) target 6.5's exact polygon-clipping bugs.
- 6.5's package typings don't resolve under modern TypeScript, hence the shim in
  [src/turf.d.ts](../src/turf.d.ts).
- **Nothing re-measures this on demand.** The 5–10x figure came from a one-off harness that was not
  kept, so the pin is enforced by prose and an exact `package.json` version.
- A standing `bench-geometry` script is deliberately not built: only an active turf upgrade would run
  it, and writing it now costs about what re-deriving it later does. When an upgrade is live work, it is
  step one: the union-accumulation path at a few shape counts, with the numbers above as the baseline.

## `FILL_POINT_BUDGET` was measured on one part shape

The 600k fill budget ([patterns.ts](../src/geometry/patterns.ts)) guards Manifold's WASM heap, and was
set from one 240mm box face.

- Zebra filled at 658,724 points and ran out of memory at 719,969
  ([2026-09-24 tile-union cap](findings/2026-09-24-tile-union-cap.md)).
- Memory follows the part's own mesh and the cutter's triangles, not only the points counted. A denser
  part, or a conformal zone's refined cutter, may run out sooner. **Unmeasured.**
- Past the limit the part exports with no artwork, behind a named warning.
- Closing it: `scripts/bench-fill-build.ts` against a real part mesh (the hubcap, and a chair zone once
  Fill is offered there), or a budget on triangles rather than points.

## The segment cap is enforced at one boolean entry point, not all of them

`boolOpUnderCap` ([regions.ts](../src/geometry/regions.ts)) splits a union, clip or subtraction past
polygon-clipping's 500,000-segment cap. The fill path goes through it; these do not, or not fully. All
**unmeasured**.

- **The n-ary sweeps** (`safeUnionAll`, `safeUnionAllCooperative`, `naryOpWithRetry`). Reachable from
  `computeNetRegionsByColor` on one colour past 500k segments. The sweep throws at once (no retries on a
  size limit), then the pairwise fallback goes through the cap. Closing it: count first and skip the
  doomed sweep.
- **`splitAtBoundary`** ([edgeRegions.ts](../src/geometry/edgeRegions.ts)) calls `boolOpWithRetry` per
  polygon. Only one polygon plus the eroded boundary past the cap reaches it; it degrades to a recess
  with a warning. Closing it: route it through `boolOpUnderCap`.
- **The clip side is never split.** A clip over the cap alone is `tooBig`. Part boundaries are far
  smaller; a sticker set on one zone is the likeliest to grow.
- **`SPLIT_CALL_LIMIT` (256)** bounds a split union that halves without converging. Nothing measured how
  close a real fill comes to it.
- **The crossing limit.** The engine also throws once its sweep line holds 1,000,000 pieces, which
  crossings multiply: 500 strips each way reach it from 4,000 segments
  (`tests/regions-sweep-cap.test.ts`). Nothing counts it ahead of time. The tile union catches it as
  `tooBig` and refuses the fill; a clip that hits it later leaves the region unclipped behind a warning.
- **Fill holds every colour's tiles at once** before cutting any, so a refusal can drop them together.
  Peak JS memory is then the sum over colours, not the largest. Unmeasured:
  `scripts/bench-fill-build.ts` reports time, not heap.

## A concave part's prime-tower footprint is scored as its convex hull

`suggestTowerPos` ([src/export/threemf.ts](../src/export/threemf.ts)) measures each part along
`FOOTPRINT_AXIS`'s 16 directions and scores the tower corner against the 32 supporting half-planes that
result. That wraps a **convex** part to 0.48%, which is what closed the round-hubcap item. A concave part
is over-reported by its whole concavity on top of that.

Shipped chair parts in their baked `plateR` poses. The four casters are the only ones that reach
`suggestTowerPos`: `chairPlacement.ts`'s generated header says two plates have no `primeTowerDelta` and
fall back to it, and the entries show those are plates 9 and 10, the caster plates. `chair-seat-center`
is worse and never reaches the search, so it is here as the ceiling, not as a case that bites.

| Part                     | True projection | Support polygon | Bounding box    |
| ------------------------ | --------------- | --------------- | --------------- |
| `chair-caster-std-left`  | 8372 mm²        | 14223 mm² 1.70x | 19422 mm² 2.32x |
| `chair-caster-std-right` | 8372 mm²        | 14223 mm² 1.70x | 19422 mm² 2.32x |
| `chair-caster-kit-left`  | 8372 mm²        | 14223 mm² 1.70x | 19422 mm² 2.32x |
| `chair-caster-kit-right` | 8372 mm²        | 14223 mm² 1.70x | 19422 mm² 2.32x |
| `chair-seat-center`      | 7868 mm²        | 15191 mm² 1.93x | 44810 mm² 5.70x |

- **It costs nothing on any shipping part today.** The two caster plates print one filament, so no tower
  is placed there.
- The reachable case is a hubcap **cut to its artwork shape**: a silhouette with a deep notch can be told
  its corners are blocked when the notch leaves one open.
- Conservative in the right direction (a tower parked through a part is worse than one the slicer
  places), so this is a precision item, not a correctness one.
- **Closing it** means a real 2D footprint rather than a support polygon: the silhouette outline
  `hubcapOutline.ts` already builds, mapped through the part's plate rotation, with a polygon-polygon
  overlap in place of the half-plane clip. That only helps parts that carry an outline, which is the
  hubcap and nothing else, so do it when a second concave part reaches the fallback.

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

`HUBCAP_PLATE` ([src/export/threemf.ts](../src/export/threemf.ts)) carries hand-verified arrangements
for the 256×256 and 270×270 beds, both checked at 220mm. `hubcapPlacement`
([src/geometry/hubcap.ts](../src/geometry/hubcap.ts)) applies them only within that. Everything outside
falls back to centring the part with `suggestTowerPos` picking a corner: correct, and it says so, but
it needs a slicer pass every time.

What that leaves open, in the order it is likely to bite:

- **The H2D (350×320) has no verified plate at any size.** It is also the bed with the most room (a
  220mm disc leaves a ~90mm corner), so the computed fallback is very likely fine. Nobody has confirmed
  it.
- **Nothing above 220mm is verified on any bed.** The control goes to the plate size, so a 250mm hubcap
  on a 270mm bed is reachable and unverified. On the 256mm bed the verified clearance is only 7mm, so
  the existing numbers can't be stretched a little.
- **A hubcap cut to its artwork's shape never gets the verified plate, at any size.** `hubcapPlacement`
  is withheld outright once "Cut to artwork shape" is on
  ([src/assembly/kinds.ts](../src/assembly/kinds.ts)), because `HUBCAP_PLATE` was checked against a
  round disc and a silhouette can reach further off-axis than a circle of the same longest-side reading.
  A verified arrangement would need re-checking per silhouette, which isn't a fixed set the way bed
  sizes are, so this likely stays computed-and-flagged rather than baked.

**Closing** either of the first two is the same job and needs no code:

1. Export at the size and printer in question (`scripts/export-hubcap-examples.mjs` produces the files).
2. Position the part and the prime tower in the slicer, save, and add the numbers as another
   `HUBCAP_PLATE` entry, plus raise `HUBCAP_VERIFIED_DIAMETER_MM` if the check is at a larger diameter.
3. Read the provenance comment on `HUBCAP_PLATE` first: the part position and the tower position are
   one claim. On both verified beds the disc had to move off centre to free a corner, and transferring
   one without the other puts the tower through the part.

This can't be solved once and for all the way the fixed parts were: a generated part has no stable mesh
to seal a pose against, so every arrangement is only verified for the parameters it was checked at. More
entries narrow the gap; they don't close the category.

## Boundary fringe threads survive the trace

A hair-thin thread of a third color can hug a high-contrast boundary in a traced image (mario's mustache
top edge, a button accent): the anti-aliased band quantizes to its own label, and it is as long as the
boundary, so no area floor catches it. Prints under one nozzle wide, so slicers drop it; a preview
blemish, not a bad print.

Three width-rule formulations (absorb components under a mean-width threshold) were built and cut after
three consecutive review rounds each found real defects. History:
[2026-08-24](findings/2026-08-24-despeckle-floor-recalibration.md), defect 3.

Closing this again means clearing, at minimum:

- Placed photographs: quantized gradients are long 1-3px iso-color bands; a probe showed a width rule
  cascade-collapsing sixteen bands into one component. Photos need an exemption or a measurement.
- Sub-fringe line art: a drawing whose every stroke is under the threshold must not trace to nothing,
  and the "raise Detail" advice in the empty-trace error cannot be the remedy, since Detail does not
  scale a width rule.
- Perimeter bookkeeping through union-find merges: the despeckle adjacency maps only tally pairs with a
  speck side, so a union's internal big-big runs are not subtractable from a perimeter without a fuller
  tally. Two of the three attempts got this wrong.
- The no-op regime: mean width is never under 0.5 (a lone pixel is 2*1/4), so any threshold at or under
  0.5 must skip the O(w*h) perimeter scan entirely.

## `noUncheckedIndexedAccess` is not enforced

Measured at **2727 errors** (`npx tsc --noEmit --noUncheckedIndexedAccess`) on `main` @ 8db8c6d, up from
2240 @ 04c2c81. Enabling it is a real project, not a flag flip.

- Split from the closed "Numeric coercion has no lint rule" section, which settled the parsing-helper
  convention (`src/util/number.ts`) for the other half.

## Plain-JS tooling imports each carry an `@ts-expect-error`

Tests and bench scripts import `scripts/*.mjs` and `scripts/lib/*.mjs`, which have no `.d.ts`.

- **Measured**: 23 suppressions, 22 of them this shape
  (`grep -rnE '@ts-expect-error|@ts-ignore' src scripts tests | wc -l`, then `| grep -c 'plain-JS tooling'`).
- **Closing it**: a `.d.ts` beside each imported module removes them in one change. Unmeasured: how many
  of the 22 share a module, and whether the declarations need keeping in step with the scripts.

## A regenerated source mesh would leave its rotated copies on the old geometry

`asmAddDuplicate` ([src/assembly/parts.ts](../src/assembly/parts.ts)) shares `positions`, `vertices`,
`indexed`, `patches` and `zones` with the source by reference. `asmAdoptMesh` assigns _new_ arrays to
those on the source, so a re-adopted source would keep its copies pointing at the previous mesh.

**The mismatch is inconsistent, not merely stale.** `syncDuplicateFaces` pushes `boundaryLoops` and
`restPositions` derived from the source's _new_ mesh onto a copy whose `positions` still reference the
_old_ one, so the copy carries a face outline that does not belong to its own geometry. Before that sync
existed the copy was at least self-consistent on the previous mesh.

**Unreachable today**, on two greps of `src/assembly/kinds.ts`:

- `grep -n "allowRotatedCopies: true"` → 1 hit, the `wheel-half` role.
- `grep -n "buildMesh:"` → 1 hit, the `hubcap` role, which sets `allowRotatedCopies: false`.

So the only role with copies never re-adopts a mesh. `asmAdoptMesh` re-runs on an already-loaded part by
three routes, and each is closed:

| Route                      | Why it can't hit a copy                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `asmRebuildGeneratedParts` | Needs `buildMesh`, which only the copy-less hubcap has                                                          |
| `asmLoadFullAssembly`      | Clears `state.assembly.parts` before loading anything                                                           |
| `switchChairVariant`       | Filters the variant roles' parts out first, copies with them; every chair role sets `allowRotatedCopies: false` |

Found while enumerating readers for the design-face fix, not measured against a running app.

**Closing it** means either extending `syncDuplicateFaces` to the mesh fields too, or rebuilding a
source's copies when it re-adopts. It stays open because the first role to pair `buildMesh` with
`allowRotatedCopies` makes it real, and nothing today can produce a case to test against.

## Charts with no dead region keep up to 0.2mm of cut region past their triangles

**Whether that band prints is unmeasured.** The bake clips the cut region back onto its chart only where
a dead region was subtracted. The 14 charts without one keep their claim as `subRegions` drew it.

- **649.41mm²** off their triangles across those 14 pieces, against 118.63mm² on the 12 clipped charts
  (`npx vite-node scripts/measure-cut-offsurface.mjs`).
- Both figures include holes the claim closes on purpose, which the clip keeps.
- The slack is attached to its one piece per chart, not cut free. It has never made a standalone piece.
- `lookup` answers the nearest triangle at any distance, so this band may still extrude along the chart
  edge.

**Clipping every chart was measured and rejected.** The same clip applied to `subRegions` on all 26
charts, before the dead subtraction:

| measure                                    | result                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `check-cut-ribbon-ink.mjs --sidecar=…`     | exit 1: new "too fine to print" on `Handle (left)`                                   |
| templates changed                          | 9 of 11                                                                              |
| `npx vitest run tests/chair-zones.test.ts` | 4 failures beyond the seam pin: fold holes, net yields, overlap pairs, yield overlay |
| stale-bake guard                           | holds                                                                                |

Reproduce by moving the clip in `bakeZones` onto `subRegions` for every chart, re-baking, and running
the gate (`npm run build && MOSAIC_GPU=1 npx vite-node scripts/check-cut-ribbon-ink.mjs --sidecar=<it>`)
and the tests above. The spike that measured it, with its code inlined and 216.64mm² of the 649.41 off
the filled silhouette (closed holes excluded):
[spikes/2026-10-04-cut-region-clip-scope.md](spikes/2026-10-04-cut-region-clip-scope.md).

**Closing it** takes a driven export over a coverless chart's edge, like the reference variant in
`scripts/check-cut-ribbon-ink.mjs`. Either it shows no ink past the triangles, or a wider clip lands
without the four regressions above.

## Whether a near-floor clipped-ink piece is dust or a drawn detail is unmeasured

`docs/findings/2026-09-27-clip-ink-sweep.md` swept the runtime floor's own population (a placed design's
ink clipped to a part: `placedInk` in `src/geometry/designClip.ts`, `dropSpecks` in
`src/geometry/colorPrism.ts`) across the four fixture patterns on real parts. Re-derive with
`RUN_CLIP_INK_SWEEP=1 npx vitest run scripts/measure-clip-ink.test.ts`.

**The floor is not comfortably clear of shipped content.** 9.4% of the recorded foreground-ink pieces
(760 of 8,056) sit below `CLIP_REMNANT_FLOOR_MM2` (0.16mm²), and the narrowest surviving piece is
0.160048mm², 1.00003x the floor. 86% of the sub-floor pieces are the zebra pattern alone (already
flagged elsewhere for needing its marching-squares contours thinned to fit the vertex budget); cow
contributes only 5.

**Not open**: the floor stays an area, not a width, deliberately.

- A width test on ink would delete a deliberate 0.3mm stroke in someone's artwork. That is a real choice,
  honoured the way a sub-layer depth is (`MIN_CUT_DEPTH_MM`, docs/audience.md).
- The #296 hairline no longer reaches this floor, because the bake removes it first. It did before:
  #296's own guard was written against the pre-fix build and reported an inlay built from the 0.025mm²
  remnant, and the bake move landed six rounds later in the same PR. So the area-not-width choice stands
  on the 0.3mm-stroke case alone.

**What is still open**: whether the sub/near-floor pieces are dust (a clip-boundary numerical artifact,
the failure mode the floor's own docstring names) or genuine zebra-pattern detail.

- Many are extreme slivers (aspect ratios into the hundreds), consistent with dust, but not all: some are
  close to square.
- Answering it needs tracing individual pieces back to their source loop, which the sweep didn't attempt.
- If the near-floor zebra content is dust, the floor is vindicated with a sharper margin than "five
  orders of magnitude" ever claimed. If it's real stripe detail, the speck notice is firing on content
  people meant, and either the floor or zebra's own tracing needs a second look.

## A Fill hidden under a sticker on a cut-through part can read as off the part — unmeasured

**The case.** A cut-through part has no clip boundary, so its fill still reaches past the mesh.

- A sticker can hide every bit of a fill colour that lies on the mesh and still leave pieces of it off
  the mesh.
- The cut-back then leaves the colour non-empty, so it is not counted as covered.
- Those pieces cut nothing, so the colour never counts as landed.
- If no other part cuts that colour, the build says "… lands entirely off the part", whose remedy
  (lower Scale, move the design) is wrong. The true message is `fillCoveredNotice`.

**Why it is rare.** Every part carrying the colour must end that way: a bounded part clips to its face
first, so it reports correctly. On the wheel that means a sticker covering all of Top, Bottom and Cap.
Not reproduced: no test or drive has built it.

**Closing it** means deciding "covered" against the mesh rather than the 2D region, in
`buildColorPrism` ([src/geometry/colorPrism.ts](../src/geometry/colorPrism.ts)). For example, clip a
boundary-less fill to the part's footprint before the cut-back, or count a colour covered when the
cut-back removed area and what is left produced no inlay.

## The page still stalls around a rebuild, outside the worker

The build no longer blocks the page, which makes the stalls left on the main thread stand out.
Figures are from check (a) of `npm run build && MOSAIC_GPU=1 node scripts/check-rebuild-worker.mjs`
(chair, 1.27M triangles, its "gaps over 50ms" line) unless marked otherwise.

- **Drawing the result**: a 686-759ms gap as the result is drawn (`bufferGeometryFromTris`, `Box3`, GPU
  upload, shader compile); 792-800ms on 5c7f898, so the worker didn't change it. `newModelGroup`
  disposes materials, which releases three's programs, so every rebuild recompiles shaders; that
  share is **unmeasured**. Reusing materials would cut it.
- **Autosave, probably**: a 321-477ms gap about 0.7s after the curtain drops, when `saveSession` fires (1s
  after the rebuild's tail). Attributed by timing, not profiled.
- **A hubcap session loads Manifold twice**: hubcap generation (`asmRebuildGeneratedParts` →
  `getManifold`) still runs on the page, the build in the worker.
- **The worker keeps a copy of each part's mesh and zone charts** (`BUILD_PART_FIELDS`), and the
  part cache a copy of each part's last cut meshes. Memory cost unmeasured. Copying them in and out
  costs about 1% of a full re-cut, inside the bench's noise: 48.5s on 230a5a7 vs 49.0s, summed
  medians of the 20 rebind rows of
  `npm run build && MOSAIC_GPU=1 node scripts/bench-zone-rebuild.mjs`.
- **Fill tiling has no cancel check.** The page no longer waits on it; the worker is terminated after
  `CANCEL_GRACE_MS` (1s) instead.

## A finished export says nothing, and a disabled Export gives no reason

Third consecutive review cycle (bloat, 2026-08-24 beta, [2026-10-06 beta](review-cycles/2026-10-06-beta.md) item 2).

- After a download the panel is byte-identical; the browser's download chip is the only signal. A chair
  export is 26-81MB on 11 plates, and nothing says so.
- `#export-hint` reads the same enabled or disabled. No artwork, a design entirely off the part, and a
  cancelled rebuild each disable or empty the export a different way, unexplained (cycle items 10, 12).
- A part whose file fails to load raises an alert naming it; once dismissed, Export ships the rest with no
  standing warning (wheel: "Cap" only; chair: 12 of 13 parts). Cycle item 6.
- **Closing it**: one status line under the button after a download (file name, plates, filaments, size);
  a one-line reason when disabled, one rule for every "nothing to print" case; a standing warning for a
  part that did not load; clear the raster "No opaque pixels" warning on the next good image load.

## New chair artwork lands on one zone, so a one-sided chair is the default path

- A new design binds to "Left side"; "7 of 8 zones still blank" is ℹ, and Export is enabled. The
  "artwork on 1 of 8 zones" warning arrives after the download.
- The sample does the same: a thumbnail-sized badge on the flank facing away from the default camera.
- The zone select offers both "All zones" and "Whole chair" with nothing saying how they differ.
- Observation: [2026-10-06 beta](review-cycles/2026-10-06-beta.md) item 1, three lenses.
- **Closing it**: default new chair artwork to All zones, or say the zone count in `#export-summary`
  before the click; explain or drop one of the two "whole" entries. Make "Load sample artwork" a no-op
  once loaded and give the sample a size in mm so it raises no note (cycle item 13).

## Placement and prime-tower notices appear only after the file is saved

- Hubcap 240mm on the X1C, 260mm on the U1: "No tower position was saved" shows only after the
  download. Half of the 2026-08-24 T0-8; the other half (pills outliving a printer switch) is fixed.
- A chair export on the H2D, a bed with no baked pass, shows no "check it in your slicer" note; the hubcap
  on the same printer does. The positions themselves are the open section "The chair's prime-tower
  positions have only been verified on one bed size".
- Observation: [2026-10-06 beta](review-cycles/2026-10-06-beta.md) items 3, 11.
- **Closing it**: compute the placement notes on the build, not the export, and show the unverified-bed
  note for every kind.

## Chair notices pile up, and warnings name colors by hex

- A plain 3-color design on all zones raised 8 "too fine to print" notices, about 3 visible; depth 60
  raised 17 clamp warnings. The color named is often the big backdrop, so "detail" reads false.
- Every warning uses hex (`"#f5d020"`) while the row beside it reads "≈ Yellow". Convention 2.
- Depth fields keep the typed value (0 → `0.00`, 50 → `50.00`) while 0.20 / 2.95 is cut; `0.001` is shown
  as "0.00 mm", a tolerance-scale number.
- Observation: [2026-10-06 beta](review-cycles/2026-10-06-beta.md) items 4, 9.
- **Closing it**: one line per color across parts, as the wheel's clamp warning already groups; color
  names in warning text; write the applied depth back into the field.

## Removing a design cannot be undone

- One click on a row's × removes the design, its colors and any merges. Ctrl+Z does nothing; there is no
  undo control. Third consecutive cycle.
- Observation: [2026-10-06 beta](review-cycles/2026-10-06-beta.md) item 5.
- **Closing it**: an "Undo" toast for the last removal at minimum; a snapshot stack on the store later.

## Export and Colors sit far below the fold

- `#left` is 1436-1905px tall in a 730px pane. 7-color footrest at 1024x768: `#color-list` at 1134px,
  `#btn-export` at 2089px in a 688px pane. Collapsed panels reopen on reload.
- The 5+ slot warning says to drag color rows together, 1,100px away, and never names the Colors slider
  that fixed it in three moves (6 → 3 colors, 7 → 4 slots); auto-merge left it at 7 slots on every
  setting.
- Observation: [2026-10-06 beta](review-cycles/2026-10-06-beta.md) items 7, 8, 18.
- **Closing it**: pin the Export block; remember `details` state; name the Colors slider in the slot
  warning.

## UI copy uses three names for one thing, and engine words

[2026-10-06 beta](review-cycles/2026-10-06-beta.md) items 14-17. Convention 34 and the vocabulary table.

- Wheel: "Top ×2 + Cap" in the picker, Top / Bottom / Cap in the list, "Plate 1: Top, Cap" in the export.
- Chair: plates say "Wing", zones and templates say "fender". Seat hatching has no legend.
- "Reload assembly" on every kind with every part loaded; "Pockets are cut into each part's real mesh"
  stays after artwork loads; Advanced reads "plane offset 170.00mm, 271-pt boundary".
- Hubcap size stated twice (field, then bold "Actual size 220.0 × 220.0 mm").
- **Closing it**: one copy sweep against the vocabulary table.

## An outline that crosses itself into equal halves is left out, not split at the crossing

An equal bow-tie, figure-8 or infinity sign has a net area of zero: its lobes wind opposite ways.
`shapeToFeature` ([src/geometry/regions.ts](../src/geometry/regions.ts)) drops any loop at or under
`RING_AREA_FLOOR`, so the outline is not cut. `cancelsOut` names it in one build warning with a count
(docs/troubleshooting.md). A browser fills both lobes.

- **Seen in no real file.** 0 of 4,728 SVG loops over the fixtures, `public/templates` and `stubs/`,
  and 0 of 6,250 traced loops over the raster corpus
  (`node_modules/.bin/vite-node scripts/measure-cancelling-outlines.ts`).
- The same run finds 10 SVG loops under the floor that do not cancel. All are in one `stubs/temp/`
  file: Illustrator slivers drawn out and back, which the clipper's union finds empty.
- **Unequal lobes reach the cut as one self-crossing ring**, nested by containment like any other.
  Not measured against a browser's fill.
- **The count's cost is unmeasured.** `cancelsOut` runs one clipper union per loop under the floor,
  synchronously after the region pass's last yield. The most loops under the floor in one corpus file
  is 10 (same command); a file with thousands is untimed.
- **The fill rule is not parsed.** `fill-rule` appears nowhere in [src/svg/parse.ts](../src/svg/parse.ts).
  `nonzero` and `evenodd` agree on a figure-8; they disagree on a loop that winds twice.

**Why deferred**: the bug was a silent drop. Warning on it closes rule 1; splitting has no real file
asking for it.

**Closing it**:

1. Parse `fill-rule` onto `SVGShape`.
2. Before nesting, resolve each self-crossing loop into simple rings under that rule. Manifold's
   `CrossSection` takes `NonZero` or `EvenOdd`, as `repairSelfIntersections`
   ([src/geometry/manifold.ts](../src/geometry/manifold.ts)) uses it; it needs the wasm loaded before
   `computeNetRegionsByColor`, which is pure 2D today.
3. Test: an equal bow-tie cuts both lobes, a twice-wound loop differs by rule. Then delete
   `cancelsOut`, its warning and its troubleshooting section.

## SVG clips, masks, linked copies, text and strokes are named, not drawn

`parseSVGDocument` ([src/svg/parse.ts](../src/svg/parse.ts)) warns once per load for each kind, with a
count. None of them reaches the print as drawn.

| Element                   | Today                                                | Closing it takes                                                                                                                     |
| ------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `clip-path`               | Shape prints uncropped; warned unless it fits inside | Intersect each shape's loops with the clip's (`polygon-clipping` is already a dependency); `objectBoundingBox` needs the shape's box |
| `mask`                    | Shape prints unmasked; always warned                 | No outline equivalent for a brightness mask. Likely stays a warning                                                                  |
| `<use>`                   | Skipped                                              | Walk the referenced element through the same `walk`, with `x`/`y` and a `<symbol>`'s viewBox                                         |
| `<text>`                  | Skipped                                              | Glyph outlines need a font parser and the font file. Likely stays a warning                                                          |
| stroke with `fill="none"` | Skipped                                              | Offset each stroke to a polygon (width, joins, caps, dashes)                                                                         |

- **Measured**: no shipped or fixture SVG has a `clip-path`, `mask` or `<use>`. That is the four
  pattern fixtures, the 11 `public/templates/` files, the sample badge and two generated hubcap
  templates. All 13 template files have text labels and 8 have guide strokes. They stay quiet only by the
  template-ink exemption (`TEMPLATE_INKS`); without it all 13 warn
  (`RUN_SVG_SKIP_SWEEP=1 npx vitest run scripts/measure-svg-skipped-content.test.ts`, second table).
- **Unmeasured**: how often real uploads carry each kind. The fixtures say nothing about user files.
  Figma writes `fill="none"` on the root `<svg>`, so every Figma outline lands in the stroke row.
- **Still silent**:
  - A stroke on a filled shape: the fill prints, the stroke is dropped.
  - A stroke-only shape inside a group hidden by `fill-opacity="0"`, which still draws its stroke.
- **Clip proof is conservative.** A clip is taken to crop a shape unless every point of the shape lies
  inside every edge of one clip outline (`insideEveryEdge`, [src/svg/clip.ts](../src/svg/clip.ts)). Under a clip
  that isn't convex, a shape spanning both arms of an L warns although nothing is cropped.

## An invalid own fill prints black instead of inheriting the group's fill

- `<g fill="#ff0000"><rect fill="bogus"/></g>` imports the rect as `#000000`. A browser ignores an invalid
  value and inherits the group's red, so the print differs from the editor only when a group sets a fill.
- Found while fixing the inherited `fill="none"` cascade (#363). No shipped or fixture SVG sets a fill on
  a group (`RUN_SVG_SKIP_SWEEP=1 npx vitest run scripts/measure-svg-skipped-content.test.ts`).
- **Closing it**: treat an unparseable own fill as `inherit` in `paint()` (src/svg/parse.ts).
