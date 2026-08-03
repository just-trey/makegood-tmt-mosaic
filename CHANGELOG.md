# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- The unit label at the end of the Artwork Fit rows was cut off by the edge
  of the left panel — Offset X and Offset Y lost most of their "mm" and Scale
  part of its "%". The panel is a fixed width, so this happened at every
  window size rather than only narrow ones. The slider now gives up the few
  pixels instead of the label. The smoke check measures every unit label
  against the panel edge, so a row that stops fitting fails rather than being
  noticed by eye.

### Added

- The help panel has a new About section linking
  [3d-mobility.org](https://3d-mobility.org), where the TMT's printable
  part files and assembly instructions live — previously the app had no
  link out to it.
- Below 900px window width, a plain message now asks for a wider window
  instead of showing the layout crushed to an unusable sliver. The
  desktop-only range this app targets is now driven and screenshotted
  (1920 down to 900px) rather than asserted from a single unverified
  claim.
- Every confirmation and error alert (switching parts, loading the full
  assembly, switching the chair's hardware variant, a failed part/pattern/
  export load) now uses a themed dialog matching the app instead of the
  browser's own unstyled `confirm()`/`alert()` popup.
- The warning panel now shows every current warning, not just the first 6
  with the rest collapsed into an unreadable "+ N more warnings" — the
  panel already scrolled, it just never had more than 7 pills to scroll
  through. Each pill now has its own "×" to dismiss it, plus a "Dismiss
  all" control when there's more than one.
- Merging colors no longer requires a drag: each color row now shows a
  visible "⠿" grip marking what's draggable, plus a "Merge with…" dropdown
  that does the same thing for keyboard or touch use. The Colors and
  Artwork panels' persistent hints now also explain Sticker/Fill mode and
  "+zone", instead of only a hover tooltip.
- The AMS slot line under the color list now always shows both numbers
  ("N colors → M AMS slots needed"), not only after a merge changes the
  count, and reconciles that count against the printer picked in Export —
  brightening past the 4 slots in a single AMS/toolchanger unit, and
  turning red only past what that printer can print in one go (16 slots
  across daisy-chained AMS units on the X1C / P1S / A1, 25 on an H2D
  across both nozzles, a hard 4 on the Snapmaker U1's built-in
  toolchanger). A pill spells out which of the two it is and how to get
  the count down, and both it and the line update the moment you switch
  printers rather than waiting for an export; dismissing the pill keeps it
  gone until the count or the printer changes. The printer picker itself
  is relabeled name-first (e.g. "Bambu X1C / P1S / A1 (256 × 256mm)").
- Loading a second design onto a surface that already has one no longer
  drops it exactly on top of the first: on an assembly part it starts
  stepped 8mm across and down, so it is visible as its own object and can be
  dragged without first having to move the design covering it. A design
  stamped on "All zones" counts as occupying every surface, so a
  zone-bound one steps off it too.
- Designs that end up overlapping on the same surface — whether left where
  they landed or dragged there — now warn, naming both by filename. Two
  overlapping recesses export as two inlays claiming the same space, which
  a slicer resolves arbitrarily; nothing said so before. Two Fills on one
  surface get their own wording, since moving or rescaling can't fix that
  one. The warning doesn't block exporting, and compares bounding boxes, so
  a design nested cleanly inside another can trip it.
- Your session now autosaves as you work — part, artwork, placement, colors,
  depth, and printer — and offers to restore it if you come back after a
  reload, browser close, or crash. A dismissible banner asks first ("Restore
  your previous session … ?"); nothing is applied automatically, and nothing
  rebuilds until you choose. Leaving the tab with loaded artwork now also
  prompts to confirm first. Not restored: an uploaded STL reference mesh.
- On a part with more than one design surface, loading a design that lands
  on just one of them now says so: the artwork row shows a "→ Zone name"
  badge, a pill on load names the zone and how many surfaces are still
  blank, and exporting with surfaces left blank warns which ones will print
  body-colored with no design.
- The Artwork panel now supports loading more than one design at once: each
  load adds a row instead of replacing the last one, click a row to make it
  the active design the fit sliders and on-face gizmo edit, and on a part
  with more than one design surface each row can target a specific zone (or
  place the same design on a second zone) via its own dropdown.
- Artwork rows on an assembly part now switch between **Sticker** (one copy,
  as before) and **Fill**, which repeats the design across the whole design
  surface — one repeat per SVG document, clipped to the surface edge, and
  wrapped conformally on a curved zone like any other cut. Scale sets the
  repeat size and Offset shifts the pattern; a fill that would need an
  unreasonable number of repeats is refused with a warning instead of
  hanging the tab.
- On a part with more than one design surface, you can also click directly
  on a surface in the 3D view to bind the active design to it, instead of
  using the row dropdown.
- Assembly kinds with hardware variants (Standard vs Kit) show a version
  picker at the top of the Part section; switching reloads only the parts
  that actually differ between variants, confirming first if any of them
  are already loaded.
- New assembly kind: **Chair body**, the MakeGood TMT's main frame (13
  printed pieces, Standard/Kit caster mounts). Five of its surfaces
  (left/right/front/back/seat) take artwork that wraps conformally onto the
  part's curved geometry instead of a flat orthographic stamp — load a
  design, then target a surface from the Artwork list's zone dropdown or by
  clicking it directly in the 3D view. A newly loaded design starts on the
  first surface rather than on all five at once; "All zones" is still there
  in the dropdown for anyone who wants it stamped everywhere. A surface
  covers the printed pieces under it rather than stopping at a piece's
  edge: the left and right ones
  run from the storage side across the handle and wheel mount onto the front
  fender, and a design laid across a join is split and cut into each piece
  separately. Each surface has its own true-scale design template,
  downloadable from the Part section once the parts load; on a template that
  spans a join, the dashed lines mark it and the labels name the piece each
  area lands on.
  Export placement is baked from MakeGood's own slicer-verified project, and
  the prime tower from a second verified file (see Changed below).
- A built-in pattern library — Cow, Dalmatian, Zebra, and Tiger — as a
  thumbnail strip in the Artwork panel. Clicking one loads it like an
  uploaded SVG (its own row, own zone targeting) and defaults to Fill mode
  on an assembly part, since a pattern exists to repeat across a surface.
- Export placement's baked-constants lookup now checks that the loaded mesh
  actually matches the mesh those constants were verified against, using the
  same mesh-fingerprint guard (triangle count + bbox hash) design zones
  already use. A part id renamed out of sync with the placement table, or a
  shipped asset re-packed without re-baking, now exports auto-placed with a
  warning naming the part instead of silently applying another part's
  rotation/position. A mesh you drag in yourself only inherits a role's
  baked placement if it really is the same mesh — otherwise it's placed
  automatically with a quiet notice, including when you drop it onto a part
  that had already auto-loaded from the library. (See the
  `wheel-mount-left` id-collision fix above for the class of bug this
  generalizes a guard against.)
- A `?kind=` URL parameter opens the app straight onto a given assembly kind
  (`?kind=chair-body`, `?kind=footrest`) instead of the wheel, so a link can
  point at the part being discussed. An unknown or missing value opens the
  wheel exactly as before.

### Removed

- The standalone hidden "Wheel mount (left)" assembly kind. It was briefly
  shipped and then deliberately un-shipped with no technical
  blocker recorded, is asymmetric (left-hand only, no matching right-hand
  kind), and its role id collided with the chair body's own wheel-mount
  role in the export placement logic (see Fixed below) — retired rather
  than left as unreachable dead weight. The chair's own left/right
  wheel-mount parts are unaffected; they were always separate files in a
  separately-verified pose.

### Fixed

- Neither export button (3MF or STL set) had any guard against
  re-entrancy — confirmed live, 5 rapid clicks on "Export print-ready
  3MF" triggered 5 independent exports and downloads. Both buttons now
  disable for the duration of their own export and ignore further clicks
  until it finishes.
- Every form control now has a real accessible name (`<label for>` or
  `aria-label`), not just a hover tooltip or nothing at all — a driven
  audit across five app states (wheel, wheel with artwork, disc mode,
  chair, chair with artwork; up to 134 controls in the richest state)
  found zero unlabeled controls after this pass, down from the ~63%
  baseline ("77 of 123") an earlier review measured.
- Dropping a PNG/JPG on the artwork dropzone used to fail with "SVG could
  not be parsed — check the file is valid XML," which is true but useless
  for a file that was never XML. It now says plainly that the file is a
  raster image and points at the part's design template (or converting to
  SVG) instead.
