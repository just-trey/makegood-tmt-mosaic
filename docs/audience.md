# Audience

Who this tool is built for, and what "good" looks like for them.

## Who

Hobbyist printer owners, MakeGood volunteers, parents, and educators building
a Toddler Mobility Trainer for a specific child. They know their slicer —
Bambu Studio, OrcaSlicer — well enough to import an SVG, place a color, and
hit slice. They know AMS / AMS Lite and how a filament slot works.

They do **not** know CAD. They've never opened Fusion 360, don't think in
meshes, vertices, or UV unwraps, and shouldn't need to start to put a design on
a wheel.

## Goal and success measure

A first-time volunteer, given an SVG and a printer, reaches a printable,
correctly-colored 3MF without touching a 3D modeling tool. That's the bar for
every workflow decision: a step that requires CAD literacy is a bug in the
tool, not a training gap in the user.

## Competitive framing

The nearest comparison a reviewer will reach for is MakerWorld's Mesh
Graffiti — flat-color image-to-multicolor-print tooling for the same no-CAD
audience. Where this tool goes further, and why "just make it more like Mesh
Graffiti" usually misses the point:

- **Cross-part conformal unwrap.** A design can span a printed seam and still
  line up, because artwork is wrapped onto a baked UV chart per zone, not per
  flat face.
- **Verified export placement.** Multi-plate layouts, prime-tower positions,
  and per-part filament slots are baked from a hand-checked reference file,
  not estimated at export. The file that opens in the slicer is the file that
  was verified.
- **AMS-aware color consolidation.** Visually similar colors merge into one
  filament slot automatically, because AMS slots are a scarce resource a
  volunteer is budgeting, not an infinite palette.

A finding that boils down to "add a freehand paint brush" or "let users edit
the mesh directly" likely optimizes for a different audience. Check it against
the no-CAD constraint before filing it as a top recommendation.
