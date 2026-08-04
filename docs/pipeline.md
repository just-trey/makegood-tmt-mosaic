# Pipeline

How the geometry actually works — read this before touching `src/geometry/` or `src/export/`.

## How it works

1. **The SVG is parsed as vectors, not pixels** ([src/svg/](../src/svg/)) — the
   `<path>`/`<rect>`/`<circle>`/etc. geometry is read directly, transforms
   composed, curves flattened, and shapes grouped by fill color. Bezier curves
   are flattened adaptively (recursive subdivision to a fixed deviation
   tolerance, [src/svg/path.ts](../src/svg/path.ts)) rather than at a fixed
   segment count, so gentle curves emit few points and only sharp/detailed
   curves emit many — fewer total vertices flowing into the boolean pass below
   without losing visible fidelity.
   A **raster image** (PNG/JPG/WebP, [src/raster/](../src/raster/)) reaches the
   same `ParsedSVG` by a different route, and nothing below step 1 knows the
   difference. Decode downscales to 512px on the long edge
   ([src/raster/decode.ts](../src/raster/decode.ts)) — already coarser than a
   0.4mm nozzle across the 276mm wheel, and the measured knee in tracing cost.
   Pixels under 50% alpha become background and cut nothing. An edge-density
   statistic ([src/raster/stats.ts](../src/raster/stats.ts)) decides how
   photographic the image is and sets blur/despeckle/curve-fit strength from it,
   which the Detail slider then scales; the user never picks a mode. Quantization
   is median-cut seeding plus Lloyd refinement **in CIELAB**
   ([src/raster/quantize.ts](../src/raster/quantize.ts)), deliberately the same
   space and metric `applyColorMerges` clusters in, and the palette is
   ΔE-separated afterwards so the default "Slight" auto-merge is a provable
   no-op on a traced image — Colors decides which regions exist, auto-merge
   decides which share a slot, and the two never fight.

   **The tracer walks the cracks between pixels, not the pixels**
   ([src/raster/trace.ts](../src/raster/trace.ts)), so two adjacent regions
   share their boundary polyline bit-for-bit. That crack graph is then cut into
   **chains** — maximal runs between junctions where three or more regions meet,
   plus junction-free island boundaries — and each chain is fitted to a
   sub-pixel curve ([src/raster/curve.ts](../src/raster/curve.ts)) rather than
   emitted as lattice points. This is what stops traced artwork looking blocky:
   a lattice vertex set can only step in whole pixels, which at 512px across the
   wheel is a ~0.54mm staircase on every diagonal — visible, and printable.
   Straight-subpath detection and a minimum-vertex polygon replace the old
   Ramer–Douglas–Peucker pass entirely; a least-squares adjustment then moves
   each vertex off the lattice, and `alphaMax` decides per vertex whether it
   stays a hard corner or becomes a curve, so a logo's square edge survives
   while an arc goes smooth. Curves are flattened back to polylines because
   everything downstream speaks `Loop = Pt[]`.

   **The fit happens once per shared chain, and this is load-bearing**: fitting
   each region's rings independently would pull the shared chain two different
   ways and leave a sliver of bare part surface along every color boundary in
   the image — a real print defect, since these are cut as geometry. Each ring
   is reassembled by splicing whole chains, so both sides of every boundary
   splice the identical points. A ring is always a whole number of chains
   (a chain's interior nodes have exactly two cracks, so a traversal that enters
   one can only leave at the far end), and the ring walk is rotated onto a chain
   boundary first, since it starts at a lattice corner that needn't be a
   junction. `tests/raster-trace.test.ts` pins the invariant (two regions still
   tile their frame exactly after the fit moves the divider off the lattice) and
   `tests/raster-curve.test.ts` pins the fit itself; don't fit per region.
   Hole-vs-solid and winding
   are deliberately left to `shapeToFeature` below. Shapes are grouped one per
   color rather than one per connected component — measured, not assumed, with
   [scripts/bench-raster.ts](../scripts/bench-raster.ts).