- A shape dimension field (diameter, width, height, thickness…) emptied or
  set to 0 used to apply silently — diameter 0 didn't error, it just
  deleted the part with no warning. Those fields now reject anything below
  their own valid floor (0 stays valid where it legitimately is, like
  corner radius) and snap back to the last valid value on blur instead of
  leaving a bad number in state.
- In the flat shape modes (disc, rect, round), a recess depth deeper than the
  plate — or zero, or negative — was quietly cut at the nearest depth the
  plate could hold instead, so a depth of `100` on a 4 mm disc exported a
  perfectly valid file that simply wasn't the one you asked for, with nothing
  on screen saying so. The depth is still clamped, since a recess reaching the
  back of the plate would cut through it, but now a warning names the color
  (or "Background"), what was asked for, and what was actually cut, and it
  says so on every rebuild rather than only the first. Assembly mode already
  warned about its equivalent.
- A depth of 0 or less on an assembly part dropped that color from the part
  with no recess, no inlay, and no message. It is now raised to 0.20 mm — one
  typical layer — and says so. Relatedly, a depth field left at a deliberate
  `0` was read as "no depth set" and silently replaced with the global Depth —
  a row reading 0.00 could cut a full millimetre.
- A depth of zero or less now falls back to 0.20 mm rather than 0.02 mm. A
  fiftieth of a millimetre is a tenth of a layer: it sliced to nothing, so the
  color printed as bare body while still using up a filament slot, and the
  warning said it had been cut. A depth you set that is positive but thinner
  than a layer is still cut exactly as asked — that's a real choice on a fine
  layer-height profile — with a quiet note that it won't show up on a standard
  0.2 mm one.
