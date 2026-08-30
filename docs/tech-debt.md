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

## rasterControls().apply()'s notice ordering is load-bearing, and a replace-in-place fix to remove it was tried and reverted

`rasterControls().apply()` ([src/ui/artworkListPanel.ts](../src/ui/artworkListPanel.ts)) must call
`dismissNotice()` before `notice()` when flipping a source's keyed capped/traced notice. `push()`
([src/warnings.ts](../src/warnings.ts)) skips a new entry when its key is already taken, so calling
`notice()` first drops the replacement, and the following `dismissNotice()` then removes it —
leaving nothing standing for that source.

A `push()` that upserts a same-key entry in place, removing the ordering requirement, was tried and
reverted after three rounds each found a real defect:

- **Unconfined to keyed entries**: overwriting any same-message match changed every unkeyed
  `warn()`/`notice()`/`warnBuild()`/`noticeBuild()` caller from skip-if-present to
  overwrite-if-present, and could flip an existing entry's `build` flag.
- **Confined to keyed entries, but swapping in a new object**: broke
  [src/ui/warningsView.ts](../src/ui/warningsView.ts)'s dismiss button, which finds its pill's
  entry by reference (`WARNINGS.indexOf(w)`) — a swapped object left that reference dangling and
  the × silently did nothing.
- **Confined and mutating fields in place instead of swapping**: fixed the reference bug, but was
  the third round in a row to need a real fix in the same mechanism — the signal to cut the area
  rather than patch a fourth time.

Closing this means either documenting the ordering constraint as permanent, or re-attempting the
upsert with a test for each of the three failure modes above written before the fix.

## The placement frame's angle is unrelated to the face it acts on, and it shares the viewport with a second affordance

Conventions 13–14 of [ui-conventions.md](ui-conventions.md): a gizmo is aligned to the frame of
the thing it acts on, and only one manipulation affordance is offered at a time. Both are
reported broken — the placement frame renders at an angle with no relation to the part face, and
corner handles compete with an axis handle for the same drag.

**Measured 2026-08-24, and it is a bug, not a rendering choice**
([findings report](findings/2026-08-24-placement-frame-angle.md)). `scripts/measure-frame-angle.ts`
re-measures it. The anchor hijack that faked this in the 2026-08-16 run is fixed (PR E), so the
angle now reads honestly.

- **8 of the 18 patches the part panel offers put the frame 90.0° off the face**, across the three
  file-based design meshes. Always exactly 90.0°: `FlatZoneMapper.frameAt` returns a literal
  horizontal basis whatever the part is shaped like.
- **7 of the 8 clip the cut to exactly 0 mm².** Nothing prints there, so the build's "the cut may
  be wrong" understates it. The eighth is `wheel-hub-cap`, which sets `cutThrough` and so is not
  clipped at all; what it cuts on a sideways face is untested.
- **Every kind's default face reads 0.0°**, all four parts, read from the app rather than from the
  area ranking (`defaultPatchIdx` prefers the role's `preferFaceNormal`, and two default to rank
  1). That is why ordinary use never shows it.
- Not silent: the sideways-face warning and the "colors land entirely off the part" warning both
  fire, and the second is accurate.

Two defects left open. A third, the "face detected" line not tracking the dropdown, is fixed: the
row now recomputes it in place through `faceStatusText`.

1. `frameAt` hardcodes the horizontal basis. `faceY` already carries a fallback for a sideways
   normal, so the case is known and drawn through anyway.
2. The gizmo cannot warn: the amber off-surface state keys on `offSurfaceMM`, and the flat path
   returns `offChartMM: 0` unconditionally, so that state is unreachable on every flat part.

