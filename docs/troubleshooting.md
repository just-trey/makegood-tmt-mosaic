# Troubleshooting

One section per user-visible warning string.

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

## Troubleshooting: "N AMS slots needed, but … tops out at M" warnings

The design needs more filament slots than the selected printer can address in
a single print. The count is one per cut color or merged group, plus one for
the body itself, and it's the same number the line under the color list shows.
Unlike most warnings here this one isn't a geometry problem — the 3MF is
correct and still exports; it just can't be printed in one pass on that
machine.

Which printer you have decides whether this is even reachable. Every AMS /
toolchanger unit holds 4 slots, but the Bambus daisy-chain: up to 16 on the
X1C / P1S / A1, and 25 on an H2D (24 across chained AMS units plus an external
spool on its second nozzle). The Snapmaker U1's 4 built-in toolheads don't
chain, so on that printer this warning appears the moment a design needs a
fifth slot. Past one unit but within the printer's maximum you get a quieter
note instead, saying the same thing without calling it an error — printable,
but not on one AMS.

To get the count down:

- **Merge two colors** — drag one color row onto another, or use that row's
  "Merge with…" dropdown. The group prints in its dominant member's color.
- **Print a color in the body** — "→ base" on a row moves it out of the cut
  colors entirely, so it stops costing a slot.
- **Auto-merge** raises the similarity threshold, which may or may not help:
  it merges colors that look alike rather than hitting a target count, and on
  the one real 7-color volunteer SVG measured so far only `Strong` moved the
  count at all, and only by one. See
  [tech-debt.md](tech-debt.md) — "Auto-merge is a similarity control".

Exporting anyway is supported and sometimes what you want: a single-AMS owner
can print the file with manual filament swaps at the slicer's colour-change
pauses.

## Troubleshooting: "Designs … overlap on the same surface" warnings

Two designs placed on one surface are cut independently. The body takes the
union of their pockets and looks right in the preview, but each color's inlay
is built as (part ∩ that color's pocket) — so where two designs of _different_
colors cross, the exported file carries two inlay solids occupying the same
volume, and the slicer picks between them however it likes. That is the same
failure mode as the uncut-body case above, arrived at from placement rather
than from a boolean failure, and it is invisible until the file is opened.

The warning names both designs by filename ("Two placements of …" when they
are two copies of the same file). Fixes, any of which clears it:

- **Move one of them** — drag it on the face, or use Offset X/Y. The
  warning clears once they cover less than a tenth of each other.
- **Scale one down** so it fits in a gap in the other.
- **Put them on different surfaces**, on a part that has more than one: pick
  a different zone in the artwork row's dropdown.
- **Remove one** with the × on its row, if it was loaded by accident.

A little overlap is deliberately not flagged: designs placed side by side
routinely share a millimetre or two of empty bounding box, and warning about
that would make the pill worth ignoring.

**It compares rectangles, so it can warn about designs that don't really
touch.** The check uses each design's bounding box, not its artwork — so a
logo centered inside a frame, or a caption inside a border, reads as fully
covered even though the recesses never meet and the export is fine. If that
is what you have, the warning is a false alarm and the file is safe to print;
there is no way to clear the pill short of moving the inner design off-center.
Recorded in [tech-debt.md](tech-debt.md) with what an exact check would cost.

Two designs both set to **Fill** on the same surface always warn, and get
their own message: a fill repeats across the whole surface, so the second one
lands on the first everywhere. Moving or rescaling cannot clear that one —
switch one to Sticker, put it on another surface, or remove it. A fill _under_
a sticker is not flagged: a pattern background with a design on top is a real
workflow. That combination has the same overlapping-inlay problem where the
sticker's colors differ from the pattern's; it is a known gap, also in
[tech-debt.md](tech-debt.md).