2. **Each color's _net visible_ region** is computed with paint order taken
   into account — an outline drawn on top of a fill has its footprint
   subtracted from the fill's region, matching what the rasterized image would
   show. 2D polygon booleans via Turf.js ([src/geometry/regions.ts](../src/geometry/regions.ts)).
   Holes are resolved by **containment depth** (odd nesting depth = hole),
   which is correct for both the `nonzero` and `evenodd` SVG fill rules.
   Regions are then resolved into recesses: any color assigned to the base
   material is excluded outright, visually similar colors are auto-merged
   (a CIE76 ΔE-clustered slider, live and reversible) and unioned with any
   manual merges, and each merged slot takes its dominant member's real color
   rather than a blended average (`applyColorMerges` in the same file).
3. **Placement** (scale, X/Y offset, rotation, mirror) is applied before the
   cut in both modes. It can be set from the Artwork fit sliders or by
   dragging the artwork directly on its face in the 3D viewport — a selection
   frame with move/scale/rotate handles, same as the sliders underneath.
4. **Flat-plate mode** builds the plate as a stack of flat slabs between depth
   boundaries — pure 2D math, no CSG ([src/geometry/flat.ts](../src/geometry/flat.ts)).
   Each region's depth is capped at the thickness less the 0.05 mm floor that
   keeps a recess from cutting through, and a depth of zero or less — which
   cuts nothing and says nothing about intent — is raised to 0.2 mm, one
   typical layer. Either warns, naming the region and both numbers. A positive
   depth thinner than a layer is honored and only noted: it is a real choice on
   a fine-layer profile. What a region asked for is resolved in one
   place for both modes ([src/geometry/depth.ts](../src/geometry/depth.ts)):
   an explicit per-row override if it is finite, otherwise the global depth.
   A stored `0` is a real answer there, not an absent one, and the clamped
   result is never written back into the settings — doing so pinned each row
   to its own clamp and silenced the warning from the second rebuild on.