- A color's depth row now shows when it carries its own depth rather than
  following the **Depth** default — the field is outlined and gets a "↺" to
  put it back. Previously the two looked identical, so a row pinned to its own
  value made the Depth field appear to do nothing, with no way back except
  clearing the field, which only the help panel mentioned.
- Restoring a session saved by an earlier build no longer reinstates a
  per-color depth override for every color. Those were written automatically
  rather than chosen, and restoring them left the global Depth field unable to
  move any row and the out-of-range warning silent. Restored rows now start
  under the global Depth again; a depth you had deliberately set on a row
  before this release has to be set once more.
- The 3D viewport redrew every frame for the whole session, whether or not
  anything had changed, keeping a core busy behind an idle model — noticeable
  as heat and battery drain on a laptop, and as a slow app on any machine
  whose browser falls back to software rendering (no working GPU
  acceleration), where each redraw also competed with the geometry rebuilds
  for the same thread. It now draws only when something actually changes.
- The camera's glide after releasing an orbit decayed by a fixed amount per
  frame rather than per second, so on a slow renderer it kept easing — and
  redrawing — long after the gesture, measured at 221 s where it should be
  about one. The decay is now scaled to real frame time, which leaves the
  glide identical at 60 fps and ends it in about a second at any rate.

- The on-face selection frame on the chair came in several times the size of the
  artwork, sitting away from it at an angle with its handles hanging in space off
  the part — hard to aim and easy to read as the design being misplaced, when the
  cut itself was correct. Three separate causes, all in the frame rather than the
  cut: it re-derived the design's mm-per-unit itself and assumed 1 unit = 1 mm
  whenever the file declared no absolute size — which is every SVG an editor
  exports as `width="100%"` — while the build auto-fits the artwork to the part
  face, so the two disagreed by the ratio between them; it was drawn as a flat
  rectangle spanned by the surface tangent, which on a curved zone leaves the part
  by 110 mm at 300 mm across; and on a surface spanning more than one printed part
  it asked the first part for a point lying on another, getting that part's
  nearest edge ~100 mm away. The frame now takes its size and anchor from the same
  code the cut uses, is traced along the surface so it lies on the part and
  crosses printed seams, and resolves each point against the part that actually
  carries it. Clicking to drag the design is tested against that traced outline
  too, so the grab area is the frame you can see rather than the flat rectangle it
  used to be — on a curved surface those differ by the same 110 mm, which let
  clicks outside the frame start a move and clicks inside it orbit instead. A
  design center that ends up off the design surface entirely is drawn in amber
  rather than as a confident frame on unrelated geometry, updated as you drag.
- A design placed as a **sticker** on one of the chair's curved surfaces could
  drop a color from the cut, reported as "Couldn't build the cut solid". The
  tolerance deciding how far off the baked chart a cutter vertex may land before
  the cut is refused was 0.5 mm for a sticker against 2 mm for a fill, on the
  assumption that only a fill runs along the clipped surface boundary. That
  assumption was wrong: a part's baked claim on a surface is slightly more
  generous than the triangulation inside it, leaving narrow uncovered spikes
  **inside** the claim — worst 2.150 mm deep, with every surface but three under
  1 mm — which a sticker meets exactly as a fill does. Both modes now use the
  same 3 mm tolerance, and a fill keeps its own coarser refinement. A test pins
  that worst case across all 25 chair charts, so a re-bake that opens a wider
  gap fails CI instead of silently dropping cuts again.
- A warning could stay on screen after the rebuild that produced it had been
  superseded by a later, successful one. Warnings were cleared only when an SVG
  was parsed or the Artwork panel changed, never per rebuild, and they dedupe by
  message — so a cut failure raised under an earlier zone or mode binding
  survived indefinitely, describing geometry that was no longer in the viewport
  or in the export. Diagnostics that a rebuild regenerates from scratch every
  attempt are now cleared at the start of each attempt; standing facts that
  nothing re-derives — a part's load-time fingerprint mismatch, an export
  placement notice — are left in place.
- The chair body rendered lying on its back with its top facing forward. The
  viewport is Z-up and parts are never transformed at load, so the chair —
  packed in its CAD frame, where up is +Y — came in rotated a quarter turn,
  and the "rest the assembly on the grid" step then sat it on its rear face,
  leaving the wings 650 mm in the air. Assembly kinds can now declare a
  `displayFrame` (which native direction is up, and which is the front) that
  poses them in the viewport; the wheel and footrest declare none and render
  exactly as before, since the existing "the design face is a Y-plane"
  convention already poses a plate-like part correctly. This is a viewport
  pose only — part meshes, the cut pipeline, the baked zone charts, and
  export plate placement all still use each part's native coordinates.
- An assembly is now centered over the viewport's grid, not just rested on
  it, and the grid grew from 600 mm to 800 mm (still 20 mm cells) to hold
  the largest part in the library. The chair's CAD origin is a datum rather
  than the middle of the part, so its 380 × 658 mm footprint ran from 4 mm
  to 662 mm along the grid — leaving it standing almost entirely off the
  back edge of a stage that was sized for the 280 mm wheel. The wheel and
  footrest were already centered on their origins and don't move
  perceptibly.
