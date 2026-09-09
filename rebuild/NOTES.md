# Notes

Decisions, assumptions, limits and measurements for this build. First line of each section
is the decision; detail follows.

## What was built, in one paragraph

A single-page browser app (`npm run dev`, or the static `dist/` on any web host). It loads an
SVG or a picture, resolves each color's visible region, projects the design onto a part
surface, cuts a surface-following recess per filament slot with a mesh boolean, fills it with
an inlay solid in that color, packs the pieces on plates and writes a Bambu Studio project
3MF with every part on its slot. Nothing leaves the browser.

## Where this build's knowledge came from

The author of this build had read the original TMT Mosaic project's README, in-app help text,
audience note and a few docs earlier in the same session, before this rebuild was requested.
It did not open that project's source. Product facts that came from there rather than from
`PROMPT.md` are listed here so the comparison is honest:

- MakeGood's print settings: Generic PETG, 15% gyroid infill, tree (auto) supports, no brim.
  The brief says to match the verified prints; none were provided (see below), so these were
  used.
- The slicer preset names in `src/export/printers.ts` (e.g. `Bambu Lab X1 Carbon 0.4 nozzle`).
- That the wheel half prints diagonally on a 256 mm bed, which motivated the turn-to-fit step.
- The general shape of the workflow (part, design, fit, depth, colors, export). The panel
  layout, copy, and every algorithm here are this build's own.

## Reference files that were not available

`reference/verified-prints/` was empty when this was built: MakeGood's checked slicer projects
live outside the source repository and had not been dropped in. Consequences:

- Part orientation on the plate is computed: the design surface goes face down (flat parts),
  or the largest flat patch goes down (chair pieces). Every export carries a warning saying
  the layout was not checked on a printer.
- Prime tower positions are computed per plate (freest corner) and marked unverified.
- Print settings are the ones listed above, not read from a reference project.

Drop the verified projects in and the next step is to read orientation, plate membership and
per-object settings from them per piece, keyed by piece fingerprint. The writer already takes a
`verified` flag per placed piece.

## Technology choices

| Choice | Why |
| --- | --- |
| Browser app, TypeScript, Vite, no framework | Runs from a link, nothing to install, nothing leaves the machine. A DOM helper and per-section sync was enough UI. |
| `manifold-3d` (WASM) for booleans | Robust mesh booleans that stay watertight; the recess and its inlay are one intersect and one difference. |
| `polygon-clipping` for 2D | Paint-order resolution, fill rule handling and tile unions in the plane, before anything touches a mesh. |
| `earcut` | Triangulating the region polygon that becomes the cutter's top and bottom. |
| `three.js` | The 3D view and the drag handles. |
| Own XML reader, own ZIP writer | The XML reader runs identically in node tests and the browser. JSZip's writer scheduled every 16 KB chunk through a timer and took minutes on a 30 MB project in a browser tab (measured: 492 s for the S2 hubcap); the own writer uses the browser's CompressionStream. JSZip is still used for reading. |

## How the cut works

- The design surface has a frame: a viewing direction, an up vector, an origin. Design mm
  map to the surface's local (u, v) plane 1:1, then through the volunteer's placement.
- Each filament slot's region (all colors in the slot, all designs on the surface, unioned,
  simplified to 0.08 mm) is extruded by Manifold into a tall prism and intersected with a
  **slab**: a grid mesh (2 mm) whose top sits 1 mm above the part's surface and whose floor
  sits `depth` below it, every grid point's height read off the part along the viewing
  direction (`HeightSampler`, a grid-bucketed ray cast). The slab's size depends on the
  surface's area, not on the outline's complexity, which is what keeps a thousand-stripe fill
  affordable. On a flat face (relief under 0.2 mm) the slab is skipped and the prism is cut
  straight to depth. Either way the recess is a uniform depth into the surface, on the chair
  as on the wheel.
- Where the wall under a grid point is thinner than depth + 0.6 mm, the floor is pulled up
  locally. A thin spot no longer costs the whole color; the warning says the shallowest depth
  used and how much of the area was affected.
- Two earlier cutters were replaced. A hand-built heightfield (earcut + edge refinement)
  produced non-manifold solids on tiled fills. Manifold's own `refineToLength` + `warp`
  was valid but blew up on sliver triangles: a 1000-stripe fill made a 268k-triangle cutter
  and a 27 s cut. The slab design cuts the same fill in about 10 s in node.
