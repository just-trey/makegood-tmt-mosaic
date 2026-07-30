# TMT Mosaic — SVG Color-Inlay Generator

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.6.0--beta-orange.svg)](CHANGELOG.md)

A browser app that turns a flat-color SVG into per-color recess geometry for
multicolor/AMS 3D printing, and exports a print-ready project 3MF — parts
placed on build plates, every recess pre-named and pre-assigned to its own
Generic PETG filament slot with the detected colors, 15% gyroid infill and
tree (auto) support pre-set, so it opens ready to slice in **Bambu Studio,
OrcaSlicer, or Snapmaker Orca** (pick your printer from the export panel —
Bambu X1C/P1S/A1/H2D or Snapmaker U1). A per-color STL set is available as a
fallback for other slicers.

Built for [MakeGood](https://makegood.design)'s Toddler Mobility Trainer
(TMT) — a free, open-source 3D-printable mobility device for children ages
1–8, distributed via [3d-mobility.org](https://3d-mobility.org).

This project is in **beta** (pre-1.0, see [Versioning](CONTRIBUTING.md#versioning))
— exported file formats and supported inputs may still change between minor
releases.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for setup,
PR guidelines, and the versioning policy. This project follows a
[Code of Conduct](CODE_OF_CONDUCT.md). Released under the [MIT License](LICENSE).

## Running it

Development:

```bash
npm install
npm run dev      # dev server with hot reload
```

Other scripts:

```bash
npm test             # unit tests (Vitest)
npm run typecheck    # TypeScript, no emit
npm run build        # typecheck + production build to dist/
npm run preview      # serve the production build locally
```

Everything runs client-side — no backend, no data leaves the browser. All
dependencies (three.js, Turf, JSZip, the Manifold WASM engine) are bundled at
build time, so the deployed app has no runtime CDN dependencies. The Google
Fonts stylesheet is the only external request.

## Deployment

Pushing a version tag (`vX.Y.Z`) builds and deploys `dist/` to **GitHub
Pages** via [.github/workflows/deploy.yml](.github/workflows/deploy.yml) — see
[CONTRIBUTING.md](CONTRIBUTING.md#versioning). Merging to `main` does not
deploy by itself; a manual `workflow_dispatch` run is also available for an
out-of-band deploy. One-time setup: repo **Settings → Pages → Source → GitHub
Actions**.

**Analytics (optional).** The Umami analytics script is injected at build
time only when `UMAMI_WEBSITE_ID` is set — as a repo **Variable**
(Settings → Secrets and variables → Actions → Variables) for the deploy, and in
a local `.env.local` for local builds (see [.env.example](.env.example)).
Unset — as in any fork — and no script is injected, so forks never report to
your account. Beyond pageviews, a few cookieless custom events track feature
usage (artwork loaded, mode switched, export completed) — no file names, file
contents, or other personal data are ever sent. See
[docs/analytics.md](docs/analytics.md) for the full event catalog.

## How it works

1. **The SVG is parsed as vectors, not pixels** ([src/svg/](src/svg/)) — the
   `<path>`/`<rect>`/`<circle>`/etc. geometry is read directly, transforms
   composed, curves flattened, and shapes grouped by fill color. Bezier curves
   are flattened adaptively (recursive subdivision to a fixed deviation
   tolerance, [src/svg/path.ts](src/svg/path.ts)) rather than at a fixed
   segment count, so gentle curves emit few points and only sharp/detailed
   curves emit many — fewer total vertices flowing into the boolean pass below
   without losing visible fidelity.
2. **Each color's _net visible_ region** is computed with paint order taken
   into account — an outline drawn on top of a fill has its footprint
   subtracted from the fill's region, matching what the rasterized image would
   show. 2D polygon booleans via Turf.js ([src/geometry/regions.ts](src/geometry/regions.ts)).
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
   boundaries — pure 2D math, no CSG ([src/geometry/flat.ts](src/geometry/flat.ts)).
5. **Assembly mode** cuts pockets into real part meshes: each color region is
   extruded into a prism in the part's own coordinates and booleaned against
   the mesh with [Manifold](https://github.com/elalish/manifold) (WASM CSG,
   lazy-loaded) ([src/geometry/assembly.ts](src/geometry/assembly.ts)).
   Supports rotated-copy parts (the same physical part installed twice, e.g.
   a wheel's two halves): the design slice that lands on the copy is remapped
   back into the part's native print orientation. Round parts (the wheel) map
   the SVG via a Design-radius/circle model; rectangular parts (the footrest)
   map it 1:1 in millimeters and auto-center on the detected face instead. A
   part can also carry more than one design surface (**design zones**) baked
   ahead of time by `scripts/bake-zones.mjs` — the chair body has five
   (left/right/front/back/seat), each its own true-scale UV chart the artwork
   wraps onto **conformally** (a sticker follows the surface around a rounded
   edge the way real vinyl would, not a flat orthographic stamp)
   ([src/geometry/conformal.ts](src/geometry/conformal.ts)). A zone spans the
   printed parts under it rather than stopping at a part boundary — the
   chair's left/right zones run from the storage side across the handle and
   wheel mount onto the front fender — and artwork laid across a seam is
   split, cut into each part separately, and exported under that part's
   object. Load more than one design, then target each zone from the Artwork
   list's per-row dropdown or by clicking the surface directly in the 3D
   view. A kind with hardware
   variants (the chair's Standard/Kit caster mounts) shows a version picker
   above the part list; switching reloads only the parts that differ. Any
   artwork row on an assembly part can switch from **Sticker** (one copy) to
   **Fill**, which repeats the design across the whole zone, tiled in the
   design's own SVG coordinate space so the tiling stays correct under
   whatever rotation/scale the zone's mapping applies
   ([src/geometry/patterns.ts](src/geometry/patterns.ts)). The Artwork panel
   ships a small built-in library of tileable patterns (Cow, Dalmatian,
   Zebra, Tiger — [scripts/gen-patterns.mjs](scripts/gen-patterns.mjs)
   generates them) that default to Fill mode when loaded on an assembly
   part.
6. **Export** writes a Bambu Studio _project_ 3MF (vendor metadata included,
   so it imports without warnings, with named parts, per-part filament slots,
   and multi-plate placement) ([src/export/threemf.ts](src/export/threemf.ts)).
   The target printer ([src/export/printers.ts](src/export/printers.ts))
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

### Code layout

- [src/state/store.ts](src/state/store.ts) — the single app-state object all
  geometry reads; UI panels write to it and schedule a rebuild
- [src/state/filaments.ts](src/state/filaments.ts) — the owned-filament
  palette, loaded from [public/filaments.json](public/filaments.json). Edit
  that file to change the colors offered by the base-color picker and used
  for "nearest filament" labels — no code changes needed.
- [src/state/patterns.ts](src/state/patterns.ts) — the built-in pattern
  library manifest, loaded from
  [public/patterns/patterns.json](public/patterns/patterns.json). Add a new
  pattern in [scripts/gen-patterns.mjs](scripts/gen-patterns.mjs) and re-run
  it rather than hand-editing the SVGs or manifest.
- [src/app/rebuild.ts](src/app/rebuild.ts) — orchestrates state → geometry →
  scene → side panels
- [src/scene/viewport.ts](src/scene/viewport.ts) — three.js renderer/camera
- [src/ui/](src/ui/) — one module per left-panel section
- [src/assembly/](src/assembly/) — assembly kinds (roles) and part loading

### Adding an assembly or library part

Assemblies are defined in [src/assembly/kinds.ts](src/assembly/kinds.ts) —
one entry per assembly, listing its part roles. A role's `libraryPartId`
links to [public/stl/parts.json](public/stl/parts.json); drop the STL/3MF in
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
  see [src/assembly/kinds.ts](src/assembly/kinds.ts) for a worked example. When
  the SVG declares no absolute mm size (some editors export `width="100%"` and
  rescale the viewBox), rect placement fits the viewBox to the part face rather
  than assuming 1 unit = 1 mm, so a template trace still lands life-size.

**Export placement is baked from a verified reference 3MF, never computed or
read at runtime.** Once a part's real-world print pose has been checked in the
slicer (a reference project file the user hand-verified — rotation, plate
position, prime/wipe tower placement, per-part print settings), those numbers
become constants in [src/export/threemf.ts](src/export/threemf.ts), wired
onto the part's `ExportPart` by `resolvePlacement` in
[src/export/placement.ts](src/export/placement.ts):

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
bbox hash) that [src/geometry/zoneCharts.ts](src/geometry/zoneCharts.ts) uses
to guard baked zone charts. Every `public/stl/parts.json` entry is sealed in
[src/export/partFingerprints.ts](src/export/partFingerprints.ts) (generated —
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
run it through [scripts/pack-part.mjs](scripts/pack-part.mjs), which re-indexes
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
`load3MF` ([src/geometry/meshparts.ts](src/geometry/meshparts.ts)) only reads
meshes inlined in `3D/3dmodel.model`, and BambuStudio's production-extension
format references them from a separate internal file via
`<component p:path="...">` instead. Packing from a CAD `.stl` sidesteps that
entirely, which is the recommended path.

## Known limitations

- **Flat, roughly horizontal faces only, unless the part ships baked design
  zones.** A part with no zone sidecar assumes its design face is horizontal
  in the part's own coordinates (the app warns otherwise) and projects
  artwork straight down onto it — no curved-surface wrapping. A part that
  does ship zones (the chair body) wraps artwork conformally onto each
  zone's baked UV chart instead; adding zones to a new part means running
  `scripts/bake-zones.mjs` (see "Adding an assembly or library part" above).
- **A design crossing a printed join lines up only as well as the print
  does.** The chair's design surfaces span several printed pieces, and a
  design laid across a join is cut into each piece separately against one
  shared unwrap — so the halves meet exactly in the model, but on the bench
  they meet as well as tolerance, warp, and how hard you press the pieces
  together allow. Keep fine detail (thin lines, small text) away from the
  dashed seams on the template if that matters to you.
- **Large wrapped surfaces stretch the artwork somewhat.** Flattening a
  curved surface cannot preserve every distance at once; the chair's
  surfaces run 1.11–1.28× at their worst spots (the bake reports the number
  per surface), concentrated where the surface turns hardest. Even coverage
  like a pattern fill hides this; a perfect circle placed across a corner
  will not stay perfectly circular.
- **"Largest flat patch" is a heuristic.** The auto-picked design face is the
  largest coplanar patch by area; a part with an equally large decorative flat
  face could fool it. The Advanced per-part controls let you pick a different
  detected face — check the reported normal/offset on a new part.
- **Input parts must be watertight/manifold** for assembly cutting. If a part
  isn't, it's named in an on-screen warning and exported uncut.
- **No wall-thickness safety check.** Pocket depth is user-supplied and not
  validated against the part's interior — a depth deeper than the material
  behind the face will cut through. Sanity-check depths against your model.
- **Gradients/patterns are detected and skipped** with a warning, rather than
  silently producing wrong geometry.
- **Fill (repeat the design across a surface) is assembly-mode only.** The
  flat-plate shapes (disc/rect/round/STL) run a separate pipeline that places
  a single design and auto-fits it to the plate; an artwork row's
  Sticker/Fill control only appears on an assembly part. Fill also assumes
  the design tiles — its repeat is one SVG document, so a design whose edges
  don't line up will show seams.
- **The chair body's prime-tower positions are verified on 270mm and 256mm
  beds only.** Each plate's tower was placed by hand in the slicer against
  real four-filament geometry and baked as an offset from that plate's anchor
  part, so it travels with the part when a different bed size re-centers the
  plate. Both shipped bed sizes were checked separately, and seven of the ten
  towers transferred between them unchanged; the two wheel-mount plates and
  one handle plate needed their own 256mm values and carry them. Any _other_
  bed size inherits the 270mm positions untested. The caster plate prints one
  filament and has no tower at all. See "TODO / tech debt" below.
- **Parts the reference sets to manual tree support arrive without the
  painted enforcers.** The handles, wheel mounts, storage boxes, and seat
  center carry `support_type = tree(manual)` from the reference project,
  which relies on support enforcers painted onto the mesh. Those live as
  per-triangle mesh attributes the exporter doesn't write, so the setting
  arrives and the painting doesn't. Paint them yourself, or switch those
  parts to auto support, before printing.
- **The caster mounts can't carry artwork.** All four (Standard and Kit, left
  and right) are the only chair pieces missing from the zone sidecar, so no
  zone reaches them, their plate exports in the body color alone, and it gets
  no prime tower. That isn't because they have no surface to decorate — each
  has a 10,395 mm² flat upward face at y = 120, identical between the two
  variants. See "TODO / tech debt" below for what adding a zone would take.

## Troubleshooting: "Boolean union/subtraction failed" warnings

Turf's polygon booleans can throw on a specific color's geometry — almost
always a self-intersecting path in the source SVG. The warning names the hex
color involved.

What the app already does automatically: every loop is deduplicated of
near-identical floating-point vertices before it reaches Turf (the most common
cause is two flattened curve segments meeting at a seam that differs by a
fraction of a unit), degenerate slivers are scrubbed from boolean outputs, and
failed operations retry at reduced coordinate precision. If a warning still
appears:

- **That region falls back to its pre-boolean shape** — geometry still
  exports, but the region may overlap its neighbor slightly instead of having
  the overlap cut out.
- The real fix is cleaning the path at the source. In Illustrator or
  Inkscape: select the offending color's path and run **Path → Union** on it —
  the standard way to force a self-intersecting path back into a simple one.
- Common sources: strokes converted to fill outlines (sharp miter joins),
  leftover boolean results from the design tool, hand-edited paths with
  crossed segments.

## Troubleshooting: "Couldn't build the cut solid" warnings (assembly mode)

Assembly mode clips each color's region to the part's face boundary, then
extrudes it into a 3D pocket. Dense or detailed line-work (fine outlines,
small highlight shapes) can come out of that clip touching itself at a point
without Turf treating it as invalid — but Manifold's boolean engine rejects
the resulting mesh as non-watertight when building the pocket. The app
automatically repairs this (via Manifold's own 2D boolean engine, offsetting
the region by a hair and back to break the exact-touching topology) and
retries before giving up. If the warning still appears, that color's pocket
was skipped on that part — same source fix as above (clean the path in
Illustrator/Inkscape) usually resolves it.

The 3D boolean pass can also fail later, past a single color's pocket. Each
of those failures degrades to something a slicer can print rather than a
malformed file, and the warning tells you which outcome you got — worth
reading before printing, because two of them mean the part carries less
artwork than you designed:

- **"Couldn't combine the cut solids for color … on …"** — that one color is
  dropped from that part. Every other color still cuts normally.
- **"… exporting it uncut"**, or **"Boolean cut failed on part … — exporting
  it uncut and without inlays"** — that part ships with no artwork at all. It
  is still a valid printable part, just a blank one, so don't print it
  expecting the design.
- **"Couldn't fit the inlay for color … — its pocket is cut into the body but
  will print as an empty recess"** — the recess is cut but nothing fills it,
  so that color prints as a bare cavity.
- **"Part … has no geometry to export — its pocket cut went all the way
  through …"** — the boolean _succeeded_ but produced zero geometry: a
  pocket's depth reached (or exceeded) the part's wall thickness at that
  point, cutting clean through instead of leaving a floor. That part is
  dropped from the export entirely rather than shipping a hollow shell.

These are Manifold 3D boolean failures rather than the 2D clip problem above,
so path-cleaning is less reliably the fix; if one reproduces, the part mesh
and the amount of fine detail landing on it are both worth suspecting. What
these are _not_ is silent: before this handling existed, the same failures
either aborted the whole rebuild (blank viewport) or shipped the uncut body
alongside inlay solids occupying the same volume, which a slicer resolves
arbitrarily.

## Design system

The visual language is the TMT Mosaic design system — dark navy/blue,
sharp-cornered, WCAG AA contrast. Tokens live in
[design-system/tokens/](design-system/tokens/) (the spec) and are mirrored in
[src/styles.css](src/styles.css) (the shipped copy) — update both when tokens
change. Everything else under [design-system/](design-system/) is
**reference only** (specimen pages and React component examples); none of it
is imported by the app. Two other brand themes in the tokens folder
(3d-mobility.org, makegood.design marketing) are not used by this tool.

## Roadmap ideas (not built)

- Raster image (PNG/JPG) input: quantize to flat color regions, then reuse the
  existing region pipeline.
- Dead zones: mark the parts of a design zone that are hidden by an adjacent
  part — joints, overlaps, undersides — where a filament change buys nothing.
  A design placed across one wastes color changes on surface nobody sees.
  Shape: a bake step that casts each zone triangle outward, tests occlusion
  against every other part, and emits a `deadRegions` UV polygon set that the
  runtime subtracts from the clip region and the template draws hatched, so
  the artist can see where not to put detail.
- Quarter-wheel assembly kind (4 quarters + 2 mounting plates) alongside the
  existing half-wheel (Top ×2 + Cap) kind, and a hubcap part for the wheel
  assembly.
- A full parent-handle assembly kind.

## TODO / tech debt

- **The chair's prime-tower positions have only been verified on one bed
  size.** All of its export placement — plate assignment, rotation, position,
  the per-part brim/support/infill overrides, and now the tower — is baked by
  [scripts/bake-chair-placement.mjs](scripts/bake-chair-placement.mjs) into
  [src/export/chairPlacement.ts](src/export/chairPlacement.ts) from two
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
  350x320 `bambu-h2d` entry in [src/export/printers.ts](src/export/printers.ts)
  is the one that exists today, and the first non-square bed of the three.
  Adding a bed means another pass:
  `scripts/export-chair-examples.mjs` builds the files, and the bake takes one
  `--towers` file per bed and works out for itself which plates disagree.
  The caster plates stay on `suggestTowerPos` in
  [src/export/threemf.ts](src/export/threemf.ts), which is correct — they
  print one filament and get no tower.
  One loose end in the tooling: whether `wipe_tower_x/y` names the tower's
  center or its origin corner isn't pinned down, so the export script only
  checks that a tower lands on the bed, not that a given footprint clears the
  edge. Both reference files put a tower at exactly x = 15 on a 256mm bed,
  which a center-based check would wrongly reject.
- **The caster mounts have no design zone, and settling that means settling
  what the "central rear brace" is.** They are absent from
  [scripts/zone-configs/chair-body.json](scripts/zone-configs/chair-body.json)'s
  part list — the other eleven pieces are all in it — on the call recorded in
  [docs/chair-body-plan.md](docs/chair-body-plan.md) that "caster mounts and
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
- **Rebuild performance needs ongoing work — this is a heavy application.**
  A dense 135-path SVG still takes ~13s to rebuild in flat mode, ~9s of
  which is the paint-order boolean pass in
  [src/geometry/regions.ts](src/geometry/regions.ts)
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
- **Region computation is O(n²·len) per path**
  ([regions.ts:357](src/geometry/regions.ts#L357), `shapes.map(shapeToFeature)`,
  before the first yield) — `shapeToFeature`'s containment-depth resolution
  tests every subpath ring against every other ring with a point-in-polygon
  scan. Benchmarked against production/sample SVGs
  ([scripts/bench-shape-to-feature.ts](scripts/bench-shape-to-feature.ts)):
  worst real-world case measured 5.88 ms (`public/patterns/zebra.svg`, a
  single 69-subpath path), an order of magnitude under the 30 ms yield
  budget — not a live issue on any file currently in use. Risk case is a
  dense Illustrator export (hundreds of subpaths in one `<path>`, e.g.
  fur/stipple line art) that no current sample exercises. Revisit if/when
  such a file is actually encountered, rather than guessing a threshold now.
- **The chair's zone sidecar is 1.7 MB raw / 638 KB gzipped**
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
- **A seam sliver warns as if artwork were lost.** Where two parts' claims on
  a zone overlap, clipping a color to one part's `subRegions` can leave a
  remnant a fraction of a millimetre wide. It survives the turf clip, then
  yields no cutter, and
  [src/geometry/assembly.ts](src/geometry/assembly.ts) reports "Couldn't build
  the cut solid for color … on …" — alarming, and indistinguishable from the
  real failure it shares a message with. Confirmed in the app (2026-07-28): a
  design on `back` warned for three colors on "Seat back (bottom)" while
  printing correctly. The overlaps are inherent to per-part clipping and small
  — measured across the shipped bake, 23 overlapping part pairs, all
  seam-sharing, worst 29.85 mm² on a 124,500 mm² zone (a ~0.15 mm ribbon), and
  `tests/chair-zones.test.ts` holds them under 0.05% of zone area. Fix: drop a
  clip remnant under an area floor _before_ `buildCutter` rather than
  attempting it and warning. Pick the floor above the measured ribbon and well
  under anything printable.
- **Zone picking has no occlusion test**
  ([src/scene/zonePick.ts](src/scene/zonePick.ts)) — it raycasts only the
  invisible chart meshes (three.js 0.160's `intersectObject` ignores
  `visible`, which is what makes picking work at all), but the real bodies
  aren't in the target list, so clicking a handle in front of a zone selects
  the zone behind it. Fix: raycast the visible parts too and reject a zone hit
  farther than the nearest solid hit. Gets worse as zones multiply — the chair
  went from 4 to 5 with the full-coverage re-author.
- **`FILL_SNAP_MM = 2` rests on a stale measurement.** The comment at
  [src/geometry/conformal.ts](src/geometry/conformal.ts) cites ~0.9 mm of
  baked-boundary overhang; measured against the shipped bake it was 0.001 mm
  at baked vertices and 0.197 mm densified — inside `CHART_SNAP_MM = 0.5`. The
  fill guard is roughly 10x looser than it needs to be, so genuinely misplaced
  fill artwork snaps silently instead of warning. Re-measure against the
  current whole-chair zones (bigger zones may legitimately want more slack)
  and set it from that number rather than nudging it.
- **One warning covers three different failures**
  ([src/geometry/assembly.ts](src/geometry/assembly.ts)) — "Raise Scale to
  fill the surface" is the advice whether `tileCoverage` refused on tile
  count, non-invertibility, or non-affinity. It is right for the first and
  misleading for the other two. Split the message per cause.
- **Keep `@turf/turf` pinned to 6.5.0 — v7 is a measured perf regression
  here.** A 7.3.5 upgrade was fully implemented and benchmarked (2026-07):
  correct output, but its new polygon-clipping engine ran **5–10x slower**
  on this app's union-accumulation hot path (40ms → 215ms at 20 shapes,
  76ms → 726ms at 120), turning slow rebuilds into multi-minute ones. Don't
  re-attempt without benchmarking that path first. The 6.5 quirks remain:
  the boolean-failure workarounds in
  [src/geometry/regions.ts](src/geometry/regions.ts) (degenerate-ring
  scrubbing, precision-truncation retries) target 6.5's exact
  polygon-clipping bugs, and 6.5's package typings don't resolve under
  modern TypeScript, hence the shim in [src/turf.d.ts](src/turf.d.ts).
- **The export-placement seal proves a mesh hasn't changed, not that anyone
  re-verified it.** `PART_FINGERPRINTS` is generated
  ([scripts/bake-part-fingerprints.mjs](scripts/bake-part-fingerprints.mjs)),
  and re-packing a part without resealing is caught loudly — the seal test
  in [tests/placement.test.ts](tests/placement.test.ts) fails. The gap is the
  step after: resealing is a single command that will happily re-bless a mesh
  whose print pose nobody re-checked in the slicer, which is exactly the
  motion someone takes to make the failing test go away. It is deliberately
  _not_ wired into `pack-part.mjs` for that reason (auto-resealing would
  delete the tripwire), so the guarantee rests on the reminder that script
  prints and on the add-part skill. Closing this properly means recording
  _what_ was verified — the reference file and its hash — alongside the mesh
  fingerprint, so a reseal against an unchanged reference is distinguishable
  from one that silently redefines the verified pose.
- **Per-part export placement is a lookup table in
  [src/export/placement.ts](src/export/placement.ts), not part of the part
  definition.** It used to be an `if (roleId === …) else if …` chain; the
  chair's fifteen pieces turned that into a `PLACEMENT` record keyed by
  library part id, so adding a part is now a data change rather than a code
  one. It still lives apart from the role it describes, though — these are
  per-part constants and belong as data on the `AssemblyKind` / role
  definition, matching the "one array entry" goal in
  [src/assembly/kinds.ts](src/assembly/kinds.ts).
- **The footrest's `objectSettings` literal (`brim_type: 'no_brim'`,
  `enable_support: '0'`) is duplicated** between the export path in
  [src/export/placement.ts](src/export/placement.ts) and its assertion in
  [tests/threemf.test.ts](tests/threemf.test.ts). Extract a shared
  `FOOTREST_OBJECT_SETTINGS` constant so the test verifies the real value
  instead of a hand-copied duplicate that can silently drift.
- **The footrest's baked `FOOTREST_PLATE_R` is redundant** with the general
  `rotXthenZ(-90 * nsign, angleDeg)` path for `nsign: 0` + `rotZdeg: -45`
  (see [src/export/threemf.ts](src/export/threemf.ts)). It's kept as an
  explicit full 3×3 for now because it generalizes to a future part with a
  genuinely tilted reference pose that the axis-aligned path can't express —
  revisit if that part never materializes.
- **Rect placement takes its scale from the document but its position from the
  artwork**, so it discards where you drew things. `svgC` is set to the artwork
  bbox center for rect parts ([src/geometry/assembly.ts](src/geometry/assembly.ts),
  near the top of `buildAssemblyGeometry`), while `mmPerUnit` comes from
  `userUnitMM` or the viewBox — two different frames. Verified: a 10mm square
  drawn in the top-left corner of a 40×40mm document, on a 40×40mm face, lands
  at x −5..5 / z −5..5 — dead center, not the x −20..−10 / z 10..20 where it was
  drawn. This matters most for the footrest template, whose header tells you to
  keep artwork clear of the mounting-slot gaps: clearance is expressed by
  _position_, which is exactly what gets thrown away. It only appears to work
  when the grey canvas path is kept (artwork bbox == template bbox, so
  re-centering is a no-op); delete the grey and the layout silently collapses to
  center. Proposed fix: anchor rect placement on the document frame (viewBox or
  declared mm box) and fall back to the artwork bbox only when there is no frame
  — matching wheel mode, which already anchors on a document feature (the design
  circle) and only falls back to a bbox pseudo-circle with a notice. Note this
  shifts existing off-center designs to where they were actually drawn, and
  `rect designFit centers the design on an off-center face` in
  [tests/assembly.test.ts](tests/assembly.test.ts) pins the current behavior, so
  it needs rewriting as part of the change.
- **Rect placement derives one artwork scale from the largest face across all
  parts** ([src/geometry/assembly.ts](src/geometry/assembly.ts),
  `buildAssemblyGeometry`) while `placeOnPart` honors each part's _own_ face
  center. Harmless today — the only rect kind (footrest) has a single face —
  but a future rect assembly mixing face sizes would scale artwork for the
  biggest face and then center that same oversized artwork on the smaller
  ones, where the face clip would crop it. Fix when such a part ships: either
  scale per-part, or make the reference face an explicit choice on the
  `AssemblyKind` rather than "whichever is largest".
- **The CSG failure branches are asserted one layer above the file that
  ships.** The `CSG failure handling` tests in
  [tests/assembly.test.ts](tests/assembly.test.ts) pin the in-memory
  `AssemblyPartOutput` — `bodySoup` equal to the untouched positions,
  `inlaySoups` empty — but nothing asserts what `build3MFCombined` actually
  writes, and the bug those branches exist to fix was an _export_ bug: an
  uncut body shipping alongside inlay solids occupying the same volume. The
  claim still unpinned is that a part which failed to cut emits exactly one
  object and zero inlay objects in `3D/3dmodel.model`. The machinery is
  already present — [tests/threemf.test.ts](tests/threemf.test.ts) unzips a
  built 3MF with JSZip and reads that entry (see its `itemTransforms` /
  `projectSettings` helpers) — so the fix is an analogous helper returning the
  per-part object set, asserted from the failure tests. The other half: none
  of these branches has been watched degrading in the running app either, only
  under mocked `Manifold.union` / `.difference` / `.intersection`, so a
  dev-only forced throw is what would make a live check repeatable rather than
  a hand-edit each time.
- **The warning panel can hide the warnings that matter most, and the CSG
  failure messages are the worst fit for it.**
  [src/ui/warningsView.ts](src/ui/warningsView.ts) renders only
  `WARNINGS.slice(0, 6)` as pills and collapses the rest into "+ N more
  warnings", with no way to read them. Dedupe in
  [src/warnings.ts](src/warnings.ts) is by exact message and these messages
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
