# Tech debt

Deferred work, known-wrong behavior, and measurements worth not re-taking. One
section per item, each stating what was measured, why it was deferred, and
what closing it would take. Update the relevant section instead of
re-deriving the number from scratch.

## The browser-driven checks are only fast if Chromium finds a real GPU, and on WSL2 it does not find one by itself

Falling back to SwiftShader costs
roughly 300ms per frame, which also caps `requestAnimationFrame` near 2.5fps
and so stretches anything frame-paced. Driving the chair end-to-end takes
**~104s** software versus **~12s** with hardware acceleration, on the same
machine. The hardware is reachable — `/dev/dxg` plus Mesa's d3d12 gallium
driver in `/usr/lib/wsl/lib` — but selecting it needs
`GALLIUM_DRIVER=d3d12` in the environment _and_ `--use-gl=angle
--use-angle=gl-egl` on the command line;
`MESA_LOADER_DRIVER_OVERRIDE` alone silently leaves you on llvmpipe, which is
also software. [scripts/lib/harness.mjs](../scripts/lib/harness.mjs) does this
behind `MOSAIC_GPU=1`, opt-in rather than automatic because CI's Playwright
container has no GPU at all. Asking for it and not getting it is an error,
not a slow run: with the flag set, the harness reads the GL renderer string
once per browser, prints it, and refuses to continue if it names SwiftShader
or llvmpipe — a silent fall back to software is exactly what made this hard
to diagnose the first time.
What's left: nothing required, but the flags are Chromium/WSL-specific and
will need revisiting if either the container image or the WSL graphics stack
changes.

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

## The caster mounts have no design zone, and settling that means settling what the "central rear brace" is

They are absent from
[scripts/zone-configs/chair-body.json](../scripts/zone-configs/chair-body.json)'s
part list — the other eleven pieces are all in it — on the call recorded in
[docs/chair-body-plan.md](../docs/chair-body-plan.md) that "caster mounts and
wheel mounts are structural-only". That call was already revised for half of
it: the wheel mounts now carry `left`, `right`, and `seat`. The casters are
decoratable too (10,395 mm² of flat upward face at y = 120, the same in both
variants), so this is worth revisiting.
What makes it more than adding four lines to the config: that file's `_note`
reserves a volume for "the central rear brace in the CAD assembly ... the app
has no part for it, so a zone must never grow onto it", and the bounds it
quotes (x −90..90, y 92..186, z −663..−455) are exactly the two caster
mounts' combined bounding box (x −89.9..89.9, y 92..185.6, z −662.5..−454.9,
the note's numbers rounded outward). Either the note is describing the
casters — in which case the 1.008 mm gap it protects is the gap _to_ them,
and raising `seamWeldTolMm` past it would grow a neighbouring zone onto them
as intended — or there really is an unshipped brace inside that same volume
and the note stands as written. Resolve that against the CAD assembly before
touching the tolerance, because it is the tolerance the existing five zones'
measured coverage was tuned against; changing it re-bakes all of them.

## Rebuild performance needs ongoing work — this is a heavy application

A dense 135-path SVG still takes ~13s to rebuild in flat mode, ~9s of
which is the paint-order boolean pass in
[src/geometry/regions.ts](../src/geometry/regions.ts)
(`computeNetRegionsByColor`). The rebuild is already cooperative (yields to
the browser, live progress %) and the flat union phases use balanced tree
merging (~3x faster than the old left-fold), so the tab never freezes —
but the compute floor is still high. Measured leads for a follow-up, best
first: (1) call the `polygon-clipping` engine directly with n-ary
union/difference (one sweep instead of dozens of pairwise ops — but it
bypasses Turf's wrappers, so the safeUnion/safeDiff fallback machinery
needs care); (2) move the boolean pass into a Web Worker (doesn't reduce
compute, makes the wait invisible). Dead end, already measured: bbox
pre-filtered per-shape diffs benchmarked ~2x SLOWER than the accumulator
on real artwork (full-canvas backgrounds overlap everything) — see the
comment on `computeNetRegionsByColor`.

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
chair's zones carry hundreds of thousands of triangles (see the "1.7 MB raw"
sidecar-size section below). See the next section for the interaction
consequence.

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

## The long assembly-mode rebuild has no cancel, and until session persistence lands the only escape destroys the work

`#loading-overlay` (the "Rebuilding geometry…" curtain, `src/ui/overlay.ts`)
has no cancel or back control at any point in the 405.6s / >900s runs
measured above (the 405.6s figure is itself superseded — see the note just
above this section — but the argument holds at the re-measured 93.6s too:
a rebuild that long with no cancel is still the problem) — a user who starts
the wrong rebuild (wrong pattern, wrong zone scope) has to wait it out. Today the only way to interrupt it is a
reload, which — until the session-durability fix lands (tracked as work,
not tech debt; see the plan that added this section) — erases every setting
in the session. That combination is what turns "this is slow" into "this
tool lost my afternoon" for the vision-lens review that measured it.
Persistence removes the second half (a reload becomes recoverable instead of
catastrophic) but not the first: there is still no way to abort a running
rebuild and get the UI back without waiting or losing the in-flight state.
Closing this needs either an `AbortController` threaded through the
CSG/triangulation pipeline (`src/geometry/assembly.ts`,
`src/app/rebuild.ts`) or moving the pipeline off the main thread so a cancel
can just discard the worker — the same Web Worker move already listed above
as a lead for the flat-mode case would likely serve both.

## Auto-merge is a similarity control; the user's actual constraint is a slot count

The slider (`None`/`Slight`/`Medium`/`Strong` — `src/ui/colorList.ts`,
`initColorListPanel`) walks a ΔE similarity threshold, merging colors that
look alike. Measured against a real 7-color volunteer SVG on the chair,
2026-08-02: `None` → 7 AMS slots, `Slight` (the default) → 7, `Medium` → 7,
`Strong` → 6. The audience's actual question — per
[docs/audience.md](audience.md) — is "I have a 4-slot AMS Lite, make this
fit," a target-count constraint, not a similarity tolerance. The near-term
fix landing now (see the plan that added this section) reconciles the
computed slot count against the selected printer's capacity and warns when
it's over, which makes the mismatch visible; it does not change what the
slider controls. Closing this properly means re-deriving the ΔE thresholds
against a wider sample of real volunteer SVGs and either replacing the
aggressiveness slider with a "fit N slots" input that binary-searches a
threshold, or adding one alongside it. Needs real artwork to tune against,
not just the one measured sample — that's the reason it's deferred rather
than done alongside the reconciliation warning.

## The export button doesn't say what it's about to produce