- Wheel mode's design-boundary anchor (the SVG's largest `<circle>`) is now
  read through the same viewBox-origin and group-transform math as every
  other shape, and only searches the same visible subtree (excluding
  `defs`/`clipPath`/`mask`/`pattern`/`symbol`) instead of scanning the whole
  document. Previously, a non-zero-origin viewBox or a circle nested inside
  a transformed `<g>` could anchor the design off-center with no visible
  indication, and an invisible clip-path circle larger than the real
  boundary could silently win over the real one.
- A part whose cut solid couldn't be built (the boolean CSG pass failing on
  that part) previously still exported its per-color inlay solids alongside
  the untouched, uncut body — a slicer would then resolve the overlapping
  geometry arbitrarily, an export-quality bug with no indication in the
  on-screen warning that the file itself was malformed. That part now exports
  uncut and without inlays instead, and the warning says so. The same
  boolean pass no longer aborts the whole rebuild (leaving a blank
  viewport and leaking WASM memory) if merging one color's cutters, or a
  part's whole cutter set, fails.
- A part whose pocket cut reached all the way through it (depth exceeding the
  wall thickness at that point) previously vanished from the viewport and
  export with no explanation — the boolean succeeded but produced zero
  geometry, so none of the existing CSG-failure warnings fired. Export now
  warns which part was dropped and why before excluding it.
- Clearing an assembly part's Advanced pivot or angle field emptied the input
  to a value that silently became `NaN`, which reached the part transform and
  blanked the entire 3D viewport with no warning. Those fields now snap back
  to their last value instead.
- The exported 3MF writer now refuses to write a non-finite plate coordinate
  or transform (previously silently substituted as `0`), so an internal bug
  producing bad geometry fails the export instead of shipping a malformed
  file with a spike vertex.
- The chair body's left wheel-mount part was silently picking up the
  retired standalone kind's baked export placement (a fixed rotation and
  single-plate hint meant for a lone part on its own plate), because both
  shared the role id `wheel-mount-left` and the export code matched on that
  id alone, not the assembly kind. Removing the standalone kind's dedicated
  branch fixes this — the chair's wheel-mount part now takes the same
  generic centered placement as its other 12 pieces.
- The on-face gizmo now sits on the design surface the active artwork row is
  actually bound to. It previously always used the first zoned part's first
  zone, so on the chair body it stayed on the left panel whatever you
  selected — reading as a frame stuck at an angle, with every drag editing a
  surface you weren't looking at.
- The Zebra pattern now really does tile. Its stripes are traced as contours
  of a repeating wave field, and any contour that didn't happen to close
  inside the sampled window was being discarded — leaving mismatched runs up
  to 11.7mm where one repeat met the next, and filling in the white gaps
  enclosed by a stripe. Contours are now closed against the window edge
  instead of dropped, and enclosed gaps stay open. Cow, Dalmatian and Tiger
  are generated a different way and are unchanged.
- A chair part whose design-zone data can't be downloaded is now left with no
  design surfaces, rather than falling back to stamping the artwork flat onto
  whatever the largest flat face of that piece happens to be.
- Loading or removing a design now drops color settings — base-color
  assignments, merge groups, pinned-apart colors — for colors no loaded
  design paints with any more. A color the previous design had sent to the
  base could otherwise stay silently excluded from being cut.
- An export of three or more build plates laid them out in a single row,
  where the slicer expects a square-ish grid. The third plate and everything
  after it landed on empty space past the grid's last column. Nothing shipped
  had hit it — the wheel's two-plate export is a single row either way — but
  every chair export is eleven plates.
- A plate whose prime tower has no verified position could be handed one
  inside a part. The fallback chose its X and Y insets independently, so a
  group that left room along each axis separately could still occupy the
  corner where that room met. It now scores whole corners, and warns when
  every corner of the plate is occupied instead of picking one silently.
- Export warnings now cover a part placed past the edge of the plate, not
  only one too big to fit the plate at any position. A verified placement
  transfers to a smaller bed than the one it was checked on without
  anything having said so.
- An SVG with pathologically deep nesting (thousands of nested rings in one
  path, or thousands of nested `<g>` elements) failed with a raw "Maximum
  call stack size exceeded" instead of a message naming what was wrong with
  the file.
