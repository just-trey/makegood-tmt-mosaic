# Audience

Who this tool is built for, and what "good" looks like for them.

## Who

Hobbyist printer owners, MakeGood volunteers, parents, and educators building
a Toddler Mobility Trainer for a specific child. They know their slicer —
Bambu Studio, OrcaSlicer — well enough to import an SVG, place a color, and
hit slice. They know what AMS / AMS Lite is and how a filament slot works.

They do **not** know CAD. They've never opened Fusion 360, don't think in
terms of meshes, vertices, or UV unwraps, and shouldn't need to start now to
put a design on a wheel.

## Goal and success measure

A first-time volunteer, given an SVG and a printer, reaches a printable,
correctly-colored 3MF without touching a 3D modeling tool. That's the bar for
every workflow decision: if a step requires CAD literacy, it's a bug in the
tool, not a training gap in the user.

## Competitive framing

The nearest comparison a reviewer will reach for is MakerWorld's Mesh
Graffiti — flat-color image-to-multicolor-print tooling aimed at the same
no-CAD audience. Where this tool goes further, and why a "just make it more
like Mesh Graffiti" recommendation usually misses the point:

- **Cross-part conformal unwrap.** A design can span a printed seam and still
  line up, because artwork is wrapped onto a baked UV chart per zone instead
  of per flat face.
- **Verified export placement.** Multi-plate layouts, prime-tower positions,
  and per-part filament slots are baked from a hand-checked reference file,
  not estimated at export time — so the file that opens in the slicer is the
  file that was actually verified.
- **AMS-aware color consolidation.** Visually similar colors merge into a
  single filament slot automatically, because AMS slots are a scarce resource
  a volunteer is budgeting, not an infinite palette.

A finding that boils down to "add a freehand paint brush" or "let users edit
the mesh directly" is very likely optimizing for a different audience than
this one — check it against the no-CAD constraint before filing it as a top
recommendation.
