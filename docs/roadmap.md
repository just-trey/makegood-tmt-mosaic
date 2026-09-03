# Roadmap ideas (not built)

Open questions with no obvious answer, where the measurement behind the question lives elsewhere:

- What should a Fill tile with no declared mm size repeat at? The design face is wrong and 1:1 is a
  guess; the honest answer may be to refuse Fill and say so. Measurement:
  [designMmPerUnit](../src/geometry/assembly.ts)'s docstring.
- Should per-part export placement ([src/export/placement.ts](../src/export/placement.ts)) move
  onto the `AssemblyKind`/role definition instead of staying a lookup table keyed by part id?
  Blocked on the chair's two caster roles resolving to a different mesh per hardware variant — see
  the `PLACEMENT` provenance comment there.
- Where should the open feedback popover live, given it covers a warning pill's dismiss button
  while open? See the comment above `#feedback-popover` in [src/styles.css](../src/styles.css).
- Does the caster mounts' design-zone gap describe the chair's real "central rear brace", or is the
  brace note actually describing the casters themselves? See the `_note` in
  [scripts/zone-configs/chair-body.json](../scripts/zone-configs/chair-body.json).
- A "fit N slots" input beside or instead of the Auto-merge similarity slider, so the control
  matches the audience's actual question. Measurement:
  [AUTO_MERGE_LEVELS](../src/geometry/regions.ts).
- Make the Colors-detected panel's five copy-carried mechanisms (drag targets, the grip glyph, the
  "Merge with…" dropdown, a merged group's shared depth and print color) visible instead of
  explained. See the comment above the Auto-merge hint in [index.html](../index.html).
- Delta-encode the index arrays, or a binary format, for the chair's zone sidecar. Measurement:
  the comment above the sidecar write in [scripts/bake-zones.mjs](../scripts/bake-zones.mjs).
- Replace the instance-cascade lattice with a real nearest-free-placement search over the two
  designs' actual footprints. Measurement:
  [CASCADE_CLEAR_MAX_MM](../src/state/artwork.ts).
- Record what was verified — the reference file and its hash — alongside the part fingerprint, so
  a reseal against an unchanged reference is distinguishable from one that silently redefines the
  verified pose. See the header comment in
  [scripts/bake-part-fingerprints.mjs](../scripts/bake-part-fingerprints.mjs).

- Contextual help: short hints at the point people actually get stuck (a
  control's own row), instead of relying only on the single global help
  dialog. Not built in the 2026-08 help-dialog redesign because each hint is
  its own placement decision governed by
  [ui-conventions.md](ui-conventions.md) conventions 4-6 (a control's
  explanation may not reference another panel; a concept belongs at the point
  of use, a mechanism belongs in the help dialog) — it is a per-panel design
  pass, not a copy change.
- Snap a traced image's palette to the owned-filament list
  ([public/filaments.json](../public/filaments.json)) instead of to colors
  derived from the image, so an image's regions are filaments the user actually
  has and the AMS slot count is settled before export rather than after.
- Center auto-fit on the visible part of a zone, not its whole bbox. With the
  chair's hidden surface now clipped, an auto-fit design on `seat-left` or
  `seat-right` lands mostly on covered surface: 13,971mm² of `seat-left`'s
  17,166mm² claim is covered (the bake log's per-zone `dead` figure over the
  zone's claim; `seat-right` is 13,983), and 70% of the 20,070mm² `uvBounds` bbox
  the anchor actually centres on. The overlay
  explains it, but placing straight onto the visible region would be the better
  default. The anchor becomes the chart's claim minus its `deadRegions` rather
  than the whole zone bbox. Deferred out of the dead-zones change because it
  moves placement for every zone on every kind, a far wider blast radius than
  the clip itself.
- Wrap one design across the whole chair, rather than one zone at a time. The
  owner's stated end goal, and the thing the per-zone sheets are a stand-in for.
  Two things are in the way. Each zone is its own LSCM unwrap with no shared
  parameterisation, so a design crossing from `left` to `back` has no continuous
  coordinate to follow; and an `ArtworkInstance` binds to one `zoneId`
  ([src/state/artwork.ts](../src/state/artwork.ts)), which
  [src/geometry/assembly.ts](../src/geometry/assembly.ts) matches one mapper at
  a time. "All zones" today means the same design placed on each zone
  independently, not one design spanning them. No approach chosen yet.
  - Rejected (owner, 2026-09-01): per-part design canvases instead of the
    whole-chair zones. Zones spanning printed seams are the point — per-part
    canvases would make volunteers hand-align a design across four oddly
    shaped parts, the CAD-literacy work `docs/audience.md` rules out.
- Quarter-wheel assembly kind (4 quarters + 2 mounting plates) alongside the
  existing half-wheel (Top ×2 + Cap) kind.
- A full parent-handle assembly kind.
- Surface-first zone picking: show the chair's eight design zones as
  selectable surfaces on the model from the moment it loads, so "put this on
  the back" is one click before any file is chosen, instead of today's
  load-a-design-then-rebind-it-to-a-zone order (`vision`-lens review,
  2026-08-02). The occlusion gap this used to depend on is closed — a click no
  longer reaches a zone behind whatever is in front of it.
  `npm run check:zone-occlusion` re-measures it, but nothing runs that
  automatically (it needs a browser and ~12 min), so re-run it by hand here.
  This is also conventions 9 and 15 of
  [ui-conventions.md](ui-conventions.md) ("order follows the task, and the task
  starts with _where_, not _what_"; "files are dropped onto the thing they apply
  to"), whose conflicts table notes that today's `+zone` repeats one design onto
  another surface _after_ loading it — a different data model, not a relabel.
- Turn the camera to the zone a design just bound to (maker ease-of-use review,
  2026-08-16, [findings report](findings/2026-08-16-maker-ease-review.md)): on
  the chair a fresh design binds to "Left side", which faces away from the
  default camera, so first sight of your artwork is an edge-on sliver, and
  switching zones rebuilds for ~3s and shows an unchanged grey chair. The
  coverage pill names the zone but nothing shows it; a first-timer who hasn't
  found orbit can't tell whether anything worked. Cheapest fix is a camera turn
  on bind. Surface-first picking (above) is the fuller answer, but this doesn't
  need to wait for it.
- Power-user tooling for repeat volunteers, all independently raised by the
  maker-workflow review (2026-08-02): undo/redo over color merges, base
  assignment, depth and placement; keyboard shortcuts (`Ctrl/Cmd+E` to
  export, at minimum); batch export across variants and printers (Standard/Kit
  × three printer profiles is six manual passes today); a project save/load
  file so one volunteer can hand a design to another, distinct from the
  session-autosave work already landing (that recovers _your_ session; this
  is for sharing a finished setup); and a way to edit the owned-filament
  palette (`public/filaments.json`) without a code-adjacent JSON edit.

## Give small salient features a fair share of the traced palette

The cartoon corpus source's three-tone eyes (white sclera, light blue iris, dark blue
pupil) quantize to one gray at the default 6 colors: k-means weighs pixel count, so two
slots go to yellow's shading tones while the eyes, tiny but the most looked-at region,
share one. 8 colors separates them fully. Pre-existing, unchanged by the 2026-08-24 floor
work ([findings](findings/2026-08-24-despeckle-floor-recalibration.md)). A fix would weight
clusters by something other than raw pixel count (edge adjacency, distinct-region count),
measured on the corpus with the `look` bench.
