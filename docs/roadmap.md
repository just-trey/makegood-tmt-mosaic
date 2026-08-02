# Roadmap ideas (not built)

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