- A rect-fit design (a design-zone template, or the footrest's flat face) was
  placed by centering the artwork's own drawn content on the target surface,
  rather than by lining up the artwork's document canvas with the surface.
  The two agree for a design that fills its canvas, but a design drawn in one
  corner of a template — matching where that corner actually sits on the
  physical part — got re-centered onto the surface instead, landing on
  whichever part happened to sit in the middle of the zone. Position was the
  one thing a template expresses that placement threw away, which also meant
  the footrest template's "keep artwork clear of the mounting slots" guidance
  couldn't be followed. Placement now anchors on the document's own canvas —
  its viewBox, or its declared millimeter size when it has no viewBox — so a
  template loaded at Scale 100% / Offset 0/0 lands exactly where it was drawn.
  A design that fills its sheet is unaffected.
- The on-face gizmo now encloses the artwork on a design drawn off-center in
  its document, instead of sitting where the document's center lands. The
  frame is what the move gesture hit-tests against, so a design placed away
  from the middle of its sheet previously offered a selection box that didn't
  overlap the artwork it belonged to.

## [0.6.0] - 2026-07-26

### Added

- Direct on-face artwork manipulation in the 3D viewport: a selection frame
  with drag-to-move, corner handles to scale, and a rotate handle now sits on
  the artwork's face in both Assembly and flat-plate modes, alongside a new
  Rotation control in the Artwork fit panel. Render quality drops briefly
  during a drag on heavier models to keep it smooth, and recuts once on
  release.

### Changed

- The chair body's 15 pieces now export at their verified print poses, one
  per build plate, instead of centered on whatever pose the mesh happened to
  carry. Plate assignment, rotation, position, and each piece's brim,
  support, infill and wall settings are baked from MakeGood's own 12-plate
  Bambu Studio project for the complete chair — the same "use the numbers
  from a file a human checked in the slicer" rule the wheel and footrest
  already followed. Standard and Kit caster mounts each keep their own plate.
  Each plate's prime tower is baked too, from four-filament exports with every
  tower positioned by hand — one per bed size — and stored as an offset from
  that plate's anchor part so it follows the part when a different bed
  re-centers the plate. Both shipped bed sizes were checked; seven of the ten
  towers transferred between them unchanged, and the two wheel-mount plates
  and one handle plate carry their own 256mm values. A bed size that hasn't
  had that pass inherits the 270mm positions untested. The caster plate prints
  a single filament and has no tower.
- Print-ready 3MF exports now disable the brim on every part
  (`brim_type: no_brim`, set globally in the project settings). The mosaic
  faces are broad and print flat, so a brim only wasted filament and added a
  peel-off step. The footrest already printed brim-free; the wheel now
  matches it.
- The bundled part meshes are ~90% smaller (3.34MB to 338KB total), so
  Assembly mode's parts load far faster on a first visit. Two of the three are
  CAD exports of the same parts in place of slicer tessellations: the footrest
  goes from 235k to 10.8k triangles (surface area agrees to 0.06%) and the
  wheel half from 20.5k to 18.0k (0.01%). The hub cap is the same mesh,
  repacked. All three keep their exact pose, so the detected design face is
  unchanged (footrest 54,693.7 to 54,688.3mm², wheel half 29,407.8 to
  29,403.4mm²) and part placement in exported 3MFs is unchanged.
- The wheel's part ids and filenames are renamed for clarity: `top` to
  `wheel-half`, `cap` to `wheel-hub-cap`. Internal only — display names in the
  UI are unchanged.
- The Margin control is now hidden in Assembly mode: it only ever affected
  flat-plate mode's auto-fit sizing, so showing it while editing a wheel or
  footrest was misleading — the slider had no effect there.

## [0.5.0] - 2026-07-19

### Changed

- Design templates are now generated from the part meshes
  (`scripts/gen-templates.mjs`) and share one visual language: a `#bcbcbc`
  printable-surface grey and a single blue guide ink for all non-printing
  marks. The footrest template now shows the part's real printable outline
  (not a plain rectangle) with all four mounting slots punched out as real
  gaps in the grey, so an absence of material reads at a glance. The wheel
  template gains a dotted blue ring marking where the center cap lands (a
  reference — that area still prints), and both templates share one guide-label
  size so they read as a matched set.
- The wheel template's outer disc is now 280mm, measured from `top.3mf`, rather
  than a hardcoded 280.15mm that disagreed with the mesh it claimed to come
  from. Placement is unaffected — wheel mode scales artwork off the Design
  radius, not the template's absolute size.
- Typed number fields (Design radius, shape dimensions, fit values) now wait
  550ms after the last keystroke before rebuilding, up from 350ms, so
  deliberately-typed multi-digit values don't trigger an intermediate rebuild
  mid-entry.

### Added

- **Download design template** link in the Part section, offering the selected
  assembly kind's true-to-size (1:1 mm) design-face SVG. The templates shipped
  in `public/templates/` previously had no way to reach them from the app.
- Footrest assembly kind: a second selectable part alongside the wheel, with
  a true-to-size (1:1mm) design-face SVG template.
- Footrest export ships with a verified plate pose (centered on any printer's
  build plate), a prime/wipe tower placement that rides along with it, and
  per-part print overrides (support off, no brim) baked from a user-verified
  reference 3MF.
- Exported print-ready 3MF files are now named after the selected part (e.g.
  `mosaic-footrest.3mf`) instead of always `mosaic-wheel.3mf`.

### Fixed

- Artwork for an assembly part (e.g. the footrest) that was exported without an
  absolute mm size — as Affinity does, writing `width="100%"` and rescaling the
  viewBox to its own resolution — now auto-fits to the part face via its viewBox
  instead of landing ~2.8× oversized. A template trace drops in life-size at
  Scale 100% again. SVGs that declare a real mm size are unaffected. The fit is
  measured only once a part's mesh has loaded, so the same SVG no longer reports
  one size and then silently rescales when a library part finishes fetching.
- The "AMS slots needed" counter under Colors detected undercounted by one —
  it left out the body's own filament slot (materials[0], always present in
  both export paths). It now reports cut colors + 1. The "N colors → M AMS
  slots" merge hint also compared detected colors against slots instead of
  against cut colors, so it showed even when no colors were merged; it now
  appears only when merging actually reduced the count.

