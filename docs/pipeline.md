# Pipeline

How the geometry actually works — read this before touching `src/geometry/` or `src/export/`.

## How it works

### 1. Read the artwork

**An SVG is read as shapes, not pixels** ([src/svg/](../src/svg/)): geometry
straight off the elements, transforms applied, curves broken into straight
segments, shapes grouped by fill colour. Curves are broken up adaptively
([path.ts](../src/svg/path.ts)) so detail is spent where the curve is sharp.

**A PNG, JPG or WebP reaches the same `ParsedSVG`** by another route
([src/raster/](../src/raster/)). Nothing after step 1 can tell which it was.

- Decoded at 512px to measure, then again at 1024px if it reads as flat art.
  Photos stay at 512px ([decode.ts](../src/raster/decode.ts)).
- Measurement stays pinned at 512px whatever the working size, and rides on
  `RasterImage.edgeDensity` so a re-trace can't re-derive it.
- Pixels under 50% alpha are background and cut nothing.
- Edge density (how much of the image is colour boundary) sets blur, despeckle
  and curve-fit strength; the Detail slider scales them. The user never picks a
  mode. Flat art also gets a one-pixel blur, but only when the 1024px pass ran
  ([stats.ts](../src/raster/stats.ts) explains both).
- Colours are clustered in CIELAB, then forced a minimum perceptual distance
  (ΔE 3) apart. That's deliberately the same space, metric, and value the
  default "Slight" auto-merge threshold uses
  ([`PALETTE_SEPARATION_DE`](../src/raster/quantize.ts) and
  [`AUTO_MERGE_LEVELS`](../src/geometry/regions.ts)), so freshly-traced colours
  are a provable no-op for it. Colours decides which regions exist, auto-merge
  decides which share a filament slot; keep the two values equal.

**The tracer walks the cracks between pixels, not the pixels**
([trace.ts](../src/raster/trace.ts)), so two touching regions share one boundary
line exactly. That network is cut into **chains** (runs of boundary between
junctions where three or more regions meet, plus junction-free island outlines),
and each chain is fitted to a curve ([curve.ts](../src/raster/curve.ts)) instead
of being emitted as pixel corners. Pixel corners can only step in whole pixels,
which prints as a visible staircase on every diagonal.

**Each shared chain is fitted once, and that is load-bearing.** Fitting each
region separately pulls the shared chain two ways and leaves a sliver of bare
part surface along every colour boundary. Outlines are reassembled by splicing
whole chains, so both sides splice identical points. **Don't fit per region**:
`tests/raster-trace.test.ts` pins the invariant, `tests/raster-curve.test.ts`
pins the fit, and trace.ts carries the reasoning.

It does not stop a region crossing one it shares no chain with, worth up to one
working pixel of overlap. Paint order absorbs it; measured in
[tech-debt.md](tech-debt.md).

### 2. Work out what each colour actually shows

Paint order is applied, so an outline drawn over a fill has its footprint
subtracted from that fill. 2D polygon overlap maths via Turf.js
([regions.ts](../src/geometry/regions.ts)).

- **Holes are decided by nesting depth**, not winding: a ring nested an odd
  number deep is a hole. Correct for both SVG fill rules.
- **Depth is probed at an edge midpoint, never a corner.** A traced outline
  starts on a junction, where the inside/outside test is undefined. regions.ts
  records what probing there did.
- Colours assigned to the base are dropped. Similar colours auto-merge (a ΔE
  slider, live and reversible) and combine with manual merges. Each merged slot
  prints its largest member's real colour, never a blend.

### 3. Place the artwork

Scale, X/Y offset, rotation and mirror are applied before any cutting, in both
modes. Set them from the Artwork fit sliders, or drag the artwork on the part in
the 3D view.

### 4. Flat-plate mode

The plate is a stack of flat slabs between depth boundaries. Pure 2D maths, no
3D booleans ([flat.ts](../src/geometry/flat.ts)).

- Depth is capped at the plate thickness less a 0.05 mm floor, so a recess
  cannot cut through.
- Zero or less is raised to 0.2 mm, one typical layer.
- Both cases warn, naming the region and both numbers.
- A positive depth thinner than a layer is honoured and only noted: a real
  choice on a fine-layer profile.

One place resolves what a region asked for, for both modes
([depth.ts](../src/geometry/depth.ts)): an explicit per-row override if it is
finite, otherwise the global depth (`Infinity`/`NaN` fall back too). A stored
`0` is a real answer, not a
missing one, and the capped result is never written back into the settings.

### 5. Assembly mode

