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

## Zone picking has no occlusion test

([src/scene/zonePick.ts](../src/scene/zonePick.ts)) — it raycasts only the
invisible chart meshes (three.js 0.160's `intersectObject` ignores
`visible`, which is what makes picking work at all), but the real bodies
aren't in the target list, so clicking a handle in front of a zone selects
the zone behind it. Fix: raycast the visible parts too and reject a zone hit
farther than the nearest solid hit. Gets worse as zones multiply — the chair
went from 4 to 5 with the full-coverage re-author.

## One warning covers three different failures

([src/geometry/assembly.ts](../src/geometry/assembly.ts)) — "Raise Scale to
fill the surface" is the advice whether `tileCoverage` refused on tile
count, non-invertibility, or non-affinity. It is right for the first and
misleading for the other two. Split the message per cause.

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

## The CSG failure branches have never been watched degrading in the running app

What they emit is now pinned in CI — the `CSG failure handling` tests
in [tests/assembly.test.ts](../tests/assembly.test.ts) build the real 3MF and
assert the shipped body/inlay object counts via `partObjectSummaries`
([tests/lib/threemf.ts](../tests/lib/threemf.ts)), so the export bug those
branches exist to fix — an uncut body shipping alongside inlay solids in the
same volume — can't come back silently. But every one of those runs is
driven by a mocked `Manifold.union` / `.difference` / `.intersection`. Nobody
has seen the branches fire against the real engine in the app, and a
dev-only forced throw is what would make that check repeatable rather than a
hand-edit each time.

## The warning panel can hide the warnings that matter most, and the CSG failure messages are the worst fit for it

[src/ui/warningsView.ts](../src/ui/warningsView.ts) renders only
`WARNINGS.slice(0, 6)` as pills and collapses the rest into "+ N more
warnings", with no way to read them. Dedupe in
[src/warnings.ts](../src/warnings.ts) is by exact message and these messages
embed the part name, so per-part warnings never collapse — they each take a
slot. Measured against the longest real part name ("Chair caster mount,
Standard (right)", 36 chars) the four CSG failure messages run 92, 103, 151
and 163 characters, and the chair has 15 pieces: an all-parts body-cut
failure produces 15 distinct warnings of which 6 are readable, and a
per-color inlay failure across 4 colors produces 60. This is not
hypothetical — the seam-sliver entry above records a real case where one
design on `back` warned for **three** colors on a single part, so 3 of the 6
slots went to one piece. Fix: make the overflow readable (scroll or expand)
and/or group per-part warnings into one pill naming the count, so "your part
shipped blank" can't be the message that gets truncated away. Note the pill
lengths are measured but their _rendered_ wrapping in the panel is not —
worth eyeballing at a narrow viewport as part of the same change.