### Removed

- The Rectangle, Rounded rectangle, and STL-reference options from the part
  picker. The dropdown now lists the real MakeGood TMT parts (Wheel,
  Footrest) plus a single "Disc (reference)" flat-plate insert. The
  flat-shape code paths remain but are no longer offered in the UI.

## [0.4.1] - 2026-07-19

### Changed

- Analytics on the hosted page switched from Cloudflare Web Analytics to
  Umami. Still opt-in and disabled by default: the script is injected at
  build time only when `UMAMI_WEBSITE_ID` is set, so forks build and deploy
  without it. See `.env.example`.

### Fixed

- Wheel assembly's second Top half (the rotated copy, exported onto its own
  build plate) is now named "Bottom" instead of "Top (rotated copy)".

## [0.4.0] - 2026-07-17

### Added

- Auto-merge similar colors: a stepped slider (None/Slight/Medium/Strong) in
  Colors detected collapses visually similar fill colors into shared AMS
  slots, live and fully reversible — drag it back down to pull colors apart
  again, or pull just one color out of a merged group with its "×". Slight
  (dedupe) is on by default.
- Group colors into the base material: the Base is now a slot pinned at the
  top of Colors detected, alongside the cut slots. "→ base" (or dragging a
  color, or a whole merged group, onto the Base row) adds it in; the row
  shows every color it contains and prints as the dominant member's color.
  "×" a base color to send it back to being cut. Previously the only option
  was a generic filament swatch for the body.

### Changed

- Merged color slots now print in the group's dominant (largest-area)
  member's real color instead of an RGB-averaged blend.
- Similar colors are now deduped by default (auto-merge Slight) — this
  changes the detected-color count/output for existing artwork with
  near-identical export/anti-aliasing color artifacts.
- The base can now hold more than one color/merged group at once: dragging a
  color (or merged group) onto the Base row adds it alongside what's already
  there, while the "→ base" button switches the base to that color (releasing
  the previous members back to being cut). Removed the duplicate
  artwork-color swatches from the top base-color area (and the reorder jump
  that came with picking one there) — grouping artwork colors into the base
  is now done from the color list's Base row alone.
- Renamed the Part panel's "Base color" picker to "Body / blank color" and
  reframed it as the physical blank's own fallback color (the body prints it
  whenever no artwork color is grouped into the base). This disambiguates it
  from the Base row in Colors detected, which the two shared name made read
  as the same control in two places.
