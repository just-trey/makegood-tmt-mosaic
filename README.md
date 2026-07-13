# Mosaic — SVG Color-Inlay Generator (v1)

A single self-contained web app (`index.html`) that turns a flat-color SVG into
per-color recess geometry for multicolor/AMS 3D printing, and exports one STL
per color plus a `base.stl` for the uncut plate — ready to import into Bambu
Studio and assign filaments to.

Built for [MakeGood](https://makegood.design)'s Toddler Mobility Trainer
(TMT) — a free, open-source 3D-printable mobility device for children ages
1–8, distributed via [3d-mobility.org](https://3d-mobility.org).

## Running it

Just open `index.html` in Chrome or Edge (double-click it, or drag it into a
browser window). No install, no server, no build step.

It loads three.js, Turf.js, JSZip, and (in Assembly mode) the Manifold WASM
boolean engine from public CDNs the first time it opens, so you need an
internet connection for that — everything after that runs entirely in your
browser, no data leaves your machine.

This is deliberately **not** a packaged Electron app for v1 — it's a local
web app, which is a lot faster to iterate on and just as "double-click and
it opens" in practice. If you want an actual installed app icon later, this
is a good candidate to wrap in Electron or Tauri as a fast-follow.

Double-clicking `index.html` works for everything **except** the parts
library (see below), which needs a local HTTP server because browsers block
`fetch()` of local files opened via `file://`. To use the library, serve the
folder instead of double-clicking it:

```bash
npx serve .
# or: python -m http.server 8000
```

then open the printed `http://localhost:...` URL. Drag-and-drop upload
(SVG, and STL/3MF in Assembly mode) works either way.

## What v1 actually does

1. **Parse the SVG as vectors, not pixels.** Rather than rasterizing and
   contour-tracing, it reads the SVG's own `<path>`/`<rect>`/`<circle>`/etc.
   geometry directly and groups it by fill color. This is more exact than a
   raster approach and handles curves natively.
2. **Compute each color's *net visible* region**, accounting for paint order
   — if a black outline shape sits on top of a fill shape (your outline-color
   case), the fill's net region has the outline's footprint subtracted out
   automatically, the same way it would look if you rasterized the final
   image. This uses 2D polygon boolean ops (union/difference) via Turf.js.
3. **Builds the recess geometry as a stack of flat slabs**, not a general 3D
   boolean/CSG operation. Because v1 only targets flat faces with straight
   vertical pockets, subtracting a pocket from a flat plate is mathematically
   just a 2D operation repeated at each distinct depth level — no CSG library
   needed, which also means no CSG robustness issues (self-intersecting
   result meshes, etc.) to fight.
4. **Live 3D preview** via three.js, one mesh per color plus a base/plinth
   mesh, colored approximately to the source SVG.
5. **Manual fit control.** Auto-fit centers and scales the artwork to the
   margin you set, but you can override it: a Scale slider (25%–400%) sits on
   top of the auto-fit size, plus X/Y offset in mm to reposition off-center,
   with a one-click "reset to auto-fit." Useful for intentional bleed-to-edge
   designs or off-center placement.
6. **Merge colors into one recess.** Check two or more detected colors and
   hit "merge selected" to fuse them into a single region/single depth/single
   AMS slot — e.g. if your SVG has 6 colors but you only want to use 4
   filaments, merge the ones you're fine printing as one. Merged groups show
   as a stacked swatch in the list and can be split back apart any time.
7. **Export** bundles a binary STL per color region plus `base.stl` into a
   zip, with a short README describing the Bambu Studio import steps
   (import all as separate objects → group → assign filament per part).
8. **Assembly mode** (new): for real multi-part assemblies where the design
   spans more than one physical part — upload each part's STL/3MF, Mosaic
   auto-detects its dominant flat face (by coplanar-triangle-patch area) and
   cuts pockets directly into that part's own geometry, in its own real
   coordinates. Supports "rotated copy" parts (the same physical part
   reused elsewhere in the assembly, e.g. a wheel's two identical mirrored
   halves) — define a pivot + rotation angle once, and Mosaic figures out
   which slice of the shared design lands on that copy, then re-orients the
   cut back into the part's native print orientation automatically. Uses the
   **same vector front end as flat mode** (the SVG's real per-color net
   regions) extruded into 3D prisms and **booleaned against the part's actual
   mesh** via [Manifold](https://github.com/elalish/manifold) (a WASM CSG
   engine, loaded from CDN on first use). Output is the **whole modified part**
   — the real body with crisp, curve-accurate pockets cut in — exported as one
   combined multi-color **3MF per part** (body + one object per color, tagged
   to base materials so Bambu Studio maps each to a filament). No pixel raster,
   no voxel stair-stepping, and no manual re-stitching in CAD.

## Troubleshooting: "Boolean subtraction/union failed" warnings

This means Turf's polygon boolean ops threw on a specific color's geometry —
almost always because that color's path is (or contains) a self-intersecting
shape. The warning now names the exact color hex involved, so you know which
one to look at.

What Mosaic does automatically: every loop is deduplicated of near-identical
floating-point vertices before it ever reaches Turf, since the single most
common cause of this error is two flattened curve segments meeting at a seam
that differs by a fraction of a unit instead of matching exactly — that alone
fixes most cases silently, with no warning shown at all.

If you still see the warning for a specific color:
- **That region falls back to its pre-boolean shape** rather than the app
  giving up — geometry still exports, but that one region may overlap its
  neighbor slightly instead of having the overlap cleanly cut out. Usually
  a small, fixable cosmetic issue rather than a broken export.
- The real fix is cleaning that path at the source. In Illustrator or
  Inkscape: select the offending color's path, run **Path → Union** on it
  (even against itself/a duplicate) — this is the standard way to force a
  self-intersecting path back into a simple one. Inkscape's
  **Path → Break Apart** then **Path → Union** on a copy also works well for
  paths with stray overlapping sub-shapes.
- Common sources of self-intersecting paths: strokes converted to fill
  outlines (especially with sharp miter joins), paths built by boolean
  operations in the original design tool that weren't cleaned up afterward,
  and hand-edited paths with accidentally crossed segments.

## Assembly mode: what it does and doesn't do yet

Assembly mode was built and validated against a real multi-part wheel
project (a 3-part wheel: two identical halves + a hub cap, design spanning
all three). What's genuinely proven, against real files, not synthetic
tests:

- 3MF/STL loading, flat-face auto-detection, and boundary extraction —
  cross-checked triangle-for-triangle against an independent Python
  analysis of the same files; numbers matched to 3+ decimal places.
- (Superseded) The old raster color pipeline (SVG → per-pixel classification)
  has been replaced by the vector-prism + Manifold-boolean pipeline; assembly
  cutting now shares flat mode's exact vector net-region front end, so the
  crisp-edge behavior is the same code that was already validated there.
- Color clustering — a real file in testing had 12 raw hex values that were
  really just 4 colors plus antialiasing noise; clustering collapsed them
  correctly without being told which ones belonged together.
- The heightfield mesh builder — every exported group (base + each color)
  is independently watertight and printable on its own, verified via
  degenerate-triangle and bounding-box checks, not just a visual once-over.
- Rotated-copy parts (the "same physical part, installed twice" case) —
  verified the design correctly splits across both copies with no gap or
  overlap, and that each copy's cut is re-oriented back to its own native
  print orientation.
- The 3D preview shows each part's **whole real uploaded geometry** (minus
  the flat face being replaced), not just the small insert patch — a
  rotated-copy part is now actually rotated in the viewport to its real
  assembled position (previously it silently rendered on top of its source
  part). Verified numerically, not just visually: a live-scene vertex
  transform was checked against the app's own rotation math at a
  non-trivial angle/pivot (180°/origin is a degenerate case that can't
  distinguish a correct transform from a sign error). This is preview-only —
  export is still the insert-only STLs described above, unchanged.

What it does **not** do yet:

- **Input parts must be watertight/manifold.** The boolean cut needs a closed,
  manifold mesh; CAD-exported STL/3MF normally are. If a part isn't, Mosaic
  names it in an on-screen warning and exports it **uncut** rather than
  producing garbage — repair it (close holes, fix flipped faces) and retry.
- **Horizontal (Y-normal) faces only, still.** The assembly frame treats the
  design plane as horizontal with depth along the vertical axis. If the
  face you pick isn't roughly horizontal in the part's own coordinates,
  Mosaic warns and the cut may be wrong — pick a different detected face.
- **"Largest flat patch" is a heuristic, not a guarantee.** It happened to
  be correct for both real parts tested (by a wide area margin in both
  cases), but a part with an equally-large *decorative* flat face could
  fool it. The dropdown lets you pick a different detected patch if the
  auto-pick is wrong — check the reported normal/offset against what you
  expect before trusting it blindly on a new part.
- **No wall-thickness safety check.** Pocket depth (per color) is a number you
  supply, not something verified against the part's actual interior geometry —
  set a depth deeper than the wall behind the face and the boolean will just
  cut clean through into open air. Sanity-check depths against your own model.

### Assembly kinds and roles (skip the re-upload)

An assembly isn't an open-ended bag of parts — it's a fixed, small set of
**part roles** that together make one physical object. The built-in example
is a wheel: role "Top" (allows rotated copies — the same physical STL reused
at a second position via a pivot + angle, not a second upload) and role
"Cap" (exactly one). Switching to Assembly mode shows an "Assembly" dropdown
(currently just "Wheel") and, below it, "+ Add {role}" buttons for whichever
roles aren't filled yet, plus "+ Add rotated copy of {role}" once a
copy-allowed role has its first instance.

Roles are defined inline in `index.html` as `ASSEMBLY_KINDS` (search for
that constant) — adding a new assembly (e.g. a different TMT part with its
own set of roles) is one array entry:

```js
{ id: 'my-part', name: 'My Part', roles: [
  { id: 'body', name: 'Body', libraryPartId: 'my-body', allowRotatedCopies: false },
] }
```

A role's optional `libraryPartId` links it to an entry in
[`stl/parts.json`](stl/parts.json) — drop the file in `stl/` and add:

```json
{ "id": "my-body", "name": "My Part Body", "file": "stl/my-body.stl" }
```

and clicking "+ Add Body" auto-fetches and face-detects it instead of
requiring drag-and-drop. A role with no `libraryPartId` (or when the
manifest fetch fails, e.g. no local server) just starts empty — drag-and-drop
the file into that role's row, same as before. This requires serving the
folder over HTTP for the auto-load part specifically (see "Running it"
above); `ASSEMBLY_KINDS` and role buttons themselves work fine over
`file://` too, only the auto-fetch-on-add convenience needs a server.

## Known v1 limitations (by design, not oversights)

- **Flat faces only.** Base part is a parametric disc / rectangle / rounded
  rectangle. Uploading an STL is supported in **reference mode only** — it's
  shown semi-transparent for visual alignment and to read off face size, but
  Mosaic does not cut pockets into arbitrary mesh geometry yet. You get a
  correctly-sized flat insert plate back, not a modified version of your STL.
  Doing real arbitrary-mesh pocket cutting is a solvable fast-follow (either
  a proper 3D boolean library, or restricting to "flat face detected via
  planar slicing + swap that face's region"), just scoped out of v1.
- **Nonzero winding heuristic for holes.** Multi-loop paths (e.g. a letter
  "O") are assigned hole-vs-solid by loop area/winding sign, which matches
  how Illustrator/Inkscape/Figma export almost all the time. Pathological
  hand-authored SVGs with inconsistent winding could get this wrong — if a
  hole doesn't punch through, that's the likely cause.
- **Gradients/patterns are detected and skipped**, with a warning shown in
  the viewport, rather than silently producing wrong geometry.
- **No true concave-STL support, no curved-surface wrapping** — both
  explicitly out of scope per the brief.

## Testing notes

My sandbox's network egress is locked to an allowlist that blocks every CDN
(unpkg, cdnjs, jsdelivr, npm — all return `403 host_not_allowed`), so I can't
fetch the real three.js/Turf.js/JSZip libraries to render this exact file
end-to-end. What I could and did do instead:

- The full file parses as valid JS (`node --check`).
- Unit tests (in plain Node, no browser needed) for the transform-matrix math
  (translate/scale/rotate composition, nested parent/child transforms), and
  for the SVG path-data flattener (`M/L/H/V/C/S/Q/A/Z`, relative commands,
  implicit command repetition, multi-subpath paths, elliptical-arc endpoint
  math) — these are the two riskiest hand-written algorithms in here.
- A real integration pass in an actual headless Chromium (Playwright), with
  three.js/Turf/JSZip swapped for small local stand-ins that implement just
  enough of their API surface to execute — this doesn't validate the real
  libraries' geometry math (I trust that to Turf/three.js themselves), but it
  did exercise every piece of *my* glue code end-to-end and caught two real
  bugs I then fixed: a Vector3-style `.position.set()` call path, and
  confirmed the Y-axis mirror needed a winding-order fix (which I'd already
  added defensively, and this validated it doesn't crash). Covered: SVG
  upload → parsing → color detection, nested `<g transform>` composition
  including `rotate()`, rounded rects, gradient detection/skip warnings,
  holes via the nonzero-winding heuristic (tested against a synthetic
  letter-O shape, computed areas matched hand-calculated expected values),
  shape switching, depth edits, background-recess toggle, scale/offset/
  reset-to-autofit, merging 2+ colors into one recess, unmerging, and
  zip export — all run with zero console errors or exceptions.

I'd treat this as a well-exercised first pass, but I still want you to run it
against your real Smurfette SVG and tell me what breaks — a real browser with
the real CDN libraries and your real artwork will always catch things a stub
harness can't. Most likely remaining issues, if any: something in the actual
Turf boolean step on a very complex path (there's a fallback + on-screen
warning if a union/difference throws), or a color that should visually merge
but doesn't due to sub-pixel gaps between adjacent regions in the source file.

## Roadmap ideas (not built yet)

- **Done (Assembly mode):** ~~Real 3MF export with per-region color/extruder
  metadata~~ and ~~arbitrary-mesh pocket cutting via a proper 3D boolean
  library~~ now ship in Assembly mode (Manifold CSG + combined multi-color
  3MF). Bringing the same 3MF/boolean output to flat-plate mode is the next
  easy win.
- Apply the vector-boolean + 3MF pipeline to flat-plate mode too (currently
  flat mode still exports the slab-stack as a per-color STL set).
- Curved-surface wrapping (conform artwork to a cylindrical/curved face).
- Adaptive Bezier flattening tolerance instead of a fixed segment count, for
  very large or very tiny artwork.
