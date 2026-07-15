# TMT Mosaic — SVG Color-Inlay Generator

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0--alpha-orange.svg)](CHANGELOG.md)

A browser app that turns a flat-color SVG into per-color recess geometry for
multicolor/AMS 3D printing, and exports a print-ready Bambu Studio project 3MF
— parts placed on build plates, every recess pre-named and pre-assigned to its
own filament slot with the detected colors, so it opens in Bambu Studio ready
to slice. A per-color STL set is available as a fallback for other slicers.

Built for [MakeGood](https://makegood.design)'s Toddler Mobility Trainer
(TMT) — a free, open-source 3D-printable mobility device for children ages
1–8, distributed via [3d-mobility.org](https://3d-mobility.org).

This project is in **alpha** (pre-1.0, see [Versioning](CONTRIBUTING.md#versioning))
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

Pushing to `main` builds and deploys `dist/` to **GitHub Pages** via
[.github/workflows/deploy.yml](.github/workflows/deploy.yml). One-time setup:
repo **Settings → Pages → Source → GitHub Actions**.

## How it works

1. **The SVG is parsed as vectors, not pixels** ([src/svg/](src/svg/)) — the
   `<path>`/`<rect>`/`<circle>`/etc. geometry is read directly, transforms
   composed, curves flattened, and shapes grouped by fill color.
2. **Each color's *net visible* region** is computed with paint order taken
   into account — an outline drawn on top of a fill has its footprint
   subtracted from the fill's region, matching what the rasterized image would
   show. 2D polygon booleans via Turf.js ([src/geometry/regions.ts](src/geometry/regions.ts)).
   Holes are resolved by **containment depth** (odd nesting depth = hole),
   which is correct for both the `nonzero` and `evenodd` SVG fill rules.
3. **Flat-plate mode** builds the plate as a stack of flat slabs between depth
   boundaries — pure 2D math, no CSG ([src/geometry/flat.ts](src/geometry/flat.ts)).
4. **Assembly mode** cuts pockets into real part meshes: each color region is
   extruded into a prism in the part's own coordinates and booleaned against
   the mesh with [Manifold](https://github.com/elalish/manifold) (WASM CSG,
   lazy-loaded) ([src/geometry/assembly.ts](src/geometry/assembly.ts)).
   Supports rotated-copy parts (the same physical part installed twice, e.g.
   a wheel's two halves): the design slice that lands on the copy is remapped
   back into the part's native print orientation.
5. **Export** writes a Bambu Studio *project* 3MF (vendor metadata included,
   so it imports without warnings, with named parts, per-part filament slots,
   and multi-plate placement) ([src/export/threemf.ts](src/export/threemf.ts)).

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
- In flat-plate STL-reference mode, the uploaded STL is **reference-only**:
  it guides sizing/alignment and the export is a flat insert plate, not a
  modified copy of the STL. (Assembly mode is the path that modifies real
  meshes.)

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
- Full assembled-chair view with drag-and-drop filament colors per part.
- Curved-surface wrapping.
- Adaptive Bezier flattening tolerance instead of a fixed segment count.

## TODO / tech debt

- **Upgrade `@turf/turf` from the pinned 6.5.0.** It's pinned deliberately:
  the boolean-failure workarounds in
  [src/geometry/regions.ts](src/geometry/regions.ts) (degenerate-ring
  scrubbing, precision-truncation retries) target 6.5's exact
  polygon-clipping bugs, and 6.5's package typings don't resolve under modern
  TypeScript, hence the shim in [src/turf.d.ts](src/turf.d.ts). Upgrading to
  Turf 7+ means: bump the dependency, delete `src/turf.d.ts`, re-test the
  boolean-heavy paths (`npm test` + `npm run smoke` + a complex real SVG),
  and only then consider simplifying the retry workarounds if the new
  clipping engine no longer needs them.