Pockets are cut into real part meshes. Each colour region is extruded into a
prism in the part's own coordinates and subtracted from the mesh with
[Manifold](https://github.com/elalish/manifold), a 3D solid-boolean engine (CSG)
loaded on demand ([assembly.ts](../src/geometry/assembly.ts)).

**Depth is bounded at the shallow end only.** It is raised to the same 0.2 mm
floor, and the warning names the raised _setting_ rather than a cut depth,
because a cut-through part holes the whole way through regardless.

**The deep end is not checked at all.** Wall thickness varies across a part and
nothing measures it, so a pocket deeper than the wall exports as a part with a
hole through it, silently. Only the extreme case surfaces, where the cut leaves
the part empty and the export drops it.

**Rotated copies** are supported (a wheel's two halves): the slice of the design
landing on the copy is mapped back into the part's own print orientation.

**How the SVG maps onto the part** depends on the kind:

- Round parts (the wheel): a Design-radius circle model.
- Rectangular parts (the footrest): 1:1 in millimetres, lining the SVG's own
  canvas up with the detected face, so a design drawn off-centre on a template
  stays off-centre on the part.
- A file declaring neither is centred on its drawn content.

**Several designs can share one surface.** Where two overlap the cut still
happens, but their inlays would claim the same volume, so placements are
compared per zone and both designs are named in a warning
([designOverlap.ts](../src/geometry/designOverlap.ts)).

**Design zones: a part can carry more than one design surface.** Baked ahead of
time by `scripts/bake-zones.mjs`. The chair body has five (left, right, front,
back, seat). Each is a true-scale flat map of its surface (a UV chart) that
artwork wraps onto **conformally**: a sticker follows the surface around a
rounded edge the way real vinyl would
([conformal.ts](../src/geometry/conformal.ts)).

- A zone spans the printed parts under it rather than stopping at a part edge.
- Artwork laid across a seam is split, cut into each part separately, and
  exported under that part's object.
- Target a zone from the Artwork list's per-row dropdown, or by clicking the
  surface in the 3D view.

**Artwork can't cross between zones, and the split into five is load-bearing.**
A zone's spread of surface directions must stay tight enough that flattening
doesn't fold the surface onto itself, which `flipped == 0` does not check:
merging left/back/right into one chart makes it fold onto itself over 4.85% of
its area. Widening one zone is capped by stretch first, which doubles for 5°
more on the chair's flanks. Measure both before changing the split; numbers in
[tech-debt.md](tech-debt.md). Don't assume the boundary between two zones is a
curve you could register across: on the chair, `left` and `back` share 22mm of
it.

**Hardware variants** (the chair's Standard/Kit caster mounts) show a version
picker above the part list. Switching reloads only the parts that differ.

**Sticker or Fill.** Any artwork row on an assembly part can repeat the design
across the whole zone instead of placing one copy. Tiling happens in the
design's own SVG coordinates, so it stays correct under whatever rotation and
scale the zone applies ([patterns.ts](../src/geometry/patterns.ts)). Four
tileable patterns ship (Cow, Dalmatian, Zebra, Tiger) and default to Fill.

### 6. Export

A Bambu Studio _project_ 3MF, with the vendor metadata that makes it import
without warnings: named parts, per-part filament slots, multi-plate placement
([threemf.ts](../src/export/threemf.ts)). The target printer
([printers.ts](../src/export/printers.ts)) picks the plate size and profile
names, so one writer resolves in Bambu Studio, OrcaSlicer and Snapmaker Orca.

**Placement is taken from verified reference files, not computed.** Wheel
exports pin the Top half and Cap to plate 1 and each rotated duplicate to its
own plate, at a fixed rotation and position; the prime tower is a fixed offset
from the Top half. The footrest centres itself on whatever plate, because its
reference position wasn't portable across bed sizes. threemf.ts carries each
constant's provenance.

Three things warn on screen rather than being assumed safe: a part that
overhangs its plate, a part placed past the plate edge, and a plate whose tower
has no verified position and no free corner.

## Code layout

| Path                                                  | What it holds                                                                                                                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [state/store.ts](../src/state/store.ts)               | The single app-state object all geometry reads. UI panels write to it and schedule a rebuild.                                                                                        |
| [state/filaments.ts](../src/state/filaments.ts)       | Owned-filament palette, from [public/filaments.json](../public/filaments.json). Edit that file to change the base-color picker and "nearest filament" labels; no code change needed. |
| [state/patterns.ts](../src/state/patterns.ts)         | Built-in pattern manifest, from [public/patterns/patterns.json](../public/patterns/patterns.json). Add patterns via [gen-patterns.mjs](../scripts/gen-patterns.mjs), never by hand.  |
| [app/rebuild.ts](../src/app/rebuild.ts)               | Orchestrates state → geometry → scene → side panels.                                                                                                                                 |
| [scene/viewport.ts](../src/scene/viewport.ts)         | three.js renderer and camera.                                                                                                                                                        |
| [scene/displayFrame.ts](../src/scene/displayFrame.ts) | How a kind is posed for display. Viewport only: native coordinates, the plate pose, and this are three separate frames on purpose (`add-part` skill).                                |
| [raster/](../src/raster/)                             | PNG/JPG to `ParsedSVG`. Only `decode.ts` touches the DOM, which is what lets the rest be tested in node with no canvas stub.                                                         |
| [ui/](../src/ui/)                                     | One module per left-panel section.                                                                                                                                                   |
| [assembly/](../src/assembly/)                         | Assembly kinds (roles) and part loading.                                                                                                                                             |

## Adding an assembly or library part

Assemblies live in [kinds.ts](../src/assembly/kinds.ts), one entry per assembly
listing its part roles. A role's `libraryPartId` links to
[parts.json](../public/stl/parts.json): drop the STL/3MF in `public/stl/`, add a
manifest entry, and the role auto-loads. Roles without one fall back to
drag-and-drop.

Two fields tune non-wheel parts:

- **`AssemblyRole.preferFaceNormal`** (unit vector) steers the auto-picked
  design face toward the largest patch facing that way, rather than the largest
  patch overall. The footrest needs it: its flat back outsizes its seat.
- **`AssemblyKind.designFit: 'rect'`** maps the SVG 1:1 in millimetres and
  centres it on the detected face, instead of the wheel's Design-radius circle
  model. Where an SVG declares no absolute mm size, rect placement fits the
  viewBox to the face so a template trace still lands life-size. The Footrest
  kind uses both fields.

The full procedure, including packing the mesh and baking placement, is the
`add-part` skill.

### A generated part

Every part above ships as a mesh. The hubcap does not: only its four mounting
clips ship (`public/stl/hubcap-clips.3mf`), and the disc they carry is built at
the chosen diameter and unioned onto them.

`AssemblyRole.buildMesh` is the mechanism, a function on the role, so nothing in
`src/assembly/` has to know a hubcap exists. The fetched asset stays on
`AssemblyPart.assetPositions`, so a parameter change regenerates without another
fetch. `AssemblyKind.buildParam` declares the numeric control as data, so the
panel renders it without knowing the kind.

The generator is [hubcap.ts](../src/geometry/hubcap.ts). Its constants are
measurements off the mesh a human modelled, and `tests/hubcap.test.ts`
regenerates the disc and checks it back against them. Two things that look
cosmetic are not, and hubcap.ts explains both: the disc and clip tops are
exactly coincident so joining them must be a real boolean, and face winding
decides which side is solid.

**The disc can be cut to the shape of its own artwork.** `hubcapShapeFromState`
([kinds.ts](../src/assembly/kinds.ts)) is the seam. It returns the circle when
the **Cut to artwork shape** box is off, when no artwork is loaded, or when more
than one is; otherwise it reads the outline off the loaded artwork
(`silhouetteFromShapes`,
[hubcapOutline.ts](../src/geometry/hubcapOutline.ts)) and hands that to
`buildHubcapBody`. There is deliberately no second upload: the picture and the
cutline are one object, which is also why only one design is allowed. The edge
is cut square, not chamfered.

The outline is measured before it becomes a part:

- `clipCoverage` refuses below 90% of the clips' bonding ring covered, catching
  a silhouette that would leave the clips floating.
- An outline within 2% of its own bounding box is flagged as probably opaque,
  the usual sign of an image that lost its alpha channel.
- `narrowFeatureArea` reports how much of the outline sits in features narrower
  than 1mm, and warns rather than refusing: a thin spike still makes a valid,
  if fragile, solid.

**The outline is placed by the same transform as the cut**, not by a parallel
rule meant to match it. `hubcapShapeFromState` builds an `OutlinePlacement` from
`designAnchor` and `designMmPerUnit`, the two helpers the cut itself uses, and
`placeArtworkPoint` applies them in `ZoneMapper.placer`'s order. Part and
picture cannot disagree by construction.

**Offset is derived, not read.** The outline centres on the mounting axis and
the artwork's offset is solved to put the picture on it. That is a correctness
requirement, not a shortcut: `ZoneMapper.placer` ends with `+ faceCx`, and for a
silhouette that face _is_ the outline being placed, so any offset moves the
surface it is measured against. hubcapOutline.ts records the axis conventions
and the padded-PNG drift that proved it.

Two more factors size the part:

- `generatedDesignFaceOverride` substitutes a fixed square from the diameter
  control, so auto-fit-to-largest-face doesn't use the shape being fitted as its
  own reference. The build and the placement gizmo read it identically.
- The wheel limit is a radius about the mounting axis (280mm,
  `HUBCAP_WHEEL_DIAMETER_MM` in [hubcap.ts](../src/geometry/hubcap.ts)), not a
  maximum size, because a shape's corners reach further than its longest side.
  The factor `min(1, R / outlineReach)` goes to the outline via
  `scaleOutlineAbout` and to the artwork via `generatedFitFactor`, which
  `designMmPerUnit` multiplies into **every** branch. `generatedFitFactor`'s
  docstring in [kinds.ts](../src/assembly/kinds.ts) explains why that must not
  ride on the design face: an SVG with an absolute mm size never consults the
  face branch at all, so folding the cap in there made it a silent no-op for
  exactly the files this app hands out as design templates.

**Artwork touching the outline cuts the shell's full thickness; interior artwork
stays a recess.** Recessing the picture 1mm into a 3mm shell would leave the
outline as a 2mm band of base colour. This is per **region**, not per part,
which distinguishes it from `wheel-hub-cap`'s kind-wide `cutThrough`: interior
detail on a 220mm disc should stay a recess.

- The generator declares it, via `GeneratedMesh.edgeCutThroughDepth`, and only
  for a silhouette. That shape is cut flat, so its design face _is_ its outline.
  The circle is chamfered and declares nothing.
- `ZoneMapper.resolveCutRegions` splits on it, one entry per depth. Nothing
  upstream learns what a hubcap is.
- The split is by **whole connected polygon**
  ([edgeRegions.ts](../src/geometry/edgeRegions.ts)); cutting only the strip near
  the edge would leave a trench through the middle of a colour.
- A colour can be split across both depths, so the thin-depth note asks whether
  **any** slice took the setting.
- The touch test uses an **absolute** area floor, not a fraction of the region.
  See `MIN_TOUCH_AREA_MM2`, which records both measurements behind that.
- The split only fires on a region that really was clipped. An unclipped region
  overruns the boundary everywhere and would read as entirely edge.

The face measured against is a **single** boundary loop, so a silhouette
enclosing a hole keeps a base-colour rim around it. The fix is in
[tech-debt.md](tech-debt.md).

**Export placement is baked from a verified reference 3MF, never computed at
runtime.** Once a part's print pose has been checked in the slicer, those
numbers become constants in [threemf.ts](../src/export/threemf.ts), wired onto
`ExportPart` by `resolvePlacement` in
[placement.ts](../src/export/placement.ts):

| Field             | Purpose                                                                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plateR`          | Full baked rotation, for a pose that isn't a flat face-down tilt (`FOOTREST_PLATE_R` stands the footrest on its long edge to print support-free).                                      |
| `fixedPos`        | A fixed reference coordinate (`WHEEL_TOP_POS`, `WHEEL_CAP_POS`). Omitted where the reference coordinate isn't portable across beds, so the part centres itself instead (the footrest). |
| `primeTowerDelta` | Tower position as an offset from the anchor part's final position, not an absolute, so the layout reproduces on every plate size.                                                      |
| `objectSettings`  | Per-part Bambu overrides in `model_settings.config`. Read the constant, never a copy of its value.                                                                                     |

Brim is off project-wide via `brim_type`, so the footrest carries support only.
The chair's two handles do override brim (`chairPlacement.ts`), a deliberate
per-part exception rather than a duplicate of the default.

Those constants are handed back only for a mesh matching the fingerprint they
were verified against, so **a generated part can never be vouched for that way**:
its mesh varies by design and never matches a seal. `resolvePlacement` reports
`'generated-part'` rather than a mismatch, because a mismatch means the repo's
own assets drifted and this isn't that.

What a generated part _can_ have is an arrangement verified at one size, which
`AssemblyRole.buildPlacement` returns. The hubcap's (`hubcapPlacement`) applies
only on a bed with its own `HUBCAP_PLATE` entry, and only up to the diameter it
was verified at. Two mechanisms serve it, neither a general escape hatch:

- `fixedPosByPlate`, an absolute position authored for one exact bed, taken
  verbatim and skipping the re-centering `fixedPos` gets.
- `projectSettings`, a project-wide Bambu key (the hubcap sets
  `prime_tower_width`, since its verified clearance is only true at that width),
  listed in `different_settings_to_system` so a resave can't reconcile it away.

**The part position and the tower position are one claim.** On both verified
beds the disc had to move off centre to free a corner, so applying the tower
without the matching position puts it through the part.

Where nothing was verified, the part falls through to the computed path: centred
on its plate, with `suggestTowerPos` parking the tower in whichever corner the
parts intrude on least, warning when every corner is occupied. That search runs
for **any** plate with no baked tower position, not just hinted ones: while it
didn't, an unhinted plate wrote no `wipe_tower_x/y` at all and the slicer fell
back to its own preset default, quite possibly through the part the export had
just centred there. The corner probe tests each
part's _bounding box_, so a round part is reported as blocking corners it
actually leaves free: conservative in the right direction, but it means the
warning fires for every hubcap on a bed near its size.