5. **Assembly mode** cuts pockets into real part meshes: each color region is
   extruded into a prism in the part's own coordinates and booleaned against
   the mesh with [Manifold](https://github.com/elalish/manifold) (WASM CSG,
   lazy-loaded) ([src/geometry/assembly.ts](../src/geometry/assembly.ts)).
   Depth is bounded only at the shallow end here — raised to the same 0.2 mm
   floor, with a warning naming the raised _setting_ rather than a cut depth,
   since resolveCutDepth is free to ignore it (a cutThrough part takes its hole
   the whole way through regardless). The too-deep end is not checked at all —
   a part's wall thickness varies across it and nothing measures it, so a pocket
   deeper than the wall in one spot exports as a part with a hole through it and
   no warning. Only the extreme case surfaces, where the cut leaves the part
   empty and the export drops it (exportPanel.ts's `bodySoup.length` guard).
   Supports rotated-copy parts (the same physical part installed twice, e.g.
   a wheel's two halves): the design slice that lands on the copy is remapped
   back into the part's native print orientation. Round parts (the wheel) map
   the SVG via a Design-radius/circle model; rectangular parts (the footrest)
   map it 1:1 in millimeters instead, lining the SVG's own canvas — its
   viewBox, or its declared mm size — up with the detected face, so a design
   drawn off-center on a template stays off-center on the part. A file that
   declares neither is centered on its drawn content, as before. Several
   designs can land on one surface, each with its own placement; where two of
   them cover each other the cut is still made, but their inlays would claim
   the same volume in the export, so the placements are compared against each
   other per zone and both designs are named in a warning
   ([src/geometry/designOverlap.ts](../src/geometry/designOverlap.ts)). A
   part can also carry more than one design surface (**design zones**) baked
   ahead of time by `scripts/bake-zones.mjs` — the chair body has five
   (left/right/front/back/seat), each its own true-scale UV chart the artwork
   wraps onto **conformally** (a sticker follows the surface around a rounded
   edge the way real vinyl would, not a flat orthographic stamp)
   ([src/geometry/conformal.ts](../src/geometry/conformal.ts)). A zone spans the
   printed parts under it rather than stopping at a part boundary — the
   chair's left/right zones run from the storage side across the handle and
   wheel mount onto the front fender — and artwork laid across a seam is
   split, cut into each part separately, and exported under that part's
   object. Load more than one design, then target each zone from the Artwork
   list's per-row dropdown or by clicking the surface directly in the 3D
   view. Artwork can't cross between zones, and the split into five is
   load-bearing: a zone's normal spread has to stay tight enough for the
   unwrap to stay **injective**, which `flipped == 0` does not check — merging
   left/back/right into one chart makes it fold onto itself over 4.85% of its
   area. That is the constraint on _merging_ zones; widening one is capped by
   stretch first, which doubles for 5° more on the chair's flanks while
   overlap stays clean. Measure both, and don't assume the boundary between
   two zones is a curve you could register across — on the chair `left` and
   `back` share 22 mm of it. Numbers in [docs/tech-debt.md](tech-debt.md). A kind with hardware
   variants (the chair's Standard/Kit caster mounts) shows a version picker
   above the part list; switching reloads only the parts that differ. Any
   artwork row on an assembly part can switch from **Sticker** (one copy) to
   **Fill**, which repeats the design across the whole zone, tiled in the
   design's own SVG coordinate space so the tiling stays correct under
   whatever rotation/scale the zone's mapping applies
   ([src/geometry/patterns.ts](../src/geometry/patterns.ts)). The Artwork panel
   ships a small built-in library of tileable patterns (Cow, Dalmatian,
   Zebra, Tiger — [scripts/gen-patterns.mjs](../scripts/gen-patterns.mjs)
   generates them) that default to Fill mode when loaded on an assembly
   part.
6. **Export** writes a Bambu Studio _project_ 3MF (vendor metadata included,
   so it imports without warnings, with named parts, per-part filament slots,
   and multi-plate placement) ([src/export/threemf.ts](../src/export/threemf.ts)).
   The target printer ([src/export/printers.ts](../src/export/printers.ts))
   selects the build plate size and the profile-name strings the project
   settings reference, so the same writer resolves cleanly in Bambu Studio,
   OrcaSlicer, and Snapmaker Orca. Wheel-assembly exports pin the primary Top
   half + Cap onto plate 1 and each rotated-duplicate Top half onto its own
   plate, using a fixed rotation and plate position for both parts — taken
   from a real, tested MakeGood TMT export rather than computed, since the
   wheel's geometry and required orientation are a specific, already-verified
   product rather than something to re-derive per printer. The prime/wipe
   tower's plate position is pinned the same way, as a fixed offset from the
   wheel's Top half. The footrest instead centers itself on whatever plate
   (its reference placement wasn't portable across bed sizes — see "Adding an
   assembly or library part" below) with its own tower offset and per-part
   support-off/no-brim overrides riding along. A part that still overhangs
   its plate, one placed past the plate edge, and a plate whose tower has no
   verified position and no free corner to fall back on are each reported as
   an on-screen warning rather than assumed safe.

## Code layout

- [src/state/store.ts](../src/state/store.ts) — the single app-state object all
  geometry reads; UI panels write to it and schedule a rebuild
- [src/state/filaments.ts](../src/state/filaments.ts) — the owned-filament
  palette, loaded from [public/filaments.json](../public/filaments.json). Edit
  that file to change the colors offered by the base-color picker and used
  for "nearest filament" labels — no code changes needed.
- [src/state/patterns.ts](../src/state/patterns.ts) — the built-in pattern
  library manifest, loaded from
  [public/patterns/patterns.json](../public/patterns/patterns.json). Add a new
  pattern in [scripts/gen-patterns.mjs](../scripts/gen-patterns.mjs) and re-run
  it rather than hand-editing the SVGs or manifest.
- [src/app/rebuild.ts](../src/app/rebuild.ts) — orchestrates state → geometry →
  scene → side panels
- [src/scene/viewport.ts](../src/scene/viewport.ts) — three.js renderer/camera
- [src/scene/displayFrame.ts](../src/scene/displayFrame.ts) — how an assembly
  kind is posed for display. Viewport only: native part coordinates, the
  export/plate pose, and this are three separate frames on purpose (the
  `add-part` skill, "The separate orientations are intentional")
- [src/raster/](../src/raster/) — PNG/JPG → `ParsedSVG`. `decode.ts` is the only
  module here that touches the DOM; the rest is pure math over typed arrays,
  which is what lets it be tested in node with no canvas stub
- [src/ui/](../src/ui/) — one module per left-panel section
- [src/assembly/](../src/assembly/) — assembly kinds (roles) and part loading

## Adding an assembly or library part

Assemblies are defined in [src/assembly/kinds.ts](../src/assembly/kinds.ts) —
one entry per assembly, listing its part roles. A role's `libraryPartId`
links to [public/stl/parts.json](../public/stl/parts.json); drop the STL/3MF in
`public/stl/`, add a manifest entry, and the role auto-loads. Roles without a
library entry fall back to drag-and-drop.

Two per-kind/per-role fields tune non-wheel parts:

- `AssemblyRole.preferFaceNormal` (unit vector): the design face isn't always
  the part's single largest flat patch — the footrest's flat back outsizes its
  seat, for instance. Setting this steers the auto-picked default toward the
  largest patch facing that direction instead of the overall largest.
- `AssemblyKind.designFit: 'rect'`: for a rectangular (non-circular) part, maps
  the SVG 1:1 in millimeters and centers it on the detected face, instead of
  the wheel's circle/Design-radius model. The Footrest kind uses both fields —
  see [src/assembly/kinds.ts](../src/assembly/kinds.ts) for a worked example. When
  the SVG declares no absolute mm size (some editors export `width="100%"` and
  rescale the viewBox), rect placement fits the viewBox to the part face rather
  than assuming 1 unit = 1 mm, so a template trace still lands life-size.

**Export placement is baked from a verified reference 3MF, never computed or
read at runtime.** Once a part's real-world print pose has been checked in the
slicer (a reference project file the user hand-verified — rotation, plate
position, prime/wipe tower placement, per-part print settings), those numbers
become constants in [src/export/threemf.ts](../src/export/threemf.ts), wired
onto the part's `ExportPart` by `resolvePlacement` in
[src/export/placement.ts](../src/export/placement.ts):

- `plateR` — a full baked rotation matrix, for a part whose verified pose
  isn't a flat face-down tilt (e.g. `FOOTREST_PLATE_R`, which stands the
  footrest on its long edge to print support-free).
- `fixedPos` vs. centering — a part's plate position is either a fixed
  reference coordinate (`WHEEL_TOP_POS`/`WHEEL_CAP_POS`, valid because the
  reference file's own X1C 256×256 plate is a known constant) or, if the
  reference coordinate isn't portable across bed sizes (e.g. it was authored
  against a different printer's plate center), omitted so the part centers
  itself on whatever plate instead — see the footrest.
- `primeTowerDelta` — the prime/wipe tower's plate position, expressed as an
  offset **relative to** the anchor part's own final position rather than an
  absolute coordinate, so the same relative layout reproduces on every plate
  size (`WHEEL_PRIME_TOWER_DELTA`, `FOOTREST_PRIME_TOWER_DELTA`).
- `objectSettings` — per-part Bambu print overrides (e.g.
  `{ brim_type: 'no_brim', enable_support: '0' }` on the footrest), written
  into `model_settings.config` on top of the project-wide settings.

The exported filename is derived from the selected assembly kind
(`mosaic-${state.assembly.kindId}.3mf`), so each part downloads under its own
name rather than a shared generic one.

**The lookup that applies those constants checks the loaded mesh matches the
one they were verified against**, using the same fingerprint (triangle count +
bbox hash) that [src/geometry/zoneCharts.ts](../src/geometry/zoneCharts.ts) uses
to guard baked zone charts. Every `public/stl/parts.json` entry is sealed in
[src/export/partFingerprints.ts](../src/export/partFingerprints.ts) (generated —
see below); `resolvePlacement` refuses to hand back a part's baked placement
if the loaded mesh doesn't match its seal. Two situations, two severities:

- A library part (`libraryPartId` set) whose mesh doesn't match its seal — an
  id renamed in `parts.json`/`kinds.ts` without updating `PLACEMENT`, or an
  asset re-packed without re-baking — is a build-integrity defect. The part
  exports auto-placed (default face-down tilt, no plate pin, no tower) with a
  loud warning naming it; `tests/placement.test.ts` cross-references every
  `parts.json` id against `ASSEMBLY_KINDS` roles and `PLACEMENT`'s keys so a
  rename like this fails CI instead of shipping silently.
- A hand-dropped mesh only inherits a role's baked placement if its
  fingerprint matches the shipped part exactly. Otherwise it's placed
  automatically with a quiet notice — the documented drag-and-drop fallback
  working as intended, not a defect. Provenance comes from
  `AssemblyPart.meshFromUpload`, not from the absence of a `libraryPartId`:
  dropping a file onto a role that already auto-loaded its library part
  leaves that id on the part (the baked zone lookup still needs it), so the
  id alone would report every such drop as one of our own assets drifting.

**Re-packing a shipped part means re-verifying its placement, then resealing
it** with `npx vite-node scripts/bake-part-fingerprints.mjs` — see the
add-part skill.

**Choosing the source mesh**: a part often exists as both a MakerWorld/slicer
download and a CAD export. Prefer the CAD export. Slicer meshes are STEP
tessellations at a triangle count that buys no accuracy — the extra triangles
cost download size and load time and change nothing the app measures. Both
shipped swaps are the worked example: the footrest went from a 235k-triangle
slicer mesh to a 10.8k-triangle CAD export (2.8MB → 86KB) and the wheel half
from 20.5k to 18.0k (400KB → 176KB), with surface areas agreeing to 0.06% and
the detected design face unchanged (54,693.7 → 54,688.3mm² and 29,407.8 →
29,403.4mm²). Decimating a dense mesh instead is strictly worse — it can move
bores and bosses, and it tilts face triangles out of their patch bucket.
`node .claude/skills/add-part/compare-meshes.mjs <a> <b>` prints both meshes'
numbers, including how much of the design face survives in one
`detectFlatPatches` bucket, and solves for the rotation between them.

One caveat when reading that tool's output: for a part that's symmetric about
an axis, mirroring it is a no-op, so "mirrored" and "rotated" describe the same
result and the tool reports the rotation. It only calls a match `MIRRORED` when
a mirror genuinely beats every rotation — which does mean the opposite hand.

**Packing a part into `public/stl/`**: don't copy a source mesh in directly —
run it through [scripts/pack-part.mjs](../scripts/pack-part.mjs), which re-indexes
the vertices and DEFLATEs the result into the single-inlined-`<object>` 3MF
that `load3MF` reads:

```bash
npx vite-node scripts/pack-part.mjs <src.stl|src.3mf> \
  [--align-to public/stl/<current>.3mf] [--bbox-tol <mm>] --out public/stl/<name>.3mf
```

`--align-to` is what makes replacing an existing part safe. Parts are **never
recentered at load time**, so a part's mesh coordinates are load-bearing: the
baked placement constants above, the wheel's rotate-about-the-origin second
half, and the generated templates are all pinned to the current poses. Aligning
moves the new mesh into the old one's exact frame and bakes that into the file,
so every one of those constants stays valid and nothing changes at runtime. The
script refuses to write if the two meshes aren't the same part, or if they're
mirrored (opposite hands — TMT ships left/right variants).

Matching requires the two bounding boxes to agree within 0.05mm per axis, which
a coarse tessellation of a curved part can miss on its own — the shipped wheel
half moved 0.03mm on Z from re-tessellation alone. The script distinguishes
that case ("bounding boxes do not line up, closest is 0.07mm off") from a real
geometry mismatch, and prints the `--bbox-tol` value that would accept it.
Loosen it only when you have an independent reason to believe the two files are
the same part.

A part that loads as empty/zero-triangle is the one silent failure mode here:
`load3MF` ([src/geometry/meshparts.ts](../src/geometry/meshparts.ts)) only reads
meshes inlined in `3D/3dmodel.model`, and BambuStudio's production-extension
format references them from a separate internal file via
`<component p:path="...">` instead. Packing from a CAD `.stl` sidesteps that
entirely, which is the recommended path.
