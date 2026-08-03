# Roadmap ideas (not built)

- Raster image (PNG/JPG) input: quantize to flat color regions, then reuse the
  existing region pipeline. Highest-value item per the maker-workflow review
  (`stubs/reviews/maker-workflow-review-2026-08-02.md`, 2026-08-02) — this
  audience's actual starting material is a parent's photo of a logo, not a
  clean SVG. Until this lands, a raster drop should at least fail with an
  honest message naming the real cause (tracked as near-term work, not this
  roadmap item).
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
- Surface-first zone picking: show the chair's five design zones as
  selectable surfaces on the model from the moment it loads, so "put this on
  the back" is one click before any file is chosen, instead of today's
  load-a-design-then-rebind-it-to-a-zone order (`vision`-lens review,
  2026-08-02). Depends on fixing the zone-picking occlusion gap in
  [docs/tech-debt.md](tech-debt.md) first — clicking a visible surface has to
  reliably hit the zone behind it, not a farther one, before this is safe to
  build.
- Power-user tooling for repeat volunteers, all independently raised by the
  maker-workflow review (2026-08-02): undo/redo over color merges, base
  assignment, depth and placement; keyboard shortcuts (`Ctrl/Cmd+E` to
  export, at minimum); batch export across variants and printers (Standard/Kit
  × three printer profiles is six manual passes today); a project save/load
  file so one volunteer can hand a design to another, distinct from the
  session-autosave work already landing (that recovers _your_ session; this
  is for sharing a finished setup); and a way to edit the owned-filament
  palette (`public/filaments.json`) without a code-adjacent JSON edit.