**Bounded, which is what keeps the fix small.** Every shipped part's default face is horizontal
because `pack-part.mjs` aligns it, so all 8 measured cases need a deliberate pick from the
dropdown, behind the "Advanced: per-part face & alignment" disclosure. An uploaded mesh has no
such guarantee and would hit both defects at its default face with no interaction at all, but the
STL/3MF drop target is only offered when the parts library is unreachable (see
`buildAsmPartRow`'s docstring in [src/ui/assemblyPanel.ts](../src/ui/assemblyPanel.ts)), so that
is a degraded-mode path rather than a normal one. Undriven either way.

The competing-affordances half (corner handles against an axis handle for the same drag,
convention 14) is separable, is a UI decision, and was not touched here. This is the last of the
group that made the viewport not behave like the direct-manipulation surface it looks like; the
other one, "Zone picking has no occlusion test," is closed (`npm run check:zone-occlusion`
re-measures it — by hand, it is not in CI).

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

## Assembly mode bounds a depth by the part, not by its wall

The 2026-08-24 cycle's **T0-3**, half closed.

**What was wrong.** Assembly mode had no upper bound on recess depth at all.
Depth 20mm and 9999mm on the wheel both built and exported with **zero
warnings**, while flat mode clamped and warned for the same input, and
`geometry/depth.ts`'s own comment stated the contract as "a zero is raised and a
too-deep value clamped, so both warn". That second half was false for every part
a user could select, and the flat modes leaving the UI made the unbounded path
the only reachable one.

**What is fixed.** `ZoneMapper.maxCutDepth()` bounds the setting, and a clamp is
warned about by name. The flat mapper measures how far the part extends behind
its design face **along Y, the axis `buildCutter` extrudes down**, off the loaded
mesh. Measuring along the face normal instead was tried and is wrong: on
wheel-half's -Z patch it read 139.88mm against 24.13mm of real material. A face
whose normal is not substantially along Y declines outright, since the plane
offset is then an X or Z distance and there is nothing to measure. The conformal
mapper declines too: it cuts along a normal field rather than one axis.

**What is not.** That bound is the part, not the wall. On the wheel it is
**48.45mm**, so a mistyped 9999 is caught and a 20mm pocket in a 3mm wall is not.
**The wall is what closes the rest, and nothing measures it.** A part's wall
varies across it, so a pocket deeper than the wall in one spot still cuts a hole
clean through and exports without comment. That is the open half of this item, not
a separate one: the prose that used to carry it lived in the README's limitations
list and now points here.

**Three cases decline outright** rather than guessing, and raise no warning at
all: a conformal zone (it cuts along a normal field, not one axis), a face whose
plane lands outside the mesh, and a part too thin to hold the minimum. On those
the deep end is unbounded exactly as before.

Deliberately not solved with a constant. `AssemblyPart.baseDepth` states "mm of
material behind the face this replaces" and looks like the answer, but nothing in
the build has ever read it, so adopting it would have given a dormant,
user-editable field control of cut depth as a side effect of a bug fix.

Closing it means measuring the wall under each cut region, most likely by casting
into the mesh along the cut direction, and comparing that against the setting per
region rather than per part.

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

**Withheld from users, 2026-08-05.** The chair-body kind now carries
`withholdFill` (`src/types.ts`), so Fill and the pattern strip are not offered
on it and no user can reach the numbers above. This is a gate, not a fix: the
path is unchanged and every measurement here still stands. Clearing the flag
needs the accumulator-or-worker fix and the "Handle (left)" color loss (defect
3 of "Two open defects in the chair / pattern-library workflow", below).
Sticker on the chair is unaffected and was measured at 19.5s for a full
five-zone rebuild on the same box, which is why only Fill was withheld.

**Don't quote that 19.5s without saying at what design size.** It used a design
covering the zones;
[docs/findings/zone-rebuild-cost.md](findings/zone-rebuild-cost.md) reproduces it
at 400% (17.0s) and measures an ordinary auto-fit sticker on all five zones at
4.0s — a 5x spread on the same path. What is paid for is pocket area, not
surfaces touched.

## The per-color union in the flat pass is one atomic sweep, bounded by nothing

`computeNetRegionsByColor` ([src/geometry/regions.ts](../src/geometry/regions.ts)) merges each
color's visible pieces with a single n-ary call. The accumulator fold beside it is capped at
`COVERED_BATCH`, so it always hands the engine a bounded call; this one hands it however many
pieces the artwork produced. The pass yields between colors, never inside one.

**Measured, and small on everything real**: 30ms across the whole corpus, 18ms worst
(`scripts/bench-regions.ts`). It is kept n-ary because the alternative costs real time: folding it
through `unionAllCooperative` instead measures dino ring at 158ms against 123ms.

The case that is not covered is a raster trace near `MAX_COMPONENTS` (800, src/raster/trace.ts)
where one shade owns most of the components. Nothing in the corpus reaches it, so the freeze is
unobserved rather than ruled out.

**Closing it means chunking the sweep, and the chunk size has to be measured, not picked.**
`COVERED_BATCH` was swept over 50/100/200/400 shapes before it was chosen; this is a different
operation (many small pieces unioned, rather than a growing accumulator subtracted) and its curve
has not been taken. Do that first. A constant copied across from the other call site would close
the finding without measuring anything, which is the failure this file exists to prevent.

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

## Two open defects in the chair / pattern-library workflow, and what's blocked on them

Two of four defects the maintainer named on 2026-08-05; the other two are fixed.
Both features are withheld from the UI for the beta: `chair-body` carries
`hidden: true` and `PATTERN_LIBRARY_ENABLED` is `false`. The report is the
maintainer's, the diagnosis is not, and where the cause is confirmed it says so.

1. **Dead zones still need defining — open.** It is written up in
   [roadmap.md](roadmap.md) ("Dead zones: mark the parts of a design zone that
   are hidden by an adjacent part"). Without it a design placed across a joint
   spends filament changes on surface nobody sees.

2. **The SVG templates have odd/wrong edges — confirmed, same root as the cut
   outline.** Every shipped template in `public/templates/` is a pure `L`
   polyline with no curve commands: the zone boundary is traced along mesh
   triangle edges and emitted vertex-for-vertex. So a template's outline is as
   faceted as the tessellation under it. Two of them are also very ragged
   rather than merely faceted — `back` carries a 355-point boundary with **18
   holes**, `front` 146 points with 3 — which is what a grown-region boundary
   looks like when it stops mid-surface, and is the same boundary the cut
   clips to. Note the repo already has curve fitting for the raster tracer
   (`src/raster/curve.ts`); nothing equivalent runs on a zone boundary.

3. **Zebra + Fill still loses one color on "Handle (left)" — confirmed.**
   Measured on `MOSAIC_GPU=1` production build, 2026-08-03: zebra in Fill mode
   on the chair's Left side settles clean apart from a single `Couldn't cut
color #0a0a0a into "Handle (left)"`, so that part prints without the black.
   Net improvement over the pre-thinning asset (8 union failures across 4
   parts down to 1 CSG failure on 1 part), but "one part quietly loses a
   color" is still the outcome. Different layer from the union problem (this
   one is Manifold, not turf 6.5). Closing it means reproducing against
   `?csgfault` (see the `debug-csg-failure` skill) and narrowing to the
   specific solid Manifold rejects; worth trying first whether the handle's
   own mesh density or a near-tangent cut at its curvature is what trips it.

4. **The extrude repair never runs on a conformal zone — related,
   unmeasured on the chair.** `ConformalZoneMapper.buildCutter` absorbs an
   invalid prism and returns `null`, so the escalating erode ladder that
   fixed a lost color on the wheel (a `FlatZoneMapper`) buys the chair body
   nothing: a conformal zone gets no repair attempt and goes straight to the
   warning in defect 3. Whether the chair body actually hits self-touching
   regions is unmeasured — nobody has driven dense artwork through a
   conformal zone to find out. Closing it means either giving the conformal
   mapper the same retry, or establishing that its null return means
   something different enough that a retry would be wrong.

5. **`export-chair-examples.mjs` cannot reach Fill — tooling, broken since
   #137.** The script sets `.artwork-mode` to `fill` and asserts it took, but
   `chair-body` carries `withholdFill: true` so `artworkListPanel` never
   renders that select: the step times out. Not a selector to update — the
   script exists to put several colours on every part so each plate's prime
   tower sees real swaps, and Sticker on one zone isn't that. Either the Fill
   defects above close and `withholdFill` comes off, or the script needs a
   different way to put several colours on every part.

`?kind=chair-body` still reaches the chair, which the `bake-zones` and
`debug-csg-failure` skills and every chair drive script depend on. Nothing
public names that parameter: it is out of the README's `?kind=` example list.

Neither flag is the fix. Restoring the chair needs defects 1-2 closed;
restoring the pattern library needs defect 3 closed.

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

## A restored session's assembly-kind switch still isn't atomic

What is left of the restore-atomicity item after `applyRestoredSessionInner`'s
scalar fields (printer, base shape, depth, colour grouping — 24 fields: count
the keys `buildRestoredScalarState` sets, 20 always plus 4 conditional) were
made atomic: built into a local object and committed in one `Object.assign`
only once every source in the session has come back
([src/state/persist.ts](../src/state/persist.ts)).

The switch to the saved session's assembly kind still assigns straight into
`state` before the one thing in that branch that can throw:
`state.shapeKind`, `state.assembly.kindId`, `state.assembly.variantId` and
`state.assembly.parts = []` are all set, then `await asmLoadFullAssembly()`
runs. If it throws (an unreachable parts library, e.g.), the part has already
switched but the sources and artwork list — computed after this await
returns — never get applied. A reload shows a session that thinks it's the
saved part with none of that part's designs on it.

Not the same bug this item started as: it can no longer put a value from the
session into one of the 24 scalar fields while the picker or the model shows
something else. Only the assembly kind and its parts can lag behind.

Closing it would mean giving `asmLoadFullAssembly` a way to report success
without having already mutated `state.assembly.parts` piecemeal as it loads
each role — a bigger change to a function whose job is that live progressive
load (the confirm dialog and the mid-load kind-switch guard both depend on
`state.assembly.parts` being the live list). Deferred rather than folded into
the fields fix, which does not touch `asmLoadFullAssembly`'s contract.

## The flat-plate modes ship compiled and unrendered

`disc`, `rect`, `round` and `stl` are all still `ShapeKind`s, with their param
panels, their input bindings, [flat.ts](../src/geometry/flat.ts), the per-color
STL-set export and their branches in `store.ts` and `rebuild.ts`. None is
reachable: `renderShapeKindOptions`
([src/ui/partPanel.ts](../src/ui/partPanel.ts)) writes assembly kinds into the
Part dropdown and nothing else.

`rect`/`round`/`stl` have been unrendered since before 2026-08-02 and were
re-confirmed deliberate by review then. `disc` joined them for the beta, closing
the 2026-08-08 cycle's **A3**: it produced a plain flat cylinder related to no
TMT part, sitting in the primary picker at the same weight as four real ones.

Three consequences worth knowing:

- `#btn-export-stl` and the per-color STL-set export go with it. `setShapeKind`
  hides that button in assembly mode, so no offered part reaches it, and the
  README no longer offers it as a fallback for slicers that can't read a
  pre-mapped 3MF.
- Two `'disc'` fallbacks had to move, since a select value with no matching
  option renders blank and the next switch away is one-way: the option-list
  default in `renderShapeKindOptions`, and the retired-kind branch of session
  restore ([src/state/persist.ts](../src/state/persist.ts)). Both now take
  `firstOfferedKind()`.
- A session saved in a flat mode before this release restores onto the wheel.

Everything here still compiles and is still covered by `tests/flat.test.ts` and
`tests/depth.test.ts`. It is a maintenance question (why keep four dead panels
building) rather than a bug. The option list is what to touch if a future part
wants a flat mode again.

**What `npm run smoke` no longer covers.** Four of its steps drove the disc:
switch to flat mode, override the background recess depth, export a flat 3MF,
export the per-color STL zip. They came out, since they drove UI that no longer
exists. So the flat 3MF writer and the STL-zip writer now have unit coverage
only, with nothing exercising either through a browser. The PNG-raster step was
not flat-specific and was kept, now running against the assembly part.

## Flat plate modes have no printable despeckle floor

**Unreachable as of the beta** (see "The flat-plate modes ship compiled and
unrendered"), so nothing can hit this today. Kept because reopening any flat
mode reopens it, unfixed.

The floor that stops the trace keeping detail under one nozzle width
([2026-08-20 printable floor](findings/2026-08-20-printable-floor.md)) applies on assembly kinds
only. `rasterMmPerPixel` returns nothing in disc/rect/round/STL-plate mode, so those keep the
fraction-of-the-image floor alone, which is what every mode had before.

- **Why**: a plate fits the design's drawn content (`fitTransform` over `parsed.bbox`), and that
  bbox does not exist until the trace has run. The pre-trace stand-in, the bounds of the opaque
  pixels, is wrong in the damaging direction: a stray opaque speck in a corner inflates the extent,
  shrinks mm per pixel and raises the floor over detail that would print. It was built that way and
  cut on review rather than shipped.
- **What it costs**: an 80mm disc at the 5% margin is a 72mm design, where the flat-art fraction is
  already a 0.88mm floor, so the printable one is inert at Detail 50 and would bite below about
  65mm placed at Detail 100. Small plates and scaled-down designs are the gap.
- Closing it means an extent the trace agrees with: either trace once at the fractional floor and
  re-trace when the printable one turns out to bind (two passes, ~830ms each on a photograph), or
  a cheap despeckle-equivalent pass over the alpha channel before measuring.
- Closing it now buys more than when this was written: assembly kinds also size the floor _down_ in
  mm ([2026-08-24](findings/2026-08-24-despeckle-floor-recalibration.md)), so a flat plate keeps a
  fractional floor that over-prunes detailed flat art (mario: 55mm² of print on a wheel-sized
  plate), not just the missing nozzle floor.

## The printable despeckle floor is fixed at the moment of the trace

`rasterMmPerPixel` ([src/state/artwork.ts](../src/state/artwork.ts)) reads the placement when an
image is traced, which is at load and again whenever Colors or Detail re-runs it. Nothing else
re-traces, because a trace measured ~830ms on a photograph and a slider drag would fire it per
step.

**Every input to the floor can move afterwards, and Scale is the smallest of them**: hubcap
diameter (32mm to the plate's short side, up to 270mm), the wheel's Design radius, switching
assembly kind, and the one-click Sticker/Fill switch, which changes the scale _rule_ rather than a
number. Scale itself only spans 25-400%. "+ add to another zone" is the quickest of all: it places
a second instance at 100% against a trace made for a smaller one, so the largest-instance rule the
floor was chosen by is stale the moment it lands. A hubcap cut to artwork shape adds one more: the
floor is read before the new source is registered, so it sees the _previous_ design's silhouette
face. And within the Scale field's 550ms typed debounce, `ArtworkInstance.scalePct` still holds the
old value (only a rebuild syncs it), so a Detail nudge inside that window sizes the floor from the
scale before the one just typed.

- **Getting smaller after loading** leaves the older, more permissive floor: features under a
  nozzle width survive that a fresh trace would remove. That is the pre-2026-08-20 behaviour, so it
  is a missed improvement rather than a regression.
- **Getting larger is the one that loses something**: detail removed at the size it was traced for
  would print at the new size. Load onto a 32mm hubcap and raise it to 220mm and it is gone, with
  nothing said. Only a nudge of Colors or Detail brings it back.
- The help panel now says to nudge Colors or Detail after a big resize, which is a note in a
  dialog, not the app noticing. Nothing in the panel that did the resizing says anything.
- Closing it means re-tracing when the placed size moves far enough to matter, which needs the
  debounce and the cancel path the Colors and Detail sliders already have, or a notice that says
  the design was traced for a different size.

## A seam sliver warns as if artwork were lost

Where two parts' claims on
a zone overlap, clipping a color to one part's `subRegions` can leave a
remnant a fraction of a millimetre wide. It survives the turf clip, then
yields no cutter, and
[src/geometry/assembly.ts](../src/geometry/assembly.ts) reports "Couldn't cut
color … into …. It won't print there." — alarming, and indistinguishable from
the real failure it shares a message with. The overlaps are inherent to per-part
clipping and small — measured across the shipped bake, 23 overlapping part
pairs, all seam-sharing, worst 29.85 mm² on a 124,500 mm² zone (a ~0.15 mm
ribbon), and `tests/chair-zones.test.ts` holds them under 0.05% of zone area.
Fix: drop a clip remnant under an area floor _before_ `buildCutter` rather
than attempting it and warning. Pick the floor above the measured ribbon and
well under anything printable.

This bullet used to cite the 2026-07-28 "Seat back (bottom)" warnings as a
confirmed sighting. Instrumenting the running app on 2026-07-31 showed that
those had a different cause — cutter vertices landing outside the snap
tolerance, since fixed — and that they looked permanent only because warnings
were never cleared per rebuild, also since fixed. So the seam remnant is still
real geometry and still reaches `buildCutter`, but **no warning has actually
been traced to it**. Confirm one before spending the fix on it.

A deliberate hunt on 2026-08-08 failed to produce a sighting —
[docs/findings/seam-sliver-sighting.md](findings/seam-sliver-sighting.md), 18
checkerboard configurations across three cell densities, two scales and
sub-millimetre offsets, then a finer rotated pass recording triangle and color
counts so "no warnings" is a statement about a build that demonstrably ran. Zero
cut-solid warnings throughout. That is not proof the remnant can't warn, but it
is the cheap attempts already spent — read it before repeating them.

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

## Two traces still drop a color and say nothing about it

`rasterLostColors` ([src/raster/parse.ts](../src/raster/parse.ts)) raises the dropped-color notice
only where its one sentence — raise Detail — is both true and available. Two cases are left silent,
both `droppedColors > 0`. They are the half of "a traced image can lose a color with nothing said"
that the notice did not close.

| Case                        | Suppressed by        | Reproduced by                                                    |
| --------------------------- | -------------------- | ---------------------------------------------------------------- |
| Capped, and short a color   | `capped`             | `npx vitest run tests/raster-parse.test.ts -t "leaves a capped"` |
| A floor Detail cannot lower | `!detailLowersFloor` | `npx vitest run tests/raster-parse.test.ts -t "stays silent"`    |

- **Capped**: the trace shows `rasterCappedMessage` only, which says detail "was merged into its
  surroundings" and never that a color left the palette. The two remedies are opposites — capped
  says lower Colors or Detail, dropped-color says raise Detail — so both on one image contradict
  each other. Reproduced synthetically (1024 six-pixel blocks over two flat bands plus one-pixel
  specks, 320x320 at Colors 5 and Detail 100: `capped: true`, `droppedColors: 1`), never on the
  corpus. The section below is why it is not ruled out: the cap is a target, not a bound.
- **A floor Detail cannot lower** covers two shapes of the same thing, and `detailLowersFloor`
  measures both rather than inferring either: a placement's nozzle-width floor pinning the floor
  (128px across 12.8mm drops a color at Detail 0, 50 and 100 alike), and the slider already at
  `DETAIL_MAX`. Saying either needs a second message, and the placement one's remedy is a resize,
  which does not re-trace — see "The printable despeckle floor is fixed at the moment of the trace".
- **A partly-pinned floor still fires, with a weak remedy.** Where the nozzle floor sits just under
  the fractional one, raising Detail lowers the floor by a little and may not bring the color back.
  The notice is still true — it says what Detail does, never that the color returns — and no notice
  can promise recovery, since a quartered floor can still be above a color's pieces. Drawing a "how
  much movement is enough" line would be an invented constant, so it is left as is. **Unmeasured**:
  how often that band is where real artwork lands.
- **The claim also goes stale on a resize**, since nothing re-traces on a placement change: a notice
  raised at part scale keeps standing after the design is scaled down onto a face where the nozzle
  floor pins the floor, which is the case `detailLowersFloor` exists to suppress. Same root as "The
  printable despeckle floor is fixed at the moment of the trace", and closed by the same fix.
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
  a color on a capped trace at all, and the pinned-floor one needs the re-trace-on-resize item
  first.

## `MAX_COMPONENTS` is a target, not the bound its name implies

`traceLabelMap` ([src/raster/trace.ts](../src/raster/trace.ts)) raises the despeckle floor when the
component count exceeds `MAX_COMPONENTS` (800), then never rechecks. The raise now reliably cuts
the count, which it did not before 2026-08-20
([2026-08-20 despeckle floor](findings/2026-08-20-despeckle-floor.md)), but it still does not bound
it. Two ways past the cap, both after the count was taken:

- **Absorbing specks merges them into each other**, minting components above the new floor. So
  putting the floor above all but the largest 799 does not leave 799. Reproduces on a speck field
  handed straight to `traceLabelMap` with a high floor. **Not reproduced through the real decode
  path since the despeckle fix**: the pixel art that looked like it did reads as photographic at
  the measurement size (0.3045), so the app traces it at 512px, where the raise fires and 78
  components come back. Whether a decodable image can still get past the cap is open.
- **`deChecker` breaks 2x2 checkerboards by rewriting one cell**, which can shave a pinch point and
  split a surviving component in two. Off-corpus it is common: about 8% of random label grids come
  back with a component under the floor the trace reports, against 0% straight out of `despeckle`.
  No corpus source does it, so what it costs a real image is unmeasured. Swapping the order is not
  the fix, since `despeckle` relabels whole components and can create the checkerboard `deChecker`
  exists to remove, and a self-touching ring is the worse failure.

- The cap is a performance guard on `shapeToFeature`, so being over by a few hundred on a
  pathological source costs time rather than correctness.
- Closing it: loop the raise until `realCount()` is actually under (and decide what a second raise
  does when a `deChecker` split is what pushed it over), or rename the constant and the flag to say
  what they do. `capped` today means "a raise happened", not "the count is under".
- The bench's `despeckle` mode checks the floor and the cap on every row, but only over CORPUS, so
  its cap line has never had a source that could trip it. Both columns also read the components the
  trace _returns_, which is fewer than the count it capped on: background components and any whose
  ring collapsed are already gone. A transparent speck left under the floor would be a real defect,
  and this guard would miss it.

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

## Turf's tile union has a vertex ceiling, and nothing enforces it at runtime

Measured 2026-08-03 while fixing the bundled zebra pattern. Fill mode unions
one copy of the pattern per tile, and `@turf/turf` 6.5's polygon clipping
starts failing somewhere around **800k vertices in a single operation**. It
does not throw at that point — it drops tiles, and the only surface signal is
`Couldn't merge the shapes …`. That message used to assert a cause it could not
know ("likely a self-intersecting path in the source SVG"), which was wrong here:
the paths were fine, there were simply too many of them. It is now cause-neutral
and [troubleshooting.md](troubleshooting.md) carries both causes, so what is left
open is that nothing tells the user _which_ one they hit.

The numbers that made it concrete, zebra in Fill mode on one chair zone
(`MOSAIC_GPU=1` production build):

|                                      | 13.6k verts/tile  | 1.3k verts/tile |
| ------------------------------------ | ----------------- | --------------- |
| vertices across the zone's 143 tiles | 1.95M             | 187k            |
| union failures                       | 8, across 4 parts | 0               |
| triangles produced                   | 853k              | 2.07M           |
| rebuild                              | 468.7s            | 93.6s           |

The doubled triangle count is the tell that this was silent data loss rather
than slowness: the failing run produced _less_ geometry because four parts
fell back to unmerged shapes.

What is fixed: the asset. `scripts/gen-patterns.mjs` thins zebra's contours
(`simplifyEps`), and `tests/patterns-assets.test.ts` fails any bundled pattern
whose vertex count times a chair zone's tile count would approach the ceiling.
That test's `TILES_PER_CHAIR_ZONE = 143` is this measurement frozen into a
constant, not derived from live zone geometry (`tileCoverage()` in
`src/geometry/patterns.ts` needs a real placer + extent, which only exists
mid-build) — deliberately: pulling the full chair build into what is
otherwise a fast, dependency-light asset test isn't worth it while the
budget (300k) already sits well under the failure point (~800k), a 2.6x
margin a moderately larger future zone would not eat through. If a real
zone's tile count ever grows enough to close that gap, this constant needs
re-measuring by hand — nothing will flag it automatically.

What is not fixed: **user-supplied** SVGs get no such check. A volunteer's
detailed drawing in Fill mode on a chair can cross the same line, and will get
the same misleading self-intersection warning and the same partly-blank
surface. Closing that means either counting vertices before the tile union and
warning honestly ("this design is too detailed to repeat across this surface —
N tiles × M vertices"), or chunking the union into batches small enough to
stay under the ceiling and merging the results. The batching option also
removes the ceiling for the bundled patterns, which would make the asset
budget above a performance concern rather than a correctness one. Upgrading
turf past 6.5 may move the ceiling but is separately blocked — see the
`@turf/turf` pin section.

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

## A patch boundary that meets itself at a point traces as an open chain

`extractPatchBoundary` ([src/geometry/meshparts.ts](../src/geometry/meshparts.ts)) keys its edge
map by **vertex**. Where two boundary loops of one patch touch at a single point, one loses its
outgoing edge, the walk runs off the end, and the truncated chain is returned as if it were a ring.

**What it costs.** `applyAsmPatchChoice` now keeps every loop and
[zones.ts](../src/geometry/zones.ts) nests them by containment depth, so a truncated chain that
encloses area can be read as a hole where the face is solid, or as solid face inside a real hole.
The artwork is then clipped to the wrong shape, and on a hubcap cut to a silhouette the edge rule
reads the wrong rims as the part's outer wall.

**Measured.** Over every packed part's first six patches, 18 of 114 contain a chain that does not
close. All 18 are chair pieces, which take artwork through baked zones instead, plus `wheel-half`
patch 2 (its -Y back: 7 closed chains and 99 open ones). **None of the four kinds' actual design
faces is affected**: wheel-half patch 0, wheel-hub-cap patch 0 and footrest patch 1 are 1, 1 and 3
loops with no open chain at all, and the exported wheel and chair are byte-identical across the
loop-set change. So this is reachable by choosing a non-default design face, or by dropping a
pinched mesh on a role, and not by the shipped workflow.

**Why it isn't fixed here.** Two attempts were made while closing the loop-set item and both
introduced worse bugs than the one they closed, which is what argued for splitting it out:

- Discarding chains that do not close, marking vertices consumed as the walk goes: a chain running
  off the end ate a genuine loop it had entered, and both were lost. Six patches returned no loops
  at all, and `chair-seat-center` patch 0 dropped its 2101.5 mm² outline and kept a 1097.1 mm²
  sub-loop as the face.
- Consuming vertices only on close: a chain entering a cycle it did not start on then runs to the
  100000-iteration guard. `chair-seat-center` patch 0 is the **default** patch, hit on every chair
  load, and went from under 2 ms to 317 ms, emitting 1.6 M points of garbage; `wheel-half` patch 2
  went to 2162 ms.

**What closing it takes.** Key the walk by directed edge rather than by vertex, so a pinch vertex
keeps one outgoing edge per loop, and pair incoming with outgoing by angle around that vertex so
the loops are separated the way the geometry actually runs. A per-walk visited set merged into the
global one only on close, so a failed walk consumes nothing and cannot spin. Then decide what a
patch with no closed ring should do: today it yields a boundary that is wrong rather than absent,
and callers only ask whether a face was detected at all.

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

## Numeric coercion has no lint rule

Numeric input guards are enforced by lint and CI in part, not in full. What
holds and what does not:

**Enforced.** `strict: true`, plus the five type-aware
`@typescript-eslint/no-unsafe-*` rules on `src/**/*.ts`. Those caught 12 real
cases of untrusted input reaching typed state, all fixed. ESLint's built-in
`radix` rule also catches a `parseInt` with no base. The one site it found reads
an app-generated `<select>` value, so it was latent, not live.

**Not enforced.** `parseFloat` / `Number` / unary `+` coercion. No lint rule in
the current plugin ecosystem covers the pattern, and a custom parser rule was
ruled out as too much machinery for one check. Nothing catches a `parseFloat`
whose `NaN` is never guarded.

Counted 2026-08-28 (`grep -rn parseFloat src/ | wc -l`): of 9 `parseFloat` sites in `src/`, **0** parse an
external number with no finite check. The last two were guarded in the same pass that closed this
count: `parsePathD` (`svg/path.ts`) never throws; on a malformed coordinate it drops the subpath it
was building whole (token misalignment makes anything after that point unrecoverable, and closing
a truncated loop into a shape the artist never drew would be worse) and keeps every subpath already
closed, and `parseSVGDocument` (`svg/parse.ts`) warns naming which `<path>` it was — a per-document
count, since two malformed paths would otherwise collapse into one warning under `warn()`'s
exact-message dedup, which is also why the sibling gradient/pattern-fill warning in the same
function now names its element the same way. The new `parseFillOpacity` helper (`svg/parse.ts`)
falls back to the SVG default (fully opaque) instead of an unguarded NaN. Every remaining site
guards, most on the next line, so the exposure is narrower than the call count suggests. Count the
guards, not the calls. One of them, `ui/partPanel.ts:208`, guards against a value it parses from an
authored `min=` attribute rather than from anything a user types, and a non-numeric one there would
reject every input; that is a latent bug in the markup, not in the guard.

**Also not enforced.** `noUncheckedIndexedAccess`, measured at **2240 errors**
on `main` @ 04c2c81. Enabling it is a real project, not a flag flip.

**Closing it** would take either a custom ESLint rule for the coercion pattern,
or a convention that all external numbers land through one parsing helper that
the type system can then police.

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

## `parseFillOpacity` reads a percentage and an out-of-range value wrong, and three attempts to fix it each broke something else

`parseFillOpacity` (`svg/parse.ts`) is `parseFloat` plus a finite check. Two
values it gets wrong, measured 2026-08-28 with a throwaway jsdom vitest file
that imported the shipped function and printed it against each input:

| Input  | Returns | Should be | Why it matters                                  |
| ------ | ------- | --------- | ----------------------------------------------- |
| `50%`  | 50      | 0.5       | inert today: the sole reader tests `=== 0`      |
| `0%`   | 0       | 0         | correct by luck                                 |
| `-1`   | -1      | 0         | imports opaque; the spec clamps `<alpha-value>` |
| `-50%` | -50     | 0         | same                                            |
| `150%` | 150     | 1         | inert today                                     |

The sole reader is `else if (opacity === 0)` in `parseSVGDocument`, so only the
`-1` / `-50%` rows change what ships: a shape the artist hid comes in as a
visible color and costs an AMS slot.

**Cut under CLAUDE.md's second-repeat rule**, on the branch that fixed the arc
tokenizer. Three `/code-review` rounds each found a defect in the previous
round's fix to this one function:

| Round | The fix it reviewed         | What it found                                                                                                       |
| ----- | --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1     | `%` handling                | no clamp, so `-1` still imported opaque — the thing the whole change was for                                        |
| 3     | `%` handling plus the clamp | `endsWith('%')` and `parseFloat` disagree where the number ends: `50% !important` clamped 50 to 1                   |
| 4     | anchored regex              | that anchoring made `0 !important` fall back to opaque, so a hidden shape imported as a **visible** one, no warning |

Round 4's defect is strictly worse than the bug being fixed, and it was
introduced by round 3's fix to round 1's fix. The function shipped unchanged.

**Closing it** needs the CSS side settled first, not another patch here.
`parseClassRules` and `getInlineStyleProp` (`svg/parse.ts`) do not strip
`!important` from any declaration, so every consumer of a class-rule value has
the same trailing-text problem and `fill-opacity` is only where it was noticed.
Strip it once at the resolver, then this function is a two-line clamp with no
string parsing in it.

## `display="none"` on a group does not hide the shapes inside it

`parseSVGDocument` (`svg/parse.ts`) resolves `display` per element, and `walk`
recurses into children regardless, so the flag is never inherited. CSS removes
the whole subtree. This removes only the element carrying the attribute.

Measured 2026-08-30 with a throwaway jsdom vitest file that called
`parseSVGDocument` on a hidden group plus one visible `<rect>`, and printed
`out.shapes.length`:

| Document                                                     | Shapes imported | Should be |
| ------------------------------------------------------------ | --------------- | --------- |
| `<g display="none"><rect …/></g>` + a visible `<rect>`       | 2               | 1         |
| `<g style="display:none"><rect …/></g>` + a visible `<rect>` | 2               | 1         |

A hidden Inkscape or Illustrator layer is exactly this markup. The artwork the
user hid is inlaid into the print and costs an AMS slot.

Found by `/code-review` on the branch that fixed the warning numbers next to
it, and not fixed there because the fix needs a decision first.

**Closing it** is two lines in `walk`: pass the resolved flag down and or it
with the element's own. The open question is whether a hidden layer vanishing
is silent. `fill-opacity="0"` on one shape is silent on purpose, for the reason
in the comment on that branch. A whole hidden layer is a lot more artwork to
drop with nothing said, and CLAUDE.md code rule 1 wants a named warning for it.