- The Base row in Colors detected now shows an empty-state line ("Base —
  empty; body uses the blank color set in Part") instead of disappearing
  when nothing's grouped in, so the "no artwork color as body" case reads as
  a normal choice. Its label also dropped "(not cut)" in favor of "prints as
  the body" to avoid overloading the word "cut".
- Removed the per-color checkbox + "Merge selected" button in Colors
  detected — it duplicated drag-to-merge and read as unclear/dead-looking
  next to the newer auto-merge slider and drag-and-drop flow. Manual merges
  are still made by dragging one color onto another.

### Fixed

- The auto-merge slider's None/Slight/Medium/Strong labels didn't line up
  under their thumb stops. They're now anchored to the track's own width
  instead of the full (wider) panel row.
- A merged group with many members (e.g. a long shading ramp collapsed at
  Strong) could push its "→ base" button off the edge of the panel. The
  member swatches now wrap onto their own line below the row's controls
  instead of competing with them for space.
- Area percentages and dominant-member color picks could be wildly wrong on
  complex artwork (e.g. a Base row claiming 740% of the design, or the body
  printing the wrong member's color). Region areas were measured with turf's
  geodesic area function, which treats SVG coordinates as latitude/longitude
  and returns garbage outside real-world ranges — all area comparisons now
  use plain planar (shoelace) area. Flat mode's base share also mixed raw
  SVG units with millimeter units in the same percentage; both sides now use
  the same scale.

### Removed

- The "unmerge" button on merged rows. It only ever affected manual
  drag-merges, so it silently did nothing on the auto-merged groups the
  slider now produces (most of them). Its jobs are covered: drag the
  auto-merge slider down to split slider-made groups, or click a group
  member's "×" to pull colors out one at a time.

## [0.3.1] - 2026-07-16

### Fixed

- GPU memory no longer grows while adjusting sliders. Rebuilding the model
  now disposes the previous build's geometry and materials instead of
  leaking them.
- Assembly color regions now clip to the part face more reliably. Clipping a
  color region to a part's boundary used to give up and leave the region
  unclipped after a single failed attempt on degenerate geometry, instead of
  being retried the way the other boolean operations already were.

### Changed

- Geometry rebuilds no longer freeze the tab on dense artwork. The polygon
  boolean pass (the bulk of a rebuild) now runs cooperatively — yielding to the
  browser as it works — so the UI stays responsive instead of triggering the
  "Page Unresponsive" dialog, and the "Rebuilding…" curtain shows a live
  percentage (with a "hang tight" note once it's been a while) instead of a
  frozen line.
- Dense-artwork rebuilds are also faster: the flat-plate background and
  base-slab region unions now merge via balanced pairs instead of one long
  accumulation (~3x faster on that phase, ~18% off the whole rebuild on a
  135-path test SVG).
- SVG curves are now flattened to an adaptive deviation tolerance instead of a
  fixed 18-segment count per Bezier — gentle curves emit only as many points
  as they need. ~77% fewer polyline points on the 135-path test SVG, with
  worst-case deviation from the true curve measured at ~0.002 SVG units
  (well under the fidelity that mattered before), which speeds up every
  downstream step that scales with vertex count.
- Assembly-mode rebuilds no longer freeze the tab either: the per-part
  cutting pass (the bulk of an assembly rebuild) now yields to the browser
  as it works, the same way the flat-mode boolean pass already did, and the
  "Rebuilding…" curtain shows a live percentage through the whole rebuild
  instead of jumping to 100% and then hanging until the cut finishes.
- Depth/fit/color tweaks no longer recompute the artwork's per-color regions
  — the polygon boolean pass (the dominant cost of a rebuild) is now skipped
  when the change didn't touch the parsed artwork itself, so large SVGs
  respond much faster to slider drags.

## [0.3.0] - 2026-07-16

### Added

- Snapmaker U1 (270 × 270 build plate) as a print-ready 3MF export target,
  alongside the existing Bambu Lab printers. The exported project settings
  resolve directly in Snapmaker Orca, Bambu Studio, and OrcaSlicer.
- In-app help panel (the "?" button in the header) walking through each
  left-panel section — Part, Artwork, Fit, Depth, Colors, Export — so new
  users don't need to leave the app to learn the workflow. A pulsing badge
  draws attention to it until it's opened once.
- Print-ready 3MF exports now name each build plate (e.g. "Top + Cap") in the
  plate list/preview instead of leaving it blank.
- Wheel assembly exports now pin the prime/wipe tower's plate position too,
  as a fixed offset from the wheel Top half — reused on every plate a Top
  half lands on and on every supported printer — instead of leaving it to
  each slicer's own default placement.

### Changed

- Print-ready 3MF exports now default to Generic PETG filament (was PLA) and
  embed 15% gyroid sparse infill with tree (auto) support enabled, layered on
  top of the target printer's standard process profile. These are now marked
  as explicit per-project overrides, so they survive a reload/resave in Bambu
  Studio, OrcaSlicer, and Snapmaker Orca instead of silently reverting to the
  named preset's own defaults.
- Wheel assembly exports now use a fixed, externally-verified layout instead
  of a computed one: the half-wheel's rotation and the cap's position
  relative to it are constants taken from a real, tested MakeGood TMT export,
  reused unchanged across every supported printer and identically on the
  rotated-duplicate half's own plate. Also fixed the recess/inlay meshes on a
  part (e.g. the cap's color recess) being able to sit below the build plate
  (Z<0) — the plate-flush height now accounts for every sub-mesh of a part,
  not just its uncut body.
- The cap's fixed position relative to the wheel Top was updated to match a
  second externally-verified reference export (a real print-tested layout,
  tuned in Snapmaker Orca).
- On a printer with a bigger plate than the wheel layout above was authored
  for (H2D, Snapmaker U1), every plate's wheel-half group (plate 1's top half
  and cap, and each rotated-duplicate half's own plate) is now re-centered as
  a rigid group on the larger plate instead of sitting in the corner the
  reference layout was placed for — each part's position relative to the
  others on its plate is unaffected, and the X1C plate (which the layout
  matches exactly) is unchanged.

### Removed

- Bambu Lab A1 mini (180 × 180) as an export target — the build plate is too
  small for these parts.

### Fixed

- Cloudflare Web Analytics beacon was silently broken since it was added: the
  injected `data-cf-beacon` attribute had its embedded quotes backslash-escaped
  instead of HTML-entity-escaped, so browsers truncated the attribute at the
  first literal quote and the beacon script never received a token.

## [0.2.1] - 2026-07-15

### Fixed

- SVGs that declare fill colors via CSS classes in a `<style>` block (the
  common Illustrator/Inkscape "presentation attributes → CSS" export shape,
  e.g. `<path class="cls-1"/>` with `.cls-1 { fill: #… }` in `<defs>`) loaded
  as a single solid-black shape instead of their real colors, since the parser
  only read inline `style` attributes and `fill` presentation attributes.
  Class-based fills are now resolved.
- Assembly cutting could silently drop a color's recess on some parts —
  clipping dense/detailed line-work to a part's face boundary can leave the
  region touching itself in a way Manifold's boolean engine rejects as
  non-watertight, even though the shape is otherwise valid. Failed regions are
  now automatically repaired (via Manifold's own 2D boolean engine) and
  retried before falling back to a warning.
- Typing a multi-digit value into a numeric field (scale, margin, depth,
  dimensions) no longer kicked off a rebuild on the first digit and stacked a
  second one behind it — number fields now debounce until you stop typing,
  and the "Rebuilding…" overlay no longer flashes on every keystroke.
  Dragging a slider on a complex/heavy model no longer stutters either: it
  now rebuilds once on release instead of flooding redraws mid-drag, while
  cheap models keep live preview during the drag.
- On a heavy model, changing a value used to make the viewport appear to
  freeze with no indication anything was happening until the redraw finished.
  The "Rebuilding…" overlay now reliably shows during the freeze (it's given
  a paint frame before the geometry work blocks the main thread), and heavy
  rebuilds are recognized up front so even the first one shows it — while
  light rebuilds still update instantly with no overlay.

### Changed

- The "no `<circle>` marking the design boundary" message (shown when an SVG
  has no explicit design-boundary circle and auto-centering is used instead)
  is now a quieter info note instead of an error-styled warning pill — it's
  expected for most artwork, not a sign something broke.

## [0.2.0] - 2026-07-15

### Fixed

- Print-ready export was pathologically slow — a real assembly 3MF took ~90s,
  and time scaled with mesh size (large mosaics ran into minutes). JSZip's
  `generateAsync` pumps its worker through nested `setTimeout(0)` calls that
  browsers clamp to a 4ms floor, so multi-megabyte archives crawl. Replaced it
  with a direct synchronous STORE-zip writer (a 3MF is just an uncompressed
  zip); the same assembly export now finishes in ~5s. The STL-set export uses
  the same writer. Assembly 3MF also now emits Manifold's native vertex index
  directly instead of re-welding the triangle soup.
- Fixed the deployed GitHub Pages site failing to load (CSS/JS 404s): a stray
  `vite.config.js` was shadowing `vite.config.ts` — Vite loads `.js` before
  `.ts` — so the production build silently dropped the real config (asset base,
  version token, analytics) and fell back to a root base whose `/assets/…` URLs
  404 under the `/<repo>/` project path. Removed the duplicate and folded its
  preview-server settings into `vite.config.ts`.
- Prevented the app from crashing on startup when the build-time version token
  was unavailable, which was causing the Playwright smoke check to time out.
- Assembly artwork on a +Y-facing design face (e.g. the wheel's default face)
  loaded mirrored left-to-right, so text read backwards. Placement now
  auto-corrects per face so artwork is right-reading by default, viewed from
  that face's front, on any face and in both modes.

### Added

- **Flip H / Flip V** mirror toggles in Artwork fit, layered on top of the
  automatic orientation — for artwork you deliberately want mirrored, or a
  design meant to be read from the back of a face. Reset with "Reset to
  auto-fit".
- Cloudflare Web Analytics on the hosted page (cookieless, no personal data
  collected). The beacon is injected at build time only when `CF_BEACON_TOKEN`
  is set, so forks build and deploy without it. See `.env.example`.

## [0.1.1] - 2026-07-15

### Fixed

- Assembly mode's wheel **Cap** part: the design was clipped to whatever small
  flat patch got auto-detected as its face (~16.35mm radius), leaving an
  uncut collar around the rest of the domed ~18.4mm cap instead of covering
  the whole curved top. The cut now spans the part's full curved surface,
  fixed to a 3mm depth matching the cap's shell thickness above its
  mounting boss so the clamp fit stays intact.

## [0.1.0] - 2026-07-14

Initial public alpha. Baseline feature set as of this release:

### Added

- SVG-to-3MF color-inlay pipeline: parses `<path>`/`<rect>`/`<circle>`/etc.
  geometry directly, groups shapes by fill color, and computes each color's
  net visible region (paint order aware) via 2D polygon booleans.
- **Flat-plate mode**: builds a stack of flat slabs between depth boundaries.
- **Assembly mode**: cuts pockets into real part meshes via Manifold (WASM
  CSG), including support for rotated-copy parts.
- Print-ready Bambu Studio 3MF export — parts placed on build plates, each
  recess pre-named and pre-assigned to its detected color's filament slot.
- Per-color STL export as a fallback for other slicers.
- Automatic boolean-failure recovery: vertex deduplication, degenerate-sliver
  scrubbing, and reduced-precision retries for self-intersecting source paths.

[Unreleased]: https://github.com/just-trey/makegood-tmt-mosaic/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/just-trey/makegood-tmt-mosaic/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/just-trey/makegood-tmt-mosaic/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/just-trey/makegood-tmt-mosaic/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/just-trey/makegood-tmt-mosaic/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/just-trey/makegood-tmt-mosaic/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/just-trey/makegood-tmt-mosaic/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/just-trey/makegood-tmt-mosaic/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/just-trey/makegood-tmt-mosaic/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/just-trey/makegood-tmt-mosaic/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/just-trey/makegood-tmt-mosaic/releases/tag/v0.1.0
