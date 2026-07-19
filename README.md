# TMT Mosaic — SVG Color-Inlay Generator

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.4.1--beta-orange.svg)](CHANGELOG.md)

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
3. **Flat-plate mode** builds the plate as a stack of flat slabs between depth
   boundaries — pure 2D math, no CSG ([src/geometry/flat.ts](src/geometry/flat.ts)).
4. **Assembly mode** cuts pockets into real part meshes: each color region is
   extruded into a prism in the part's own coordinates and booleaned against
   the mesh with [Manifold](https://github.com/elalish/manifold) (WASM CSG,
   lazy-loaded) ([src/geometry/assembly.ts](src/geometry/assembly.ts)).
   Supports rotated-copy parts (the same physical part installed twice, e.g.
   a wheel's two halves): the design slice that lands on the copy is remapped
   back into the part's native print orientation. Round parts (the wheel) map
   the SVG via a Design-radius/circle model; rectangular parts (the footrest)
   map it 1:1 in millimeters and auto-center on the detected face instead.
5. **Export** writes a Bambu Studio _project_ 3MF (vendor metadata included,
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
   its plate is reported as an on-screen warning rather than assumed safe.

### Code layout

- [src/state/store.ts](src/state/store.ts) — the single app-state object all
  geometry reads; UI panels write to it and schedule a rebuild
- [src/state/filaments.ts](src/state/filaments.ts) — the owned-filament
  palette, loaded from [public/filaments.json](public/filaments.json). Edit
  that file to change the colors offered by the base-color picker and used
  for "nearest filament" labels — no code changes needed.
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
onto the part's `ExportPart` in
[src/ui/exportPanel.ts](src/ui/exportPanel.ts):

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

**A note on 3MF sources**: `load3MF` ([src/geometry/meshparts.ts](src/geometry/meshparts.ts))
only reads meshes embedded inline in `3D/3dmodel.model`. Some slicer exports
(BambuStudio's production-extension format, used for the footrest's source
file) instead reference the mesh from a separate internal part file via
`<component p:path="...">`, which `load3MF` does not resolve. If a part loads
as empty/zero-triangle, check for this and flatten the file (inline the
referenced part's `<mesh>` into a single `<object>`, dropping the
`<component>` reference) before adding it to `public/stl/`.

## Known limitations

- **Flat, roughly horizontal faces only.** Assembly cutting assumes the design
  face is horizontal in the part's own coordinates (the app warns otherwise).
  No curved-surface wrapping.
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

- Pick a face directly in the 3D view (raycast → detected patch) to apply
  artwork to any part.
- Raster image (PNG/JPG) input: quantize to flat color regions, then reuse the
  existing region pipeline.
- Curved-surface wrapping.
- Quarter-wheel assembly kind (4 quarters + 2 mounting plates) alongside the
  existing half-wheel (Top ×2 + Cap) kind, and a hubcap part for the wheel
  assembly.
- A full parent-handle assembly kind.

## TODO / tech debt

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
- **Per-part export placement is a hardcoded `roleId` if/else in
  [src/ui/exportPanel.ts](src/ui/exportPanel.ts)** — each part's plate hint,
  rotation, `plateR`, `fixedPos`, prime-tower delta, and object settings are
  assigned by an `if (roleId === 'top') … else if ('cap') … else if
('footrest')` chain. Every new assembly part means editing that chain.
  These are per-role constants; they belong as data on the `AssemblyKind` /
  role definition (or the part's `ExportPart`) so adding a part stays a
  data-only change, matching the "one array entry" goal in
  [src/assembly/kinds.ts](src/assembly/kinds.ts).
- **The footrest's `objectSettings` literal (`brim_type: 'no_brim'`,
  `enable_support: '0'`) is duplicated** between the export path in
  [src/ui/exportPanel.ts](src/ui/exportPanel.ts) and its assertion in
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
