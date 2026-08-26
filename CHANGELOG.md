# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Send feedback without leaving the app.** A Feedback button in the bottom
  right of the 3D view opens a short form: what happened, and an email if you
  want a reply. It posts straight to us, with the app version attached so a
  report is actionable, and nothing else. The same panel links to GitHub for
  anyone who would rather file a bug there. The button only appears on our own
  deploy, so a fork never posts to our inbox.
- **A loaded image now survives a reload.** Sessions saved SVG artwork and threw
  images away, so reloading with a photo or a PNG open meant re-dropping it, and
  a session whose only design was an image saved nothing at all. The image is
  kept as the working copy the tracer used, re-encoded, which is small enough to
  fit: a photograph is about 700 KB against the 4 MB a whole session gets, where
  the raw pixels were 4 MB on their own. Restoring re-traces it, so it takes a
  moment on a photograph. The colors come back exactly as they were, because the
  copy is lossless.
- **A long rebuild can be cancelled, and now actually stops.** The "Rebuilding
  geometry…" curtain carries a Cancel button on any part. Before, starting the
  wrong rebuild meant waiting it out or reloading the page, and reloading used to
  take every setting with it. Measured on a wheel carrying 6000 regions: the
  button used to sit on "Cancelling…" for **140 seconds** while the progress
  readout kept climbing, and now returns the app in **0.3 seconds**. The stage
  goes back to showing the uncut parts, since the cut it was part-way through is
  what you stopped, and Export switches off until you build again. Your settings
  are untouched and still saved, which a page reload never managed.

  It is still not instant everywhere: once the cutting itself starts, stopping
  waits for the part being cut to finish, which is seconds on the parts that
  ship. The long wait was never in the cutting.

- **The Depth panel says when colors are ignoring the default.** Typing in
  Default depth could appear to do nothing, because a color with its own depth
  keeps it, and the only sign of that was a highlight on a row in another panel.
  It now reads "2 colors use their own depth" beside the field, with a
  "Reset all" that puts them back. The checkbox hint no longer says "override
  below", which was pointing at that other panel instead of showing the state.
- **The Export panel says what you are about to get.** Above the button: how
  many parts, how many plates, and a swatch per filament, with the parts listed
  plate by plate. Until now the panel said nothing about any of that either
  before or after; the only feedback was the download itself. It follows the
  build on screen, so a color change or a merge updates it before you commit.
  The plate count appears where the part's plates are pinned, which covers the
  wheel and the footrest; a hubcap cut to artwork shape, or on a bed with no
  verified arrangement, is packed at export time and shows parts and filaments
  only.
- **Hubcap part, built to the size you choose.** The first part the app
  generates rather than loads: the four mounting clips ship as a fixed mesh and
  the disc is built at whatever **Hubcap diameter** you set, 220mm to start
  with, keeping a 3mm thickness and 1mm chamfered edge at any size. Artwork
  recesses into it
  at the usual depth. The diameter is capped by the printer's bed and floored
  at the size that still covers the clips, so it can't produce a disc that
  won't print or one whose clips come away as loose pieces. The design template
  is drawn to the current size rather than being a fixed file.
- The hubcap's plate is verified up to 220mm on 256mm and 270mm beds, exporting
  at a hand-checked position with the prime tower clear of it (7mm on 256mm,
  19mm on 270mm) and the tower width that clearance assumes. Above 220mm, or on
  any other bed, it centres with the tower in the freest corner and says so.
- A generated part now says plainly when it has no pre-verified plate position,
  instead of reporting it as though one of the app's own meshes had drifted.
- **Cut the hubcap to its own artwork's shape.** A new **Cut to artwork shape**
  checkbox replaces the round disc with the outline of the artwork on it, so a
  logo or character prints as its own silhouette. One image drives both picture
  and cutline, so it needs a real transparent background and exactly one design
  loaded. The edge is cut square, and the shape follows the artwork's scale,
  rotation and flips, with the design template drawn to the silhouette rather
  than to a disc. Offset does nothing while it is on: the part centres on
  its clips and the picture on the part.
  - Refused with a named reason when the shape wouldn't bond to the clips, when
    the image has no transparency, or when more than one design is loaded. A
    too-thin feature warns rather than refusing. Removing the artwork or the
    checkbox reverts the part to a circle.
  - A shape bigger than the 280mm wheel is scaled down to fit, artwork and all,
    and says so.
  - Fill is withheld while it is on; only Sticker makes sense against a shape
    that keeps changing.
- **Artwork at the edge of a cut-to-shape hubcap now cuts the full 3mm through**,
  while interior artwork keeps its recess depth. Recessing the picture 1mm into
  a 3mm shell left the outline as a 2mm band of base colour, visible from every
  angle but straight on. The app names the colours this applied to. It overrides
  a hand-set depth at the edge only, and applies to no other part: a round
  hubcap's rim is chamfered, so its design face is inset from the edge and
  cutting through wouldn't put the colour on the rim. Outside edge only: a
  silhouette enclosing a hole keeps a base-colour rim around it, see
  [docs/tech-debt.md](docs/tech-debt.md).
- **Raster artwork.** The dropzone now takes PNG, JPG or WebP (and GIF or BMP)
  as well as SVG. Images are quantized into flat colour regions, traced back to
  outlines, and go through the same placement, merging, cutting and export path.
  Format is detected from the file's bytes, so a mislabelled file still works.
  Transparent areas cut nothing, and a phone photo arrives the right way up.