Confirmed on the chair, 2026-08-02: "Export print-ready 3MF" produced a
35.8 MB, 11-plate, 13-object, 5-filament file with zero on-screen summary
before or after — the app's state is byte-for-byte identical pre- and
post-export. That's a multi-day, multi-kilogram print represented as a
single unlabeled button. The zone-coverage warning and AMS-capacity check
landing now (see the plan that added this section) surface two of the
numbers that matter at export time, but not the full picture — plate count,
per-plate part list, filament colors. Closing this means a pre-export
summary card reading the same `getLastAssemblyBuild()` /
`built.partOutputs` data `exportPrintReady3MF` (`src/ui/exportPanel.ts`)
already has in hand; it's a presentation layer on data that already exists,
not a new computation.

## Three shape-kind panels ship fully wired but are permanently unreachable from the UI

`rect`, `round`, and `stl` (`src/state/store.ts`'s `ShapeKind`) are excluded
from the part dropdown on purpose —
`renderShapeKindOptions()` in [src/ui/partPanel.ts](../src/ui/partPanel.ts)
carries the comment explaining why ("picking a real part shouldn't require
navigating a second nested dropdown"). Confirmed deliberate, not orphaned,
by the `assumptions`-lens review, 2026-08-02, and it's the right call for
the current audience. Recorded here only so the next person who finds three
complete, exercised-by-tests, never-rendered UI panels in the bundle knows
it's a maintenance question (why keep them building and passing tests if
nothing reaches them) rather than a sign something broke. No action needed
unless a future part genuinely wants a rect/round/plate flat mode again, at
which point the dropdown gate is the one line to touch.

## Four open defects in the chair / pattern-library workflow

Named by the maintainer on 2026-08-05 as the reasons both features were briefly
withheld from the UI (PR #133, since undone — both are offered again).
**The defects are not fixed**; only the hiding was undone. They are graded
against the shipped data below: the report is the maintainer's, the diagnosis
is not, and where the cause is confirmed it says so.

1. **The front of the fender gets no coverage — confirmed.** The wings (the
   "fenders") are reached only by `left` and `right`, which seed on the flank
   at `maxAngleDeg: 45`
   ([scripts/zone-configs/chair-body.json](../scripts/zone-configs/chair-body.json)).
   The `front` zone's charts cover `storage-*`, `handle-*` and `seat-back-*`
   and **no wing at all**, so the forward-facing fender face falls outside
   every zone and takes no artwork. Note
   [chair-body-plan.md](chair-body-plan.md) records dropping the planned
   separate `wing-left`/`wing-right` zones as unnecessary, on the finding that
   seeding on the fender reaches the same triangles as seeding on the storage
   side — true for the flank, but that reasoning never covered the front face.
   Closing it is either a wider `front`, a raised `left`/`right`
   `maxAngleDeg`, or reinstating the dropped wing zones; all three re-bake and
   re-tune every zone against the coverage-vs-stretch knee the `_note` warns
   about.

2. **Dead zones still need defining — open.** It is written up in
   [roadmap.md](roadmap.md) ("Dead zones: mark the parts of a design zone that
   are hidden by an adjacent part"). Without it a design placed across a joint
   spends filament changes on surface nobody sees.

3. **Jagged, non-smooth edges in the viewport — cause confirmed, and it is two
   defects.** The shading half is not chair-specific and has its own section
   directly below ("Every part in the viewport is flat-shaded"). The other
   half — **"they cut off"** — is a framing defect, not a shading one: a
   1600x1100 headless capture of `?kind=chair-body` has the wings and caster
   mounts running off the bottom edge of the canvas. The initial framing does
   not fit the chair's bounds. Worth checking against the kind's
   `displayFrame`, since the chair is the only kind that authors one.

4. **The SVG templates have odd/wrong edges — confirmed, same root as the cut
   outline.** Every shipped template in `public/templates/` is a pure `L`
   polyline with no curve commands: the zone boundary is traced along mesh
   triangle edges and emitted vertex-for-vertex. So a template's outline is as
   faceted as the tessellation under it. Two of them are also very ragged
   rather than merely faceted — `back` carries a 355-point boundary with **18
   holes**, `front` 146 points with 3 — which is what a grown-region boundary
   looks like when it stops mid-surface, and is the same boundary the cut
   clips to. Note the repo already has curve fitting for the raster tracer
   (`src/raster/curve.ts`); nothing equivalent runs on a zone boundary.

Longer-standing defects against the same two features, each with its own
section below: "Artwork can't wrap unbroken from one flank around the back to
the other" (three measured dead ends), "The chair's zone sidecar is 1.7 MB
raw", "The caster mounts have no design zone", "Zone picking has no occlusion
test", "Zebra + Fill still loses one color on Handle (left)", and "Turf's tile
union has a vertex ceiling, and nothing enforces it at runtime".

**Infrastructure left behind by the hide, deliberately kept.** `AssemblyKind.hidden`
still works, `renderShapeKindOptions()` still lists a hidden kind while it is
the selected one (so `?kind=` can reach one without the select rendering
blank), and `savedSessionIsOnHiddenKind()` in
[src/state/persist.ts](../src/state/persist.ts) still stops the empty-snapshot
clear from silently deleting a saved session on a hidden part. Nothing is
hidden today, so `tests/persist-hidden-kind.test.ts` marks a kind hidden for
the duration of a test rather than looking for one — driving it off whatever
happens to carry `hidden` is what made it go quiet the moment the chair was
unhidden.

## Every part in the viewport is flat-shaded, and this is not chair-only

Found 2026-08-05 while grading the chair complaints above, but it is **not**
specific to the chair — it applies to the wheel and the footrest too.

`bufferGeometryFromTris()` in [src/app/rebuild.ts](../src/app/rebuild.ts) is
the single path every displayed part mesh goes through — raw assembly parts
(`renderRawAssemblyParts`), cut bodies, and inlay soups all call it. It sets
only a `position` attribute from a flat triangle-soup `Float32Array`, never
calls `setIndex`, and then calls `computeVertexNormals()`. On non-indexed
geometry three.js gives every vertex its own face's normal, so the result is
flat shading by construction. `src/scene/zonePick.ts` is the only place in
`src/` that indexes a geometry, and that mesh is invisible.

Consequence is cosmetic but pervasive: curved surfaces band, and silhouettes
read as polygonal. It is worst on the chair (large, curved, 368k triangles)
and mild on the wheel, whose design face is nearly flat — which is likely why
it went unnoticed until a big curved part existed.

Nothing about export changes: this is the three.js display mesh only, built
from geometry that has already been cut. The cut/export path never reads these
normals.

What closing it would take: index the geometry before computing normals —
`BufferGeometryUtils.mergeVertices()` is the direct route, and it also cuts
vertex count on meshes that currently repeat every shared vertex three times,
so it may pay for itself in the 368k-triangle case. The open question is
whether a blanket merge rounds off intentionally sharp edges (a chamfer, a
pocket wall) into smooth ones, which would trade one wrong look for another;
a normal-angle threshold is the usual answer and needs measuring against a
real part rather than assumed.

Not to be confused with the separate framing defect recorded in the chair
section above — the chair rendering off the bottom of the canvas is a camera
fit problem, not a shading one.

## The help dialog's open state doesn't track browser back-navigation

Opening Help, clicking a table-of-contents anchor (`#h-export` etc.), then
pressing the browser Back button returns the URL to `/` but leaves the
`<dialog>` open — cosmetic, not functional (`edge-cases`-lens review,
2026-08-02). Low priority; fix would be a `popstate` listener that closes
the dialog when the hash it opened on disappears.

## Region computation is O(n²·len) per path

([regions.ts:357](../src/geometry/regions.ts#L357), `shapes.map(shapeToFeature)`,
before the first yield) — `shapeToFeature`'s containment-depth resolution
tests every subpath ring against every other ring with a point-in-polygon
scan. Benchmarked against production/sample SVGs
([scripts/bench-shape-to-feature.ts](../scripts/bench-shape-to-feature.ts)):
worst real-world case measured 5.88 ms (`public/patterns/zebra.svg`, a
single 69-subpath path), an order of magnitude under the 30 ms yield
budget — not a live issue on any file currently in use. Risk case is a
dense Illustrator export (hundreds of subpaths in one `<path>`, e.g.
fur/stipple line art) that no current sample exercises. Revisit if/when
such a file is actually encountered, rather than guessing a threshold now.
A separate, far more extreme case — thousands of nested rings or `<g>`
elements deep enough to overflow the JS call stack — fails with a named
"unusually deeply nested" error instead of a raw stack-overflow message,
but still isn't depth-limited; see `shapeToFeature` and `walk` in
[regions.ts](../src/geometry/regions.ts) and [parse.ts](../src/svg/parse.ts).

**Raster tracing is the first producer that could plausibly hit this**, and is
held off it by the despeckle floor rather than by luck. Measured with
[scripts/bench-raster.ts](../scripts/bench-raster.ts) at 512px, 8 colors: the
worst single shape carries ~23 rings and costs ~5 ms, against zebra's 69/5.88 ms
— so grouping shapes per color, which piles every ring of one color into one
shape, stays comfortably inside the budget. `MAX_COMPONENTS` (800,
[trace.ts](../src/raster/trace.ts)) is what guarantees it: exceed it and the
floor is raised to exactly the area that fits and the image re-traced. If that
cap is ever raised or the floor lowered, re-run the bench — this is the number
that keeps the quadratic term small, and the failure mode is a frozen tab, since
`shapes.map(shapeToFeature)` runs before the first yield.

## Raster shape granularity was settled by measurement, and the losing option is still reachable

Traced components can be grouped one shape per color or one per connected
component ([`ShapeGranularity`](../src/raster/parse.ts)), and the two costs pull
opposite ways: per-color risks `shapeToFeature`'s O(rings²·len) _within_ a shape,
per-component multiplies the paint-order boolean pass by shape count. Measured
(`scripts/bench-raster.ts`, 512px photographic source): per-color ~830 ms total
against per-component ~1590 ms, the difference almost entirely in the boolean
pass (136 ms vs 1055 ms). Per-color ships.

Worth knowing for anyone revisiting it: traced regions are **disjoint by
construction**, so every `safeDiff` in that pass is provably a no-op. A
`disjoint` fast path on `computeNetRegionsByColor` would collapse it to array
concatenation and make per-component viable — and would also cut the per-color
path's 136 ms. It was left unbuilt because the measurement above says nothing
needs it: at 8 shapes the pass is not where the time goes. Build it only if the
component cap is ever raised enough to change that.

## The raster photo-vs-flat-art thresholds are shaped right but calibrated against synthetic images

`FLAT_EDGE_DENSITY` / `PHOTO_EDGE_DENSITY` in
[src/raster/stats.ts](../src/raster/stats.ts) (0.12 and 0.45) decide how much
blur and despeckling an image gets, interpolating between so nothing falls off a
cliff. The statistic is sound — flat art puts its transitions on thin outlines
around large constant fields, a photograph has one nearly everywhere, and
`tests/raster-parse.test.ts` pins that separation — but the two endpoints were
placed from procedurally generated sources, not from a corpus of real files.

Closing it: record `measureImage().edgeDensity` for a real set — the shipped
`public/patterns/*.svg` and `public/assets/makegood-logo.png` rasterized, several
phone photos, one quality-40 JPEG (block artifacts must not read as flat), and
the genuinely hard middle: a UI screenshot, a scanned crayon drawing, a
gradient-heavy illustration. Confirm the flat and photo clusters are separated by
a gap and put the endpoints inside it. A screenshot landing on the photo side
would be the bug to watch for. If the clusters overlap, the statistic itself is
wrong and wants replacing rather than retuning.

## Curve fitting rounds small corners, and two components can overlap by up to a working pixel

Fitting rounds a corner it doesn't judge sharp, and "sharp" is scale-dependent: Potrace's corner
measure works out to about `side/2` for a square, which has to clear 4 at the default `alphaMax`,
so corners survive from roughly nine pixels a side upward and round below that. A feature a few
pixels across therefore comes back a few percent smaller. That part is cosmetic and unchanged.

**A more serious failure existed and is fixed, 2026-08-04.** The straightness cone carries half a
pixel of slack at each bound, and for a feature thin enough — a one-pixel-wide stroke turning a
corner, a shallow diagonal, a zigzag, a single-pixel checkerboard cell — the whole boundary can stay
inside that slack and read as one straight run. The fitted polygon then collapses under three
points, and the ring was dropped outright: a 2:1 diagonal stroke lost 93 of its 95 segments, a
zigzag lost half its length, and the 4x4 checkerboard fixture lost about a third of its area. This
was not shrinkage, it was deletion, and the closed-chain-only guard in
[curve.ts](../src/raster/curve.ts) (`MIN_AREA_RATIO`, 0.85 — restores a 30x1 bar to exactly its pixel
area) never saw it, since none of these are closed chains.

`unfitCollapsedChains` in [trace.ts](../src/raster/trace.ts) closes it at the right grain: it checks
area per **component**, which is the smallest thing that has one, then drops back to lattice points
per **chain**, which is the thing shared between two components — unfitting only the starved side
would desync a boundary from its neighbour and open exactly the sliver the shared-chain design
exists to prevent. Re-measured after the fix: the diagonal, the zigzag, and the checkerboard all
recover their exact pixel area (`tests/raster-trace.test.ts` pins the checkerboard case at 16.000,
not the ~third-short figure this entry used to cite).

**What is not fixed, and can't be from this angle:** two components can still overlap by up to one
working pixel. Chains are byte-identical on the two sides of the boundary they're shared between,
but nothing bounds how far a fitted chain strays from the lattice path it replaces, so it can sweep
across a third region it shares no chain with. Re-measured over 3000 random label grids after the
above fix: worst overlap is still 1.000000 unit², unchanged — `unfitCollapsedChains` catches area
loss, not this. Downstream it's absorbed: paint order in `computeNetRegionsByColor` subtracts
cross-colour overlap outright, and two components of one colour land in the same shape and get
unioned. `tests/raster-trace.test.ts` pins the bound rather than asserting zero.

A bound on chain deviation was tried and rejected: it cannot be set. A 45° staircase's lattice
corners sit 0.707px off their own chord and a 3:1 staircase's sit 0.949px off, both legitimate, while
the chains that misbehave measure about 0.97 — there is no threshold separating them.

How much the remaining overlap matters in practice: on the 512px photograph path a one-pixel overlap
is 0.54mm, at or under the nozzle width. Flat art now works at 1024px, which _halves_ that to
0.27mm, comfortably under a 0.4mm nozzle — the point at which this stops being a fidelity question at
all. Closing it properly means a fit that never strays from the lattice path by more than the
adjacent regions can tolerate, most likely by recognising digital straight segments (the arithmetic
characterisation) instead of Potrace's cone, which does not have the half-pixel slack that causes
this. Worth doing only if it shows up as a visible artifact in practice; measure before building.

## Colors is the one trace control still fixed, and no single value suits real artwork

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

The region count is a usable signal for choosing it automatically. Across the corpus, each step up
in palette size multiplies regions by 1.2x-2x, except where the surplus starts landing on fringe:
the logo's 4 -> 6 step multiplies them by 6.5x. A knee detector over that curve would pick the
palette size the way the other three parameters are already picked, and would suit both a
three-colour logo and a nine-colour cartoon without the user touching a slider.

What closing it needs: a decision on where to run the search (re-quantizing at several k costs one
quantize pass each, which the bench puts at tens of milliseconds), and a check that the knee is
stable on photographs, where region growth is smoother and the signal weakest.

## The trace parameters are calibrated against a downscale that is no longer constant

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
1588px one that was halved, and neither is the case the endpoints were tuned for. Closing it means
deriving blur from the realised downscale ratio — the decoder knows both sizes — and re-tuning the
flat endpoint against sources at several scales rather than the one that prompted this.

## The curve-fit constants are reasoned, not measured against a corpus

`alphaMax` and `flatness` in [src/raster/stats.ts](../src/raster/stats.ts) replaced the old RDP
`simplifyTol` when tracing moved to sub-pixel curve fitting. The flat-art endpoints (`alphaMax`
1.0, `flatness` 0.25px) and photo endpoints (1.2, 0.4px) were picked from what each parameter
means — 1.0 is the long-standing Potrace default, `4/3` is where the corner test stops rejecting
anything, and a quarter-pixel flattening tolerance is well inside what the 0.4mm nozzle can
express — and then checked on the synthetic bench sources plus a single real one (a 1588x1176
flat-art cartoon, kept in the gitignored `stubs/`, so not reproducible from a clean checkout).
That is the same weakness the edge-density thresholds have, one section down: the shape is right,
the numbers have not been swept.

Closing it: sweep `alphaMax` across 0.8–1.334 and `flatness` across 0.1–0.6 on a corpus with
known-correct answers — a logo whose corners are genuinely square, a scanned drawing, a photo —
and record where corners start rounding off and where point counts start climbing without a
visible improvement. The two failure directions are asymmetric and worth naming: too low an
`alphaMax` gives a faceted arc, too high rounds a square logo's corners, and only the second is
obvious in a preview. `FLATNESS_MIN` is a performance guard rather than a taste one — it stops a
full-right Detail slider turning a sub-pixel tolerance into a ring-length explosion, which
`shapeToFeature` is quadratic in.

## The raster despeckle floor is a fraction of image area, not a printable size

[src/raster/stats.ts](../src/raster/stats.ts) expresses it as a fraction of the
working image so it means the same thing at any input resolution — but the raster
stage never learns how large the part is, so it cannot express the floor as the
thing that actually matters: a feature smaller than roughly one nozzle width will
not print however the image was scaled. At the current numbers a 512px image
auto-fit to an 80mm face puts the photo-strength floor near 0.6mm, which is about
right, but that is a coincidence of two independent constants rather than a
derivation. Closing it means threading the resolved mm-per-unit
(`designMmPerUnit`, [assembly.ts](../src/geometry/assembly.ts)) back into the
raster stage, which today runs strictly before placement is known.

## A loaded image is not part of the saved session

Session restore rebuilds each source by re-parsing its saved SVG text
([persist.ts](../src/state/persist.ts)), and an image has none — it came from
pixels. Persisting the pixels instead was measured and rejected: one decoded
512px image is ~1 MB before JSON encoding, against a `MAX_BYTES` ceiling of 4 MB
for the whole session, so two or three images would blow it and take the SVG
half of the session down with them. Flat art now decodes at 1024px, four times
the pixels, so a single one would fill that ceiling on its own — the case
against persisting them got stronger, not weaker.

So a raster source and its placements are skipped on save. Consequences worth
knowing before changing this:

- A session whose _only_ design is an image saves nothing at all and offers no
  restore banner. It must not save an empty-but-valid session instead: the
  banner shows for anything that parses, and would offer to restore "the Disc"
  with no designs. `saveSession()` decides this from the snapshot, not from
  `hasLoadedWork()` — the two deliberately disagree here.
- That same session reports a _failed_ save to the beforeunload guard, which is
  what makes leaving the tab prompt. This is the one case where the guard fires
  without a storage error, and it is correct: the work really is unrecoverable.
- A mixed SVG + image session saves and restores the SVG half silently, losing
  the image with no prompt. Warning on it would mean nagging on every mixed
  session, so it is documented in the README instead.

Closing it means storing the encoded source file (the original PNG bytes, not
the decoded pixels) plus the Colors/Detail settings, and re-running decode +
quantize + trace on restore — cheaper to store, but it moves a multi-second
raster stage into the restore path, which today does no image work at all.

## The chair's zone sidecar is 1.7 MB raw / 638 KB gzipped

(`public/stl/chair-body-zones.json`), up from 125 KB gzipped when each zone
stopped at one part. Zones that span the whole chair simply carry more
triangles. Measured composition: 41% `chartTris`, 30% `uv`, 16% `tris`, 9%
`verts` — so it is mostly index arrays, and rounding the UVs buys little.
The real fix is delta-encoding the index arrays and/or a binary format;
brotli alone would take it to 349 KB if the host serves it. Not urgent (it
loads async, after first paint, and only for the chair) but it is the
largest asset in the app. Don't quantise UVs below ~0.01 mm to chase this:
two chart vertices closer than the quantum would collapse into a
degenerate UV triangle and the warp's barycentric lookup divides by its
area.

## `CHART_SNAP_MM` tracks a bake artifact instead of guarding placement

A
part's baked claim on a zone (`subRegions`) is slightly more generous than the
triangulation inside it, so the claim outline pokes narrow tendrils past the
end of the chart. Cutter vertices landing in one are legitimate artwork with
no triangle under them, so the snap tolerance has to be wide enough to absorb
the deepest one — 2.150 mm on the shipped bake — which is why it is 3 mm
rather than the sub-millimetre value a pure misplacement guard would want.
Fix: re-bake so each claim matches its triangulation, then tighten the
constant. Deferred because it invalidates every downloaded template and the
sidecar. Until then `tests/chair-zones.test.ts` pins the measured worst case;
**measure it by hill-climbing, not by rastering** — the depth is a distance
function, so a step-_h_ grid under-reports the peak by up to _h_/√2, and a
1 mm raster put the worst at 1.915 mm against a true 2.150 mm.

## A seam sliver warns as if artwork were lost

Where two parts' claims on
a zone overlap, clipping a color to one part's `subRegions` can leave a
remnant a fraction of a millimetre wide. It survives the turf clip, then
yields no cutter, and
[src/geometry/assembly.ts](../src/geometry/assembly.ts) reports "Couldn't build
the cut solid for color … on …" — alarming, and indistinguishable from the
real failure it shares a message with. The overlaps are inherent to per-part
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

## Artwork can't wrap unbroken from one flank around the back to the other, and three ways of fixing it are measured dead ends

The chair carries `left`, `right` and `back` as three zones, so a design
placed on one stops at the zone boundary. Two approaches were prototyped and
measured against the shipped bake; both lose, for different reasons, and the
numbers are recorded here so nobody re-derives them.

**A cylindrical band** (unwrap left→back→right about the chair's vertical
axis, like a label on a bottle). The geometry cooperates in one respect: a θ
histogram over the three zones' 35,320 triangles shows a **64°-wide empty
sector centred on +Z**, the chair's front opening, so the wrap seam lands
where there is no surface. The best-fit axis is x −0.26 (on the centreline,
as symmetry demands), z −297.27, with an area-weighted mean radius R₀ of
231.29 mm. But the chair is not a cylinder: only **39.8%** of the band lies
within ±10% of R₀ and per-part radii run 0.73–1.62 × R₀. Real per-edge
stretch, measured with the same metric `orientChart` reports, at a 45°
outward limit: **max 2.113, mean 1.0800, 27% of edges past the
`DISTORTION_WARN = 1.1` the bake already flags** — and that buys only
**69.6%** of the surface the three zones carry today. A radius-profile
variant (u = r̄(y)·θ) is far worse (max 11–16): r̄ changes too fast where the
wheel mounts give way to the storage boxes.

**One merged LSCM zone.** The standing objection to this — "the exterior
wraps into a U and `lscm` needs disk topology" — is **wrong**: the same 64°
gap means the band never closes, so it is a strip, and a strip is a disk. It
does unwrap, cleanly by every metric the bake reports: one island, **0
flipped triangles**, max stretch **1.540** / mean **1.0242** over 100% of the
surface (p99 is 1.152; only 2.14% of edges exceed 1.1), sidecar _smaller_ at
1675 KB. It still fails, on something the bake does not measure — **UV
injectivity**. LSCM is only locally conformal, so `flipped == 0` rules out
local inversion but not the chart folding onto itself globally. Chart area
covered by more than one triangle:

| zone                                  | self-overlap           |
| ------------------------------------- | ---------------------- |
| shipped `left` / `right` / `back`     | 0.11% / 0.04% / 0.03%  |
| `front` / `seat` (untouched controls) | 0.01% / 0.01%          |
| merged band                           | **4.85%** (15,976 mm²) |

On that 4.85%, `ConformalZoneMapper.lookup` finds two triangles and takes
whichever its grid search reaches first, so artwork cuts onto the wrong sheet
of surface — worse than the seam it removes. 91% of the overlap is _self_
overlap within four parts (the two handles and two storage boxes), not
part-against-part.

**There is no angle window between the two failures.** At the shipped
45/35/45 the band is connected and overlaps 4.85%; at 40/32/40 it is still
connected and still overlaps 4.58%, for 12% less surface; at 32/28/32
`assertSingleIsland` fails with 10,891 of 25,515 triangles reachable. Loose
enough to stay one island means it folds; tight enough not to fold means it
severs. The link between each flank and the back runs through the handle's
curved corner, which is both what forces the fold and what only survives at
loose angles.

**Cross-chart registration** — keep the three charts, but let one placement
span them by giving each chart a rigid offset into a shared band coordinate,
so continuity is carried across the boundary instead of by a single injective
unwrap. This is the option the two failures above leave open, and the one
that does not need the band to be a single chart at all.
The transform is real: the best-fit rigid UV motion from `left` to
`back` comes out at **−0.1° rotation, scale 1.0074, 1.26 mm rms** (`right`
0.0°, 1.0062, 1.26 mm), all comfortably inside `CHART_SNAP_MM` and plausibly
inside what the printed assembly delivers anyway.

It fails on the boundary, not the maths. `left` and `back` share **10
vertices** — two ~11 mm fillet arcs at y≈346 and y≈454 on one handle, about
22 mm of contact on zones spanning 500 mm of height. They share **zero**
vertices on the storage boxes, the largest flank surface, because that corner
turns **89.6°** (86.3° on the handle) while the two zones' limits sum to 80°:
there is a wedge of surface orientation neither zone accepts, ~28 cm² on the
storage box and ~92 cm² on the handle, and that unclaimed wedge is what keeps
them apart. Widening `back` 35°→45° so the limits sum past the corner
densifies the contact to 55–64 shared vertices and tightens the fit to
**0.97–1.03 mm rms**, but does not lengthen it by a millimetre: it stays
inside y 337–462 with **17 gaps over 8 mm** in it. A design registered across
that would flow through the handle posts and stop everywhere else — which
reads as broken, where today's clean stop reads as deliberate.

**Correction to the paragraph above: for a single zone, stretch binds long
before injectivity does.** Injectivity is the constraint on _merging_ zones,
not on widening one. Widening the flanks 45°→50°, measured against the
shipped bake:

| zone        | max stretch | mean stretch | UV self-overlap |
| ----------- | ----------- | ------------ | --------------- |
| `left` 45°  | 1.224       | 1.0142       | 0.11%           |
| `left` 50°  | **2.543**   | **1.2342**   | 0.06%           |
| `right` 45° | 1.226       | 1.0159       | 0.04%           |
| `right` 50° | **3.470**   | 1.1170       | 0.05%           |

Overlap stays clean at every setting; stretch doubles for 5°. So the config's
own coverage-against-stretch framing is right for the per-zone angles after
all — it is only the _three-way split_ that injectivity explains. Widening
`back` alone is likewise not the free win it looks like: 35°→45° adds 30% more
triangles but only **+5.4% area** (960 → 1012 cm², the extra triangles being
fillet detail) while max stretch goes 1.134 → 1.581.

What is left is a different parameterization family — cone-singularity methods
(BFF, OptCuts) rather than plain LSCM, aimed at low stretch under wide normal
spread. That is a substantially bigger change than any of the three
prototypes, and nothing today needs it: `left`/`right`/`back` at the shipped
angles are close to the best plain LSCM does on this geometry.

One latent bug found and deliberately **not** fixed: `classifyRegions` in
[scripts/lib/zonebake.mjs](../scripts/lib/zonebake.mjs) decides outer-vs-hole
by containment depth parity, which is right for nested SVG subpaths but wrong
for triangulation boundary loops — a concave part slice has solid lobes
sitting inside another loop's ring, and parity calls them holes. It cost the
merged zone 26% and 60% of the two handles' claims. Every shipped claim
matches its triangulation within 0.3%, so it does not affect the current
bake; classifying by winding sign instead is the fix if a future zone ever
trips it.

## Zone picking has no occlusion test

([src/scene/zonePick.ts](../src/scene/zonePick.ts)) — it raycasts only the
invisible chart meshes (three.js 0.160's `intersectObject` ignores
`visible`, which is what makes picking work at all), but the real bodies
aren't in the target list, so clicking a handle in front of a zone selects
the zone behind it. Fix: raycast the visible parts too and reject a zone hit
farther than the nearest solid hit. Gets worse as zones multiply — the chair
went from 4 to 5 with the full-coverage re-author.

This is a prerequisite for the roadmap idea of making zones clickable
_before_ artwork exists (see [docs/roadmap.md](roadmap.md)) — that flow puts
zone-picking in front of a first-time user instead of behind a load-then-
rebind step, so a wrong occlusion pick there is a first impression, not a
power-user edge case. Fix this before building that.

## A Fill under a sticker overlaps just like two stickers do, and isn't checked

The overlap check in
[src/geometry/designOverlap.ts](../src/geometry/designOverlap.ts) compares
two stickers by their placed footprints, and treats two Fills on one zone as
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
(2) Warn only where the fill's ink actually lies under the sticker, which
needs the placed regions rather than the bounding boxes this check uses.
Start by measuring (1) on the wheel, where the fill region is small enough
to time honestly.

## The design-overlap check compares rectangles, and the cascade step is a constant

Two limits of [src/geometry/designOverlap.ts](../src/geometry/designOverlap.ts)
that were traded away deliberately when it landed, both worth knowing before
trusting or extending it.

**It compares placed bounding boxes, not artwork.** So it answers "could these
cut into each other", not "do they". A design whose ink sits inside another's
hollow — a logo centered in a frame, a caption inside a border — reads as
fully covered and warns, while the recesses never touch and the export is
fine. The warning is worded to admit the approximation rather than assert the
failure, but there is no way for the user to clear that pill short of breaking
the composition. Making it exact means intersecting the two designs' real
per-color regions, which is the boolean cost the check was written to stay off
(see the rebuild-performance section); the cheap half-measure is to compare
each design's total ink area against its bounding box and skip the pair when
one is mostly hollow.

**The cascade step is a constant and the warn threshold is a fraction, so they
only meet above a certain design size.** Stepping a second design diagonally by
`INSTANCE_CASCADE_MM` (8mm) leaves two w×w designs covering ((w−d)/w)² of each
other, which crosses `OVERLAP_WARN_FRACTION` only for w ≥ d/(1−√fraction). At
the 0.25 this shipped with that was 16mm, so the app could cascade two 12mm
stickers into an 11% overlap and say nothing about geometry it had positioned
itself; the threshold is 0.10 now, which moves the line to ~11.7mm. It does not
remove it — a small enough design still gets cascaded into a silent
sub-threshold overlap. Closing it properly needs the step to scale with the
design's placed size rather than being a constant, which means knowing that
size at load time: `cascadedOffset` runs in `state/artwork.ts` with only the
seed offset in hand, while the placed quad is computed later in the assembly
build. Either thread the zone's placer back to load time, or move the cascade
into the build and let it adjust a placement it can actually measure.

## One warning covers three different failures

([src/geometry/assembly.ts](../src/geometry/assembly.ts)) — "Raise Scale to
fill the surface" is the advice whether `tileCoverage` refused on tile
count, non-invertibility, or non-affinity. It is right for the first and
misleading for the other two. Split the message per cause.

## A positive-but-thin depth stays a note, not a warning — considered and kept

A UX review (2026-08-03) recommended promoting the sub-`MIN_CUT_DEPTH_MM`
message from `ℹ` to `⚠`, on the grounds that it is the case which ships a
file printing _nothing visible_ — arguably a worse outcome than the
plate-clamp case that does get a `⚠`. That reasoning is sound as far as it
goes, and it was rejected on purpose.

The severity split is the whole point of the three-way resolve in
[src/geometry/depth.ts](../src/geometry/depth.ts): a depth of zero or less
says nothing about what was wanted and gets raised (a `⚠`, because a value
was overridden); a depth the plate can't hold gets clamped (a `⚠`, same
reason); a positive depth thinner than 0.2 mm is **honored exactly as
asked** and gets an `ℹ`, because nothing was overridden. Someone on a
0.08 mm layer-height profile cutting a 0.12 mm recess made a real choice,
and this audience knows their slicer — see
[audience.md](audience.md). Warning them about a value the app then obeys
is crying wolf, and a `⚠` would imply an intervention that didn't happen.

So the icon tracks _"did the app change your number?"_, not _"might you be
disappointed?"_ — which is the distinction that keeps the two `⚠`s
trustworthy.

What would change the answer: evidence that users hit this by accident
rather than by choice — e.g. a typo path where 0.02 is reached by
mis-typing 0.2. If that shows up, the better fix is still not a severity
bump but a value-shaped one (flag the specific 10×-off case), since
promoting the whole class re-breaks the fine-profile user.

## The per-color depth reset ("↺") stays beside its field — moving it was tried and rejected

The same UX review as the section above (2026-08-03) also recommended moving
the ↺ out of the middle of the depth row, where it sits 32 px from the field
it resets with the "mm" unit label in between, on the reasoning that this
groups it with the unit rather than with the field. It offered two
placements: adjacent to the input, or "the row's right edge as a consistent
slot".

The right-edge version was built and looked at in the running app, and
rejected: at the end of the row the ↺ reads as belonging to the filament hint
("≈ Red") and to the color, which it has nothing to do with. It is now back
where it was, and only its appearance changed (see below).

Two things were measured on the way, both worth not re-deriving:

- **The "consistent slot" argument was already satisfied.** Every element left
  of the ↺ — the `depth` label, the 76 px field, the `mm` span — is a fixed
  width, so its left edge is identical on every row: measured 168, 168, 168,
  168 px across a four-color list. It never shifted with the value's width.
  The rationale offered for moving it (and the one this repo briefly adopted)
  was simply wrong about the layout.
- **What made it hard to find was its appearance, not its position.** It was
  borderless, transparent, and `--text-dim` — the same three properties as the
  `depth` label, the `mm` unit, and the filament hint around it, and none of
  the properties of the real `.btn` in the row above. Giving it `.btn` chrome
  and a 24 px target fixed the finding the placement change was reaching for.

Rejected alternatives, so they aren't re-attempted: putting the unit inside
the field (`[2.40 mm]`) collides with Chrome's number-input spinners, which
this app does not suppress; putting the unit before the value (`depth mm
[2.40]`) reads wrongly, since a unit follows its number.

What would change the answer: a variable-width element appearing left of the ↺
in that row — a longer label, a per-row badge — which would break the fixed
column the first point relies on. Narrow-window and touch layouts were also
never checked for this row.

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

## Nothing benchmarks the geometry hot path on demand

The 5–10x figure above came from a one-off harness built for that upgrade
attempt and not kept. So the pin that decision produced is enforced by prose
and a `package.json` exact version — re-measuring it, or measuring anything
else on the union-accumulation path, means rebuilding the harness first.

Deliberately not built: a standing `bench-geometry` script would only be
exercised by an active turf upgrade, and there isn't one. The cost of writing
it now is real and the cost of re-deriving it later is roughly the same, so
this waits until a turf upgrade becomes live work — at which point it is step
one, not an afterthought. Closing it means a repeatable script over that hot
path at a few shape counts, with the 6.5.0 numbers above as the baseline to
beat.

## The export-placement seal proves a mesh hasn't changed, not that anyone re-verified it

`PART_FINGERPRINTS` is generated
([scripts/bake-part-fingerprints.mjs](../scripts/bake-part-fingerprints.mjs)),
and re-packing a part without resealing is caught loudly — the seal test
in [tests/placement.test.ts](../tests/placement.test.ts) fails. The gap is the
step after: resealing is a single command that will happily re-bless a mesh
whose print pose nobody re-checked in the slicer, which is exactly the
motion someone takes to make the failing test go away. It is deliberately
_not_ wired into `pack-part.mjs` for that reason (auto-resealing would
delete the tripwire), so the guarantee rests on the reminder that script
prints and on the add-part skill. Closing this properly means recording
_what_ was verified — the reference file and its hash — alongside the mesh
fingerprint, so a reseal against an unchanged reference is distinguishable
from one that silently redefines the verified pose.

## The things that check the code get audited less than the code they check

Five instances of one shape are now on record, four of them found on
2026-08-03:

- **`vite preview` served a `dist/` older than its own sources** (#123). Not a
  leftover process — a correctly started, freshly spawned server serving a
  build that predated the change under test. Every driven run read as passing
  while describing code no longer on disk.
- **`gh pr checks --watch` reported green on a run that had not started**
  (#125, hit on #124). Directly after `gh pr create` the checks are not yet
  registered, so gh prints "no checks reported" and exits 0 — the same exit
  code as a real pass.
- **`gh run watch` on the release deploy watched the _previous_ release's run.**
  The `release` skill resolved the run with `gh run list --limit 1` immediately
  after the tag push; until GitHub registers the new run, the newest one is the
  last release's — completed and successful — so the watch returned green in
  under a second. Found by auditing this section's own class after #125 landed,
  and confirmed against the live repo (watching v0.6.0's finished run exited 0
  instantly). The run is now pinned to the tag's commit and `headBranch`.
- **`#btn-export` staying enabled read as "the rebuild finished"** when it was
  still enabled from the _previous_ build, exporting stale geometry. Fixed
  earlier; the reasoning survives in `settledAfterRebuild()` in
  [scripts/lib/harness.mjs](../scripts/lib/harness.mjs).
- **The export-placement seal** — the section directly above — proves a mesh
  is unchanged, not that the pose was re-verified.

The common shape is a success signal derived from something adjacent to the
property being asserted, where the ambiguous case is indistinguishable from a
real pass at the point of use: same exit code, same enabled button, same green.

Worth being precise about the cause, because "be more careful" does not close
it. The same two files carry a thorough leftover-port guard and a hard error
when `MOSAIC_GPU=1` silently falls back to SwiftShader — both written to catch
exactly this kind of quiet wrong answer. The gap is not rigor. It is that code
gets reviewed and the things that check the code get trusted, so a checker that
under-verifies is the last place anyone looks.

No systematic audit has been done, but the first deliberate look paid: four of
the five were found by tripping over them, and the fifth came from grepping the
repo for every other `gh run`/`gh pr checks` invocation right after #125 landed.
That took minutes and turned up a worse instance than the one that prompted it —
a false green from the wrong commit, on the go-live action. Treat that as
evidence the remaining audit is worth doing, not as evidence it's now done.

Closing this means walking every place a success signal is derived indirectly
and either asserting the property itself or making the ambiguous case fail
loudly. Known starting points, none currently established as wrong:
`waitForServer()` accepts any HTTP 200 on the port as "our preview is
up"; `startPreview({ reuse: true })` deliberately trusts the caller about which
build is listening, and nothing verifies it; smoke's opening wait treats a
non-zero `#stat-tris` as "the right thing loaded".

## Per-part export placement is a lookup table in [src/export/placement.ts](../src/export/placement.ts), not part of the part definition

It used to be an `if (roleId === …) else if …` chain; the
chair's fifteen pieces turned that into a `PLACEMENT` record keyed by
library part id, so adding a part is now a data change rather than a code
one. It still lives apart from the role it describes, though — these are
per-part constants and belong as data on the `AssemblyKind` / role
definition, matching the "one array entry" goal in
[src/assembly/kinds.ts](../src/assembly/kinds.ts).

## The footrest's `objectSettings` literal is duplicated

The literal (`brim_type: 'no_brim'`, `enable_support: '0'`) is duplicated between the export path in
[src/export/placement.ts](../src/export/placement.ts) and its assertion in
[tests/threemf.test.ts](../tests/threemf.test.ts). Extract a shared
`FOOTREST_OBJECT_SETTINGS` constant so the test verifies the real value
instead of a hand-copied duplicate that can silently drift.

## The footrest's baked `FOOTREST_PLATE_R` is redundant

It's redundant with the general
`rotXthenZ(-90 * nsign, angleDeg)` path for `nsign: 0` + `rotZdeg: -45`
(see [src/export/threemf.ts](../src/export/threemf.ts)). It's kept as an
explicit full 3×3 for now because it generalizes to a future part with a
genuinely tilted reference pose that the axis-aligned path can't express —
revisit if that part never materializes.

## Rect placement derives one artwork scale from the largest face across all parts

([src/geometry/assembly.ts](../src/geometry/assembly.ts),
`buildAssemblyGeometry`) while `placeOnPart` honors each part's _own_ face
center. Harmless today — the only rect kind (footrest) has a single face —
but a future rect assembly mixing face sizes would scale artwork for the
biggest face and then center that same oversized artwork on the smaller
ones, where the face clip would crop it. Fix when such a part ships: either
scale per-part, or make the reference face an explicit choice on the
`AssemblyKind` rather than "whichever is largest". Note the resolver
(`designMmPerUnit`) now has two callers — the build and the on-face gizmo,
which shares it precisely so the selection frame matches the cut — so a fix
has to keep them agreeing rather than change one.

## The CSG failure branches: closed, and how to re-check them

**Closed.** This was open because the `CSG failure handling` tests in
[tests/assembly.test.ts](../tests/assembly.test.ts) drive every branch with a
mocked `Manifold.union` / `.difference` / `.intersection` — they pin what the
handler emits, but nobody had watched a branch fire against the real engine in
the running app.

[src/geometry/csgFault.ts](../src/geometry/csgFault.ts) now arms a forced
failure from the URL (`?csgfault=difference`, `?csgfault=color-union:1`) at the
five points where a real one originates, and
[scripts/check-csg-failure.mjs](../scripts/check-csg-failure.mjs) drives the
app through each, exports a real 3MF, and asserts the degradation that reaches
the file against an undamaged baseline. Run it with
`npm run build && node scripts/check-csg-failure.mjs`; the `debug-csg-failure`
skill is the walkthrough.

First full run (wheel, two-color SVG) — all five branches confirmed degrading as
documented. The body triangle counts are the measurement worth keeping, because
they are what distinguishes the two outcomes that otherwise look identical in
the file (one body, no inlays):

| Fault                       | Total inlays | Body triangles         |
| --------------------------- | ------------ | ---------------------- |
| none (baseline, 1 artwork)  | 4            | 45,214                 |
| `color-union:1` (2 artwork) | 3 (of 4)     | —                      |
| `part-union`                | 2 (of 4)     | 45,166 — **Cap** uncut |
| `difference`                | 0            | 44,930 — **uncut**     |
| `body-mesh`                 | 0            | 44,930 — **uncut**     |
| `intersection`              | 0            | 45,214 — **still cut** |

`intersection` matching the baseline exactly is the point: its pocket really is
cut and only the fill failed, which is the "prints as an empty recess" outcome
in [troubleshooting.md](troubleshooting.md). A change that collapsed it into the
export-uncut path would show up here as 44,930 and nowhere else.

`part-union` damaging one part rather than all three is also the point, and the
reason its check is per-part: the part-wide merge only runs on a part carrying
two or more colors, and on this artwork that is the Cap alone. Top and Bottom
come out identical to the baseline, which is the property worth asserting —
the failure stayed inside the part it happened on.

Not covered: the fault points force the _handler_ to run, so they prove the
degradation and the cleanup, not that Manifold fails on any particular real
mesh. Genuinely malformed input is still the untested half.

## Zebra + Fill still loses one color on "Handle (left)"

Left over after the vertex-count fix below, measured on `MOSAIC_GPU=1`
production build, 2026-08-03: zebra in Fill mode on the chair's Left side
settles clean apart from a single
`Couldn't build the cut solid for color #0a0a0a on "Handle (left)"` — so that
part prints without the black, per the handling described in
[troubleshooting.md](troubleshooting.md).

This is not a regression from the thinning, but the thinning is what exposed
it. On the old asset the same part failed _earlier_, at the 2D union
(`Boolean union failed for color #0a0a0a on Handle (left)`), and fell back to
the unmerged shape — a coarser input that the 3D boolean then swallowed
without complaint. With the union succeeding, the full-detail pattern reaches
Manifold and that is where it now fails. Net it is 8 union failures across 4
parts down to 1 CSG failure on 1 part, but "one part quietly loses a color"
is still the outcome.

Different layer from the union problem — this one is Manifold, not turf 6.5 —
so the fix is likely different too. Worth trying first: whether the handle's
own mesh density or a near-tangent cut at its curvature is what trips it, by
re-running with the pattern scaled up (fewer, larger stripes on that part).
Closing it means reproducing against `?csgfault` (see "The CSG failure
branches" above) and narrowing to the specific solid Manifold rejects.

## Turf's tile union has a vertex ceiling, and nothing enforces it at runtime

Measured 2026-08-03 while fixing the bundled zebra pattern. Fill mode unions
one copy of the pattern per tile, and `@turf/turf` 6.5's polygon clipping
starts failing somewhere around **800k vertices in a single operation**. It
does not throw at that point — it drops tiles, and the only surface signal is
`Boolean union failed … (likely a self-intersecting path in the source SVG)`,
which names the wrong cause: the paths were fine, there were simply too many
of them.

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
