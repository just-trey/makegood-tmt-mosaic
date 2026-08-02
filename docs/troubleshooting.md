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