- Each loaded image gets **Colors** and **Detail** sliders on its row. Colors
  sets how many flat colours to reduce to, with a readout of how many were found
  and how many regions that came to. Detail trades fine texture against
  printability. Smoothing and speckle removal are tuned automatically from how
  detailed the image is, so a photo and a logo are handled differently without
  anyone saying which. Both re-trace on release, and per-colour depths carry
  across.
- An image whose detail runs past what is printable says so and merges the
  too-fine parts into their surroundings, rather than tracing thousands of
  specks. See [docs/troubleshooting.md](docs/troubleshooting.md).
- **Traced outlines are fitted curves rather than pixel steps.** Every diagonal
  used to ship the raster's own staircase, about half a millimetre of step
  across the largest part, because corners could only land on whole pixels.
  Boundaries now fit between pixels, so a traced logo has smooth edges at any
  size while genuine square corners stay square.
- **Flat artwork is traced at twice the resolution**, keeping detail that used
  to be rounded away: on one cartoon the pupils and eye highlights survive where
  they previously merged into a blob. Photographs stay at the old resolution,
  where extra pixels buy sensor noise. The app decides which an image is by
  looking at it.
- The help panel has an About section linking
  [3d-mobility.org](https://3d-mobility.org), where the TMT's printable part
  files and assembly instructions live.
- Below 900px window width, a plain message asks for a wider window instead of
  showing the layout crushed. The desktop-only range is now driven and
  screenshotted from 1920 down to 900px rather than asserted.
- Every confirmation and error alert now uses a themed dialog matching the app
  instead of the browser's unstyled `confirm()`/`alert()`.
- The warning panel shows every current warning, not just the first 6 with the
  rest collapsed into "+ N more warnings". Each pill has its own "×", plus a
  "Dismiss all" when there is more than one.
- **Merging colours no longer requires a drag.** Each row shows a "⠿" grip
  marking what is draggable, plus a "Merge with…" dropdown for keyboard or touch
  use. The Colors and Artwork hints now also explain Sticker/Fill.
- **The AMS slot line always shows both numbers** ("N colors → M AMS slots
  needed"), not only after a merge, and reconciles against the printer picked in
  Export: brightening past the 4 slots in one AMS unit, red only past what the
  printer can do in one go (16 across chained units on X1C/P1S/A1, 25 on an H2D
  across both nozzles, a hard 4 on the Snapmaker U1). A pill says which and how
  to get the count down. Both update on switching printers rather than waiting
  for an export, and dismissing the pill keeps it gone until the count or
  printer changes. The printer picker is relabeled name-first.
- **A second design no longer lands exactly on the first.** On an assembly part
  it starts stepped 8mm across and down, so it is visible and draggable without
  moving the design covering it.
- **Designs overlapping on one surface now warn, naming both by filename.** Two
  overlapping recesses export as two inlays claiming the same space, which a
  slicer resolves arbitrarily; nothing said so before. Two Fills get their own
  wording, since moving or rescaling can't fix that. It doesn't block exporting,
  and compares bounding boxes, so a design nested cleanly inside another can
  trip it.

- **Your session now autosaves as you work** (part, artwork, placement, colours,
  depth, printer) and offers to restore it after a reload, close or crash. A
  dismissible banner asks first; nothing is applied or rebuilt until you choose.
  Leaving the tab with loaded artwork prompts to confirm. **Not restored:** an
  uploaded STL reference mesh, or a loaded image, which must be re-dropped. A
  session holding only an image saves nothing and offers no restore, but does
  prompt on leaving, since that work genuinely can't be brought back.
- On a part with several design surfaces, a design landing on just one now says
  so: the row shows a "→ Zone name" badge, a pill names the zone and how many
  surfaces are still blank, and exporting with blank surfaces warns which will
  print body-coloured.
- **The Artwork panel takes more than one design at once.** Each load adds a row
  instead of replacing the last. Click a row to make it the design the fit
  sliders and gizmo edit.
- **Sticker or Fill** on an assembly part. Fill repeats the design across the
  whole surface, one repeat per SVG document, clipped to the surface edge.
  Scale sets the repeat size, Offset
  shifts the pattern, and a fill needing an unreasonable number of repeats is
  refused with a warning rather than hanging the tab.
- **Export placement now checks the loaded mesh matches the mesh its baked
  constants were verified against**, using the same fingerprint guard (triangle
  count plus bbox hash) design zones already use. A part id renamed out of sync
  with the placement table, or an asset re-packed without re-baking, now exports
  auto-placed with a warning naming the part instead of silently applying
  another part's rotation and position. A mesh you drag in inherits a role's
  baked placement only if it really is the same mesh; otherwise it is placed
  automatically with a quiet notice. (See the `wheel-mount-left` id-collision
  fix under Fixed for the class of bug this generalizes a guard against.)
- **A `?kind=` URL parameter** opens the app straight onto an assembly kind
  (`?kind=footrest`, `?kind=hubcap`) instead of the wheel, so a link can
  point at the part being discussed. An unknown or missing value opens the
  wheel. It also reaches a kind left out of the Part dropdown.

### Changed

- **Warnings and notices read as short sentences.** Long run-ons are split, so
  each sentence does one job, and none of them use em dashes. A check keeps new
  ones out.
- **"→ base" now adds a color to the base instead of replacing what is there.**
  Sending a second color to the base used to silently drop the first back to
  being cut, while dragging that same color onto the Base row added it. Two
  gestures on one target that did opposite things, and the only warning was in a
  tooltip. Both now add. To take a color back out, use the "×" on it in the Base
  row, which is what that button was always for.
- **Selected things in the left panel no longer go blue.** Blue is a filament you
  might own, so a blue ring around a blue filament swatch was the place it
  collided hardest. The selected body color now takes a two-tone ring that reads
  against any color, the selected artwork row takes a plain border and a lighter
  background, and the auto-merge label keeps its bold and drops the tint.
- **The dropzone now says SVG comes out sharpest.** SVG and a photo were shown
  as parallel, equal-quality choices, so nothing on screen said an SVG was
  already available before the app had to trace and simplify a photo to get
  one. A photo that traces cleanly now gets a dismissible notice naming it,
  the same way a photo that hit the detail cap already did.

- **Parts appear faster.** Working out how to shade a part, so its curves
  look curved and its machined edges stay crisp, meant re-deriving which corners
  the model already knows are joined. It now reads that from the part instead,
  which is about nine times quicker. Checked side by side
  on screen at the same camera: 616 pixels out of 864,800 changed, none of them
  by enough to see. A part you drop in yourself still takes the slower route,
  whatever the file type: we cannot tell whether it records joined corners, and
  guessing wrong would make it look faceted.

- **Busy designs build faster.** Working out which color is visible where is the
  slowest step of a flat build, and it now asks the shape engine for many shapes
  at once instead of two at a time. A 135-path drawing went from 2.07 to 1.18
  seconds in that step, and simpler files from 1.5x to 2.9x faster. The shapes
  that come out are the same, checked by area on every color. One rare warning
  changed with it: when the maths fails while merging what is painted over a
  region, it no longer names a color, because that step now handles several
  colors at once and would have named an arbitrary one of them.

- **The capacity pill states one way out instead of three.** It read `5 filament
slots needed, but … tops out at 4 in a single print. Either drag one color row
onto another to merge them, or "→ base" to print one in the body (auto-merge
alone may not be enough).` It now reads `… tops out at 4 in a single print. To
fit, drag one color row onto another to merge them.` Printing a color in the
  body, and swapping filament mid-print, are in Help, which is where a list of
  alternatives belongs. The quieter note you get when a design needs more than
  one unit but still fits the printer keeps saying so, since "this still prints"
  is the reason it is a note and not a warning; it lost the same two extra
  remedies. Its hover text lost an em dash with them.
- **The cut warnings say what happened to your print, not what happened inside
  the app.** `Couldn't build the cut solid for color #0a0a0a on Handle (left)`
  is now `Couldn't cut color #0a0a0a into "Handle (left)"`, and `Boolean union
failed` is `Couldn't merge the shapes`. Seven warnings in all, none of them
  longer than the string it replaced. The merge warning also stopped guessing:
  it used to blame "a self-intersecting path in the source SVG", the common
  cause but not the only one, since a design repeated across a large zone can
  simply be too big. It names no cause now and troubleshooting carries both.
- **The accent stripe is drawn in the app's own two accent colors.** The bands
  across the top and bottom of the window ran purple to indigo to teal, three
  colors that appeared nowhere else in the app and in none of the token files.
  They were a near-copy of makegood.design's banner gradient. Both bands now run
  blue to cyan, `--accent` to `--accent-2`, so the stripe can't drift from the
  palette the rest of the app uses.
- **The session-restore banner's copy is set at the same leading as every other
  paragraph in the app.** It was the only one at 1.4 rather than 1.55, with no
  stated reason. This is the one visible change in a pass that otherwise moved
  hardcoded CSS values onto the design tokens that already carried them (weight,
  tracking, transition duration, swatch outline). Everything else is
  byte-identical in what it renders: the audit's full-page census of every
  rendered font size, weight, radius and colour is unchanged, and `var()`
  adoption went from 80.0% to 84.5%.
- **Panel explainer text is shorter, and mechanism help has moved to Help.** The
  Colors detected hint packed six mechanisms into 96 words, and the Body colour
  hint explained itself by pointing at two controls in another panel. Both are
  now one or two sentences; Help already carried the detail. The Artwork hint
  drops its Sticker/Fill paragraph for the same reason. Nothing was
  removed from Help. See [docs/tech-debt.md](docs/tech-debt.md) for the model
  problems the copy was covering for.
- **The Help dialog is rewritten to the docs sentence rules.** Same eight
  sections, same facts, same verified numbers. 38 em dashes and 57 sentences
  over 20 words are gone; the longest sentence went from 50 words to 21.
- **Help and panel text no longer uses words you would only have from CAD.**
  "Quantized", "export artifacts", "shading ramps", "dominant member",
  "chamfered edge" and "viewBox" are gone, replaced by what they mean.
  Slicer words stay: filament, layer height and tileable are words you already
  use. Every measurement is unchanged.
- **The thumbnail beside the Part dropdown is now the part.** It was one of a
  few hand-drawn glyphs chosen by how artwork is fitted rather than by what the
  part looks like, so the footrest and the hubcap showed the same
  rectangle. It is now drawn from the loaded mesh, at your display's real pixel
  density and with a defined edge, from a fixed three-quarter angle so a thick
  wheel and a thin cap are told apart. Neutral rather than accent blue, which is
  reserved for selection.
- **A Fill that couldn't be repeated across a surface now says why.** One
  message covered four failures and told you to raise Scale for all of them,
  right for one. Each now names the design, the part, its cause and its remedy:
  too small to tile, no extent one way, a collapsed placement, or a part too
  curved. See [docs/troubleshooting.md](docs/troubleshooting.md).
- **The selection frame in the 3D view is no longer accent blue.** It was the
  same blue the app uses for its controls, over artwork that is frequently also
  blue. The frame and its corner handles are now white; the rotate handle moves
  from an off-palette green to the palette's cyan. Nothing about its shape or
  dragging changed. It is still faint where it crosses a light part, see
  [docs/tech-debt.md](docs/tech-debt.md).

- **Typography and spacing now run on tokens.** The app declared no `--text-*`
  or `--space-*` property: 50 font-size rules and 97 padding/margin/gap rules
  hardcoded their own px values, independently of each other and of
  `design-system/tokens/`, which had inventoried those values and called the
  inventory a scale. `src/styles.css` now declares five type tokens
  (`--text-label/meta/body/emphasis/display`) and five spacing tokens
  (`--space-hair/tight/row/section/panel`).

  Two real bugs surfaced doing it: `.close-btn`, `.warn-dismiss` and
  `.warn-clear-all` rendered in Arial rather than Inter, because form controls
  don't inherit typography and nothing had set theirs; and `<code>` in the help
  panel rendered in the browser's default monospace rather than IBM Plex Mono.
  Both fixed.

  `scripts/check-type-scale.mjs` (`npm run check:type-scale`) asserts that no
  hardcoded px survives and every computed font-size is one of the five.
  Design-system side: `tokens/typography.css` and `tokens/spacing.css` renamed
  to the same five tokens each, `--font-heading/--font-sans/--font-mono` renamed
  to `--heading/--sans/--mono`, and every reference updated. Values fitting
  neither scale are resolved as comments beside the code they constrain, or
  promoted to [docs/tech-debt.md](docs/tech-debt.md).

### Removed

- **Bringing your own STL or 3MF is no longer offered.** A part row could take a
  dropped mesh, with per-part "+ Add" buttons beside it, on the one screen you
  reached when the parts hadn't loaded. The app can't check that a mesh you
  supply is the part it stands in for, and every hand-verified plate position,
  rotation and prime tower is keyed to the shipped part, so anything dropped in
  exported at a computed position nobody had opened in a slicer. If the parts
  can't be reached, the panel now says so and asks you to reload the page. The
  Advanced per-part face and alignment controls are untouched.

- **Disc (reference) is out of the Part dropdown.** It was a plain flat plate
  you sized by hand, matching no TMT part, listed beside the real ones at the
  same weight. The dropdown is the parts themselves now: Wheel, Hubcap and
  Footrest. Two controls that only ever applied to a flat plate go with it: the
  Margin slider in Artwork fit, and the per-color STL set. Both were already
  hidden on a real part, so nothing changes about what you get from one.

- **The standalone hidden "Wheel mount (left)" assembly kind.** Briefly shipped
  then deliberately un-shipped with no technical blocker recorded, asymmetric
  (left-hand only, no matching right), and its role id collided with another
  part's wheel-mount role in the export placement logic. That part's own
  left/right wheel mounts are unaffected; they were always separate files in a
  separately-verified pose.

### Fixed

- **An edited template no longer loads a quarter too small.** Download the
  footrest template, edit it in Affinity, load it back, and the artwork landed at
  199.8mm on a 266mm face: exactly 75%, with nothing on screen saying so. The
  export writes the size as `755px`, and px means a different real size in every
  editor (Affinity writes 72 to the inch, the web standard says 96). The app now
  treats a size given only in pixels as no size at all and fits the page to the
  part face, which puts that template back at 265.7mm, and says it did. Ticking
  "Set viewBox" on export did not help and was its own quiet 75%. To get an
  exact size rather than a fit, set the document units to millimeters before
  exporting. A file that gives its size in mm, cm, or inches is unaffected.

- **A depth of 0 no longer reads as 0 when the app is using 0.20.** The field
  kept showing what you typed, and the only place the real number appeared was a
  warning that goes away when dismissed. The row now says `raised to 0.20` beside
  the field. A depth deeper than the part is still only reported in the warning, since
  that limit belongs to the part rather than the number, and it is in
  [docs/tech-debt.md](docs/tech-debt.md).
- **Design radius no longer accepts 0 or a negative number.** Zero made every cut
  fail while Export stayed green, and a negative built as if it were positive.
  Both now snap back to the last good value.

- **The prime tower warning no longer names a position the file does not carry.**
  Where every corner of every plate overlaps a part, the app saves no tower
  position and leaves the slicer to place it, which is right: pinning a spot it
  has just measured as colliding would be asserting something false. The warning
  said the opposite, quoting coordinates that appear nowhere in the export, and
  the help said the tower goes in the freest corner regardless. The warning now
  says which of the two happened, so it asks you to move the tower only when
  there is one to move.
- **Placement warnings clear when they stop applying.** They named a part, a bed
  or a plate size, and were only cleared by the next export, so switching part or
  printer left pills describing a setup that was no longer on screen.

- **A recess deeper than the part no longer cuts silently.** Setting a depth
  larger than the part had material for built and exported with nothing said. It
  is now cut at the deepest that part can take, with a warning naming the color
  and the part. This bounds the part, not its wall: a pocket deeper than a thin wall in
  one spot still cuts through without comment, which is in
  [docs/tech-debt.md](docs/tech-debt.md).

- **Restoring a session could hand you a file with the wrong part in it.** Bringing
  back a saved footrest or hubcap raised a second question on top of the one you
  had just answered, "Load the full Footrest? This clears any parts you've already
  added". Answering Cancel, which is the careful-sounding answer, left the part
  menu naming one part while the screen still held another. Export then wrote the
  part on screen into a file named after the part in the menu: a complete,
  printable wheel called `mosaic-footrest.3mf`, with nothing on screen saying so.
  The second question is gone.
- **Three ways your saved work could disappear.** Opening a link that names a part
  (`?kind=footrest`) deleted whatever you had saved. So did reloading while the
  "Restore your previous session" offer was still on screen, about a second into
  the page. So did a restore that failed. All three were the same thing: the app
  cleared the save before you had answered the offer. It waits now.
- **A restore that fails says so.** It used to delete the saved session and change
  nothing on screen, so it looked like the button did nothing.
- **A saved session from an older version comes back instead of being dropped.** A
  session missing a setting that did not exist when it was saved could stop the app
  building at all until you reloaded the page. The missing settings start at their
  normal values.
- **A saved printer that no longer exists no longer blanks the printer picker.** It
  used to leave the box empty while the export quietly used a different bed, which
  is what the verified part positions are checked against.

- **Traced images keep their small detail at the size you placed them.** The
  cleanup that merges too-small regions was sized as a share of the picture, so
  the same cartoon lost its eye, teeth and emblem on a full-size wheel where all
  of them would print. When the design is on a wheel, hubcap or footrest, the
  cleanup is now sized in millimetres: everything down to a 1.6mm feature stays,
  nothing under one nozzle width survives, and small faces keep the coarser
  cleanup they had. Photos are unchanged.
- **Far fewer color threads and stair-steps along traced outlines.** Cartoon-like
  images picked up part of the smoothing meant for photos, which turned the soft
  edge of every outline into a thin band of a third color, one to two pixels
  wide and jagged. That smoothing now stays on photos. A rare hair-thin thread
  can still appear along a high-contrast edge; it prints thinner than one nozzle
  width, so most slicers drop it.

- **The "≈" filament name beside a detected color now matches what it looks
  like.** The nearest match used plain RGB distance across the 13 owned
  filaments, which can rank brightness above color: a saturated teal read
  closer to Grey than to Blue, and near-identical colors could get different
  names. It now matches on how colors actually compare to the eye. The
  palette also gained Cyan and Magenta, since neither had a filament to match
  against before.
- **The Colors panel shows the body color instead of saying where to find it.**
  With nothing grouped into the base, the row read "Base — empty; body uses the
  blank color set in Part". It now shows a swatch of the color the body will
  print in, so the answer is on screen rather than in another panel.
- **Picking a different design face updates what the panel says about it.** Under
  "Advanced: per-part face & alignment", the "face detected" line kept describing
  the face the part loaded with, sitting directly above a dropdown naming a
  different one. It now updates with the choice, normal, plane offset and
  boundary points together.

- **Detail too fine to print is dropped by how big it prints, not by how big the
  image is.** The trace merged away anything under a share of the image, which
  for one photo meant merging features under 8.7mm on the footrest and under
  1.4mm on the smallest hubcap: same slider, wildly different sizes, and the app
  had no idea which. It now knows how large the design is placed, and never keeps
  a piece smaller than a 0.4mm nozzle can lay down. Most designs are unaffected,
  because on the footrest and the wheel at normal sizes the old rule was already
  the stricter one. It shows on small parts and at high Detail: the MakeGood logo
  on a 32mm hubcap comes back with the same wordmark and 12 fewer unprintable
  crumbs around it, 54 regions against 66. Parts only for now, not the flat disc
  and plate shapes. The size is read when the image is traced, so if you resize the part or
  the design a long way afterwards, nudge Colors or Detail to trace it again.
- **An image traces to clean regions instead of a field of specks.** The step
  that merges detail too fine to print could shuffle it instead: two specks side
  by side traded colors and both stayed. A photo of gravel came back as 1251
  separate regions, nearly all of them under the size the app had just decided
  was printable. That photo now traces to 67 regions, and a cartoon to 21
  instead of 414, with its eyelashes as continuous marks where they used to be
  broken dashes. Line art is unchanged. Some images come back with fewer
  colors, because the ones that go were only ever painted in those specks.
- **The "designs overlap" warning no longer fires on a design sitting in
  another's empty middle.** Put a logo inside a frame, or a caption inside a
  border, and the app warned that their recesses cut into each other. They never
  did, and nothing you could do cleared the warning short of breaking the
  layout. It compared the two designs' rectangles, so a frame read as covering
  everything it surrounds. It now also asks how much of each design's artwork
  reaches the rectangle they share, and stays quiet when one of them brings
  none. Two designs that really do cross warn exactly as before.
- **Loading a second small design usually lands it beside the first, not half on
  top of it.** A new design steps diagonally off one already in that spot. The
  step was a fixed 8mm, which for a design around 10mm across left the two
  cutting a few percent into each other, too little for the overlap warning to
  say so. The step now grows to the size of the largest design on that surface,
  up to 11.7mm, which sets two designs of a similar shape and size down clear of
  each other. A surface that already carries something bigger than that, the
  wheel's full-size design for one, still steps 8mm as before, and two designs
  of opposite proportions can still land slightly on each other in silence.
- **Artwork around a hole in the part now prints in your color, not the base
  color.** Two places this showed. Cut a hubcap to the shape of a picture with a
  gap in it, and the color around that gap stopped 1mm down, leaving a 2mm band
  of base color on the inside wall, while the outside rim came out right. And on
  the footrest, a color laid over its two mounting slots was cut across their
  rims, shaving the rounded lip on each one. The app read a design face as a
  single outline, so a hole in that face was invisible to it. It now keeps every
  edge of the face, the outside and the holes alike, and treats them the same
  way. The wheel exports byte for byte as before.
- **A busy photograph no longer loses a color on the part.** Dropping a detailed
  image on the wheel could raise "Couldn't cut color … into …", and that color
  went missing from that part. Behind it, the repair the app already runs on
  fiddly artwork only tried one setting and gave up. It now tries a second,
  slightly stronger one. On the photograph that turned this up, eleven regions
  needed repairing, ten came back with the first setting and one needed the
  second. The stronger setting trims 0.05mm off the edge of the artwork, an
  eighth of a 0.4mm nozzle, and can only drop detail thinner than 0.1mm, which is
  a quarter of a nozzle and could never have printed.
- **A decorative circle in your artwork no longer hijacks the whole design.** On
  a wheel the app sizes artwork to the circle a design template draws around its
  boundary, and it was taking the largest circle in the file whatever it was. A
  7-color drawing with four small dots in the corners had the first dot blown up
  to the full 276mm face and the other three thrown clear off the part, with
  nothing said. Kid-oriented clipart is full of circles (suns, balloons, eyes,
  polka dots), so this was easy to hit and looked bizarre. A circle is only used
  as the boundary now if the rest of the drawing sits inside it.
- **The message about it pointed the wrong way.** A design with no circle, which
  is the case that behaves well, got a notice; a design whose scale was being set
  by a circle got nothing. Now it says so when a circle sets the scale, and is
  quiet when your artwork is simply centered on the part.
- **A cut warning no longer claims a color is missing when it is only partly
  missing.** The per-region warning is raised per region and the build carries
  on, so a color split across two depths keeps the slice that did cut. The
  warning now names the color and the part and stops there.
- **The unreadable-mesh warning named the wrong problem.** It said to check the
  mesh was watertight, which is a different failure with its own warning five
  lines away, and it never mentioned that the part is left out of the export
  entirely. It now says that.
- **The app no longer tells Snapmaker owners about their AMS.** The U1 feeds
  from a built-in 4-head toolchanger and has no AMS, but with it selected the
  slot line's tooltip read "Fits a single 4-slot AMS unit" and the capacity
  warning counted "AMS slots". Every string naming the hardware now reads it off
  the selected printer, so the U1 says toolchanger and the Bambus still say AMS
  unit.
- **One word per concept, across every string.** The app used "surface" for two
  different things (a **zone**, one of several named design areas on a part
  that has them, and the **design face**, the single area on a part with one),
  and spread "AMS slot", "filament slot", "filament" and "color" over what is
  really three things: the color your artwork has, the filament that prints it,
  and the numbered slot it sits in. "surface" is gone, the slot line reads
  "3 colors → 4 slots needed", and warnings, help and the templates link all
  agree.
- **A color scaled or dragged off the part no longer costs a filament slot.** In
  assembly mode, a color whose regions all fell outside the design face
  vanished from the color list but still shipped as a filament in the exported
  3MF and still counted in the slot line and the capacity check: a
  7-color file with 2 colors off the wheel asked for 7 filaments, 2 of which
  printed nothing. The export now writes only colors that actually cut an
  inlay somewhere, every counter agrees with it, and a warning names the
  colors that fell off. Found by the 2026-08-16 maker ease-of-use review.
- The colors chip above the list says "1 color" instead of "1 colors". The
  slot line beside it already did.
- **A recessed background counts as a color, so the slot line adds up again.**
  With "Recess bg too" on, the background prints in its own color and takes a
  slot, but the line counted only the colors found in your artwork: it read
  "3 colors → 5 slots needed" beside a "4 colors" chip, showing the body's
  "+1" as an unexplained +2. Flat shapes only, and only with that box ticked.
  Help now says the recessed background takes a slot.
- **The sample artwork now fits a single AMS unit.** The badge was 4 colors
  plus the body, 5 slots, so on the default printer the demo's first act was
  a capacity pill saying it needed more than one AMS unit. It is now 3 colors
  plus the body: the inner disc is gone and a ring that never traced (a
  stroke with no fill) went with it.

- **The Help panel and the Fit hint now mention Flip V.** Both explained Flip H
  and stopped, leaving the checkbox beside it undescribed. Both now say it
  mirrors top-to-bottom, and Help adds that Flip H/V are mirrors, not rotations:
  artwork that imported upside down wants Rotation. The assembly-mode Fit hint
  is a separate string and was still missing it; it now matches.
- **The Export hint no longer drops two slicers on flat parts.** The markup
  named Bambu Studio, OrcaSlicer and Snapmaker Orca, then a script overwrote it
  with Bambu Studio alone, so the other two were never seen. Both now agree.
- The Help dialog now closes when you press Back after following one of its own
  section links. It used to stay on screen over an app you had navigated away
  from.
- **The prime tower is now positioned on plates with no verified position**,
  instead of being left to the slicer's default, which for a part just centred
  on the plate could put the tower through it. Affects flat-plate exports and
  any part whose placement didn't verify.
- **The suggested tower position is now the corner it claims to be.** It was
  computed as the centre of a corner-inset square but written as the tower's
  front-left corner, so it landed half its own width up and right of the space
  checked as free: into the part on a near corner, off the bed on a far one. It
  now keeps clear of the bed edge, prefers a corner away from the front-left
  nozzle-wipe exclusion, and writes no position at all when no corner is free
  rather than one it has measured as colliding.
- **Parts in the 3D view were flat-shaded**, so every curved surface showed its
  facets: banding across curved bodies, polygonal silhouettes.
  Curves now read as curves, while chamfers, panel seams, slot edges and
  embossed lettering stay crisp. Preview only; nothing about the export changes.
- **A part could open with its edges cut off.** The camera fit sized itself
  from the part's largest single dimension, right only for something as wide as
  it is deep, which put the camera up to 1.65x too close. It now solves the
  distance that contains the part from the direction being viewed and accounts
  for a narrow window as well as a short one. Parts that already fitted are
  framed slightly larger, not smaller.
- A part could be framed while the rest of the assembly was still loading,
  fitting all its pieces to whichever few had arrived.
- **A hole in a traced image could be painted over instead of cut.** Where a
  region's cavity met its own outline at a point, common in a busy image and
  exactly the point tested, the cavity read as a solid island, so that colour
  covered it and swallowed whatever sat inside. Measured on a fixture: a
  13-pixel region of a second colour, gone entirely.
- **The "too fine to print" notice advised raising Detail, which makes it more
  likely, not less**: Detail sets how small a speck survives, so raising it lets
  four times as many through. It now says to lower it, and names the image, so
  re-tracing one no longer retracts a notice that still applies to another.
- **Nudging Colors wiped every per-colour recess depth in assembly mode**, the
  app's main mode. Depths are keyed differently there, and the code carrying
  settings across a re-trace only knew the flat form, so it matched nothing and
  the cleanup pass deleted them all. The slider was safe in flat mode only.
- The colour readout counted colours nothing was left painted in: a colour could
  win a palette entry and have every region merged away, and still count.
  "3 colors · 2 regions" now agrees with the colour list.
- Dropping a GIF, BMP or TIFF failed with "SVG could not be parsed — check the
  file is valid XML", true but useless about a file that was never XML. GIF and
  BMP now load; a TIFF says what is actually wrong and what to do.
- A session holding both an SVG and an image reported a clean save and dropped
  the image silently. Leaving now prompts, since the restore brings the SVG back
  and the image must be re-dropped.
- **A one-pixel feature in a traced image could vanish entirely** rather than
  round off: a thin stroke, a whisker, a single-pixel checkerboard cell. Its
  outline was thin enough that the curve fitter mistook the shape for a straight
  line and collapsed it. Measured across a straight stroke, a shallow diagonal
  and a zigzag, all now trace to their exact pixel area.
- Flat art small enough to skip the 1024px detail pass still got the one-pixel
  blur meant to compensate for it, losing an isolated pixel, a thin cross, a
  short bar. The blur now applies only when the detail pass ran.
- **Leaving the page no longer always prompts.** The browser's native "Reload
  site?" fired on essentially every reload once any design was loaded, even
  though the session autosaves and offers itself back. It now flushes the
  pending autosave first and warns only when that save genuinely failed:
  storage full, private browsing, or a session too large.
- The unit label at the end of the Artwork Fit rows was cut off by the panel
  edge, so Offset X and Y lost most of their "mm" and Scale part of its "%". The
  panel is fixed width, so this happened at every window size. The slider now
  gives up the pixels instead. The smoke check measures every unit label against
  the panel edge.
- **Neither export button had a re-entrancy guard.** Confirmed live: 5 rapid
  clicks on "Export print-ready 3MF" triggered 5 independent exports. Both
  buttons now disable for the duration of their own export.
- **Every form control now has a real accessible name** (`<label for>` or
  `aria-label`), not a hover tooltip or nothing. A driven audit across five app
  states (up to 134 controls in the richest) found zero unlabeled controls,
  against a ~63% baseline ("77 of 123") an earlier review measured.
- Dropping a PNG or JPG failed with the same useless "SVG could not be parsed"
  message. It now says the file is a raster image and points at the part's
  design template.
- **A shape dimension field emptied or set to 0 applied silently**: diameter 0
  didn't error, it deleted the part. Those fields now reject anything below
  their own valid floor (0 stays valid where it legitimately is, like corner
  radius) and snap back to the last valid value on blur.
- **In the flat modes, a depth deeper than the plate, or zero or negative, was
  quietly cut at the nearest depth the plate could hold**, so a depth of `100`
  on a 4 mm disc exported a valid file that wasn't the one you asked for. It is
  still clamped, since a recess reaching the back would cut through, but a
  warning now names the colour, what was asked, and what was cut, on every
  rebuild rather than only the first.
- **A depth of 0 or less on an assembly part dropped that colour with no recess,
  no inlay and no message.** It is now raised to 0.20 mm and says so. Relatedly,
  a field left at a deliberate `0` was read as "no depth set" and replaced with
  the global Depth, so a row reading 0.00 could cut a full millimetre.
- **A depth of zero or less now falls back to 0.20 mm rather than 0.02 mm.** A
  fiftieth of a millimetre is a tenth of a layer: it sliced to nothing, so the
  colour printed as bare body while still using a filament slot, and the warning
  said it had been cut. A positive depth thinner than a layer is still cut
  exactly as asked, a real choice on a fine layer-height profile, with a quiet
  note that it won't show on a standard 0.2 mm one. That note stays quiet for a
  colour only on a cut-through part like the wheel's cap.
- **A colour's depth row now shows when it carries its own depth** rather than
  following the global **Depth**: the field is highlighted and gets a "↺" to put
  it back, and hovering either says which depth is in use. The two looked
  identical before, so a pinned row made the Depth field appear to do nothing.
- A per-colour depth on an assembly part is now forgotten along with the design
  it was set on. It used to be kept indefinitely, so a new design reusing the
  same colour was silently cut at the old depth. Flat mode already did this.
- The depth field is wide enough for "50.00". It clipped the last digit at five
  characters, exactly the range the out-of-range warning asks you to look at.
- **Restoring a session from an earlier build no longer reinstates a per-colour
  depth override for every colour.** Those were written automatically rather
  than chosen, and restoring them left the global Depth unable to move any row
  and the out-of-range warning silent. Restored rows start under the global
  again; a depth deliberately set before this release must be set once more.
- **The 3D viewport redrew every frame for the whole session**, whether or not
  anything changed, keeping a core busy behind an idle model: heat and battery
  drain on a laptop, and a slow app wherever the browser falls back to software
  rendering, where each redraw competed with geometry rebuilds for the same
  thread. It now draws only when something changes.
- **The camera's glide after an orbit decayed per frame rather than per second**,
  so on a slow renderer it kept easing, and redrawing, long after the gesture:
  measured at 221 s where it should be about one. The decay now scales to real
  frame time, identical at 60 fps and about a second at any rate.
- **A warning could stay on screen after a later, successful rebuild superseded
  it.** Warnings were cleared only when an SVG was parsed or the Artwork panel
  changed, never per rebuild, and they dedupe by message, so a cut failure from
  an earlier zone or mode binding survived indefinitely describing geometry no
  longer in the viewport. Diagnostics a rebuild regenerates are now cleared at
  the start of each attempt; standing facts that nothing re-derives are left.
- **An assembly is now centred over the grid, not just rested on it**, and the
  grid grew from 600 mm to 800 mm (still 20 mm cells) to hold the largest part.
  A part whose CAD origin is a datum rather than its middle could stand almost
  entirely off the back edge of a stage sized for the 280 mm wheel. The wheel
  and footrest don't move perceptibly.
- **Wheel mode's design-boundary anchor** (the SVG's largest `<circle>`) is now
  read through the same viewBox-origin and group-transform maths as every other
  shape, and searches only the visible subtree, excluding
  `defs`/`clipPath`/`mask`/`pattern`/`symbol`. A non-zero-origin viewBox or a
  circle inside a transformed `<g>` could anchor the design off-centre with no
  indication, and an invisible clip-path circle could silently win over the real
  boundary.
- **A part whose cut solid couldn't be built still exported its inlay solids
  alongside the untouched, uncut body**, which a slicer resolves arbitrarily: an
  export-quality bug with nothing on screen saying the file was malformed. That
  part now exports uncut and without inlays, and the warning says so. The same
  pass no longer aborts the whole rebuild, blanking the viewport and leaking
  WASM memory, when merging one colour's cutters or a part's whole set fails.
- **A part whose pocket cut reached all the way through vanished from the
  viewport and export with no explanation**: the boolean succeeded but produced
  zero geometry, so no CSG-failure warning fired. Export now warns which part
  was dropped and why.
- Clearing an assembly part's Advanced pivot or angle field emptied the input to
  `NaN`, which reached the part transform and blanked the whole 3D viewport with
  no warning. Those fields now snap back to their last value.
- The 3MF writer now refuses to write a non-finite plate coordinate or
  transform, previously substituted as `0`, so an internal bug producing bad
  geometry fails the export instead of shipping a spike vertex.
- **The on-face gizmo now sits on the surface the active artwork row is bound
  to.** It always used the first zoned part's first zone, so on a part with
  several it stayed put whatever you selected, reading as a frame stuck at an
  angle with every drag editing a surface you weren't looking at.
- A part whose design-zone data can't be downloaded is now left with no design
  surfaces, rather than stamping the artwork flat onto whatever the largest flat
  face of that piece happens to be.
- **Loading or removing a design now drops colour settings** (base assignments,
  merge groups, pinned-apart colours) for colours no loaded design paints any
  more. A colour the previous design sent to the base could otherwise stay
  silently excluded from cutting.
- **An export of three or more plates laid them out in a single row**, where the
  slicer expects a square-ish grid, so the third plate and everything after
  landed on empty space past the last column. Nothing shipped had hit it, since
  the wheel's two-plate export is a single row either way.
- **A plate whose tower has no verified position could be handed one inside a
  part.** The fallback chose its X and Y insets independently, so a group
  leaving room along each axis separately could still occupy the corner where
  that room met. It now scores whole corners, and warns when every corner is
  occupied instead of picking one silently.
- Export warnings now cover a part placed past the plate edge, not only one too
  big to fit at any position. A verified placement transfers to a smaller bed
  than it was checked on without anything having said so.
- An SVG with pathologically deep nesting (thousands of nested rings in one
  path, or thousands of nested `<g>`) failed with a raw "Maximum call stack size
  exceeded" instead of a message naming what was wrong with the file.
- **A rect-fit design was placed by centring the artwork's drawn content on the
  surface**, rather than lining the artwork's document canvas up with it. The
  two agree for a design filling its canvas, but a design drawn in one corner of
  a template, matching where that corner sits on the physical part, got
  re-centred and landed on whichever part sat in the middle of the zone.
  Position was the one thing a template expresses that placement threw away,
  which also meant the footrest template's "keep artwork clear of the mounting
  slots" guidance couldn't be followed. Placement now anchors on the document's
  own canvas, its viewBox or its declared millimetre size, so a template loaded
  at Scale 100% and Offset 0/0 lands exactly where it was drawn.
- **The on-face gizmo now encloses artwork drawn off-centre in its document**,
  instead of sitting where the document's centre lands. The frame is what the
  move gesture hit-tests against, so such a design previously offered a
  selection box that didn't overlap its own artwork.

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