- The cut runs in a Web Worker so the page stays responsive; a job made stale by a new edit
  terminates its worker, because a boolean cannot be interrupted.
- Inlay = body ∩ cutter, body = body − cutter, in slot order, so inlays never overlap.
- A design across a join is cut into every piece the cutter reaches. Alignment across the
  join is by construction: one projection, several pieces.

Known limit: projection stretches a design on a steep surface. On the chair's sides the
surface is close to planar; on the fenders it is not. Nothing measures the stretch yet.

## Assumptions written into `src/parts/catalog.ts`

Read off the meshes: the chair's +X is its left, +Y is up, +Z is its front.

| Surface | Direction | Pieces | Basis for the choice |
| --- | --- | --- | --- |
| Left / Right side | ±X | handle, storage, wheel mount | Their outer faces share the plane x = ±170. |
| Back | −Z | seat back top + bottom | The backrest's rear at z = −501. Storage and handles reach further back but are not "the back" a volunteer means. |
| Front | +Z | seat back top + bottom | The backrest's front, where the child leans. |
| Seat side left / right | ∓X | the handle on that side | The armrest's inner face is the one visible from the seat. Uncertain. |
| Fender left / right | ±X | the wing on that side | Wings sit outboard at x = ±190. |

Three pieces carry no surface and export uncut: the seat center (under the cushion) and the
two caster mounts, as the brief says.

The hubcap frame is pinned at (0, 27.3, 0) in the reference cap's frame: disc top centre,
underside at y = 24.3 on the wheel face, so the generated disc and the clips file line up.

## Depth rules

- Floor 0.2 mm: a 0 is raised and reported.
- Wall keep 0.6 mm (three layers) behind every recess floor.
- Cap: per vertex, from the measured wall under the design, not a per-part number.

## Colors and slots

- Auto-merge uses CIE76 ΔE in Lab: slight 5, medium 12, strong 22.
- Slot 1 is always the body. A color sent to the body is not cut. A color that lands on no
  piece is reported and gets no filament number.
- Filament names come from the nearest entry in `reference/filaments.json`.

## Export format

Bambu's split layout: root `3D/3dmodel.model` with components, one `3D/Objects/object_N.model`
per printed piece holding the body and each inlay as parts, `Metadata/model_settings.config`
with per-part `extruder`, `Metadata/project_settings.config` with presets and overrides.
Plates are laid out in Bambu's grid (columns = ceil(√plates), 10% gap). **Not yet opened in
a real slicer in this environment (no GUI).** The file round-trips through this tool's own
3MF reader and the structure follows what Bambu Studio 1.9 writes; the first check in Bambu
Studio and Snapmaker Orca is the next thing to do.

## What is not done

- No verified placements (see above).
- Silhouette hubcaps have vertical edges, not the 1 mm chamfer.
- Colors reaching a silhouette hubcap's outline are recessed like any other, not cut through.
- Fill on the chair body is off (the brief allows it; a fill on a curved multi-piece surface
  needs a tile budget measurement first).
- Stretch on curved surfaces is not measured or shown.
- No wall-thickness map in the 3D view; the warning text is the only signal.
- The overlap warning uses boxes, not shapes.
- The trace runs on the main thread; a big photo blocks the page for a second or two.

## Measurements

All in node on this machine unless noted (`npx vitest run`, console output of the tests, and
`npm run evidence` for the browser figures).

| What | Figure |
| --- | --- |
| Cow SVG cut into the wheel, 1 mm, two colors | 0.5 s, inlay volume 3600 mm³ = 60 × 60 × 1 |
| Zebra fill on the footrest (29k outline points per color after simplification) | cutter 3 s per color, booleans 1–5 s per color, ≈ 10 s in all; 22 s with the earlier refine+warp cutter |
| Silhouette hubcap (4000-point outline) + 1 color cut + write | solid 0.1 s, cut 1.6 s, write 1.1 s, 1.6 MB |
| S2 hubcap export in headless Chromium | with JSZip's writer 492 s; with the own ZIP writer the whole scenario is under 30 s (`evidence/RESULTS.md`) |
| Unit tests | 24, ≈25 s (the fill test is most of it) |

## Evidence

`npm run evidence` builds the app, drives it in headless Chromium through the eight scenarios
in `EVAL.md`, and writes `evidence/RESULTS.md`, one screenshot and the exported 3MF per
scenario. The photograph scenario uses a synthetic photo-like JPEG because the kit ships no
photograph; that file is saved beside the result.
