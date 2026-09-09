# Build brief: a color-inlay tool for MakeGood's Toddler Mobility Trainer

You are building a tool from scratch. This file is the whole brief. It does not name a
language, framework, library, file layout or architecture. Those are yours to choose. Choose
whatever gets a volunteer to a good print, and write down why in `NOTES.md`.

## Background

MakeGood (makegood.design) publishes the Toddler Mobility Trainer, or TMT: a free, open-source,
3D-printable mobility device for children aged 1 to 8, distributed through 3d-mobility.org.
Volunteers with hobby printers build one for a specific child.

A TMT prints in one plain color. Families want theirs personalised: the child's name, a
favourite character, a zebra print on the wheels, a dinosaur across the side of the chair. Today
that takes a CAD tool and a few hours of mesh editing. The volunteers do not have that.

## What to build

A tool that takes a flat-color design and a TMT part, lets the volunteer place the design on
the part, and produces a print-ready multicolor 3MF project.

- Each color in the design becomes a recess cut into the part's surface.
- Each recess is pre-assigned to its own filament slot, so the file opens in the slicer with the
  colors already mapped and nothing left to paint.
- The base part prints in the body color, the recesses print in the design's colors, and the
  finished surface is flush.

It must open, ready to slice, in Bambu Studio, OrcaSlicer and Snapmaker Orca.

## Who uses it

This decides every workflow choice.

- Hobbyist printer owners, MakeGood volunteers, parents, educators. They run Bambu Studio or
  OrcaSlicer every week. They know what a filament slot is, what an AMS is, what layer height
  means.
- They have never opened Fusion 360 or Blender. They do not know what a mesh, a vertex or a UV
  is, and must not need to learn.
- Their multicolor capacity is scarce. Four slots per AMS unit is what most of them own. Every
  color that gets its own slot costs them something, so the tool has to help them get a design
  down to the slots they have.
- They speak the slicer's vocabulary: filament, slot, plate, prime tower, support, layer
  height. Use their words. Never explain a word they already own.

**The success measure:** a first-time volunteer, given a design file and a printer, reaches a
printable, correctly-colored 3MF without touching a 3D modeling tool. Any step that needs CAD
literacy is a bug in the tool, not a training gap in the volunteer.

It has to run on a volunteer's own computer (Windows or macOS) with no paid software, and a
volunteer must be able to start using it within five minutes of following a link or a download.
Nothing they load leaves their machine unless they choose to send it.

## The parts

Four parts of the TMT take designs. The printed pieces are provided as 3MF files in
`reference/parts/`, one piece per file, in millimeters. `reference/parts/parts.json` names them.

| Part           | Files                                                | Notes                                                                                                                                                                                                                                                                                              |
| -------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Wheel**      | `wheel-half.3mf`                                     | The outer half of the 280mm wheel. The design goes on the flat outer face. Each TMT has two wheels; the second is the mirror of the first, so one design usually wants a mirrored copy.                                                                                                             |
| **Hubcap**     | `wheel-hub-cap.3mf`, `hubcap-clips.3mf`              | A 3mm-thick disc with a 1mm angled edge, snapped onto the wheel by four clips. The clips are fixed geometry. The disc's diameter is the volunteer's choice: their bed size caps it, the clips set the minimum, and 280mm (the wheel) is the most it can ever be. A hubcap can also be cut to the design's own outline, so a character prints as its own silhouette. |
| **Footrest**   | `footrest.3mf`                                       | One flat design face.                                                                                                                                                                                                                                                                              |
| **Chair body** | the thirteen `chair-*.3mf` pieces                    | Printed in pieces and assembled. The files sit in the assembled-chair frame, so loaded together they form the chair. The caster mounts come in two versions, Standard and Kit; a build uses one pair, never both. The seat center is under the cushion and the two caster mounts are hidden, so those three pieces carry no design. |

The chair is the hard one. Its outer surfaces are curved, and each one spans more than one
printed piece: the left side, the right side, the back, the front, the two seat sides and the
two fenders. A design placed on the left side may cross the join between the handle, the
storage and the wheel mount pieces, and it has to line up across that join as well as the print
does. The volunteer should be able to draw for a surface without knowing which pieces it is
made of.

## Verified prints

`reference/verified-prints/` holds slicer project files whose plate layouts, part orientations
and per-part print settings were checked by a human on a real printer. `MANIFEST.md` there says
what each one is. Treat them as ground truth for how a part is meant to print: which way up it
goes, where on the plate, where the prime tower sits, which parts want support and which do not,
and the print settings MakeGood ships (filament type, infill, support). An export should
reproduce those choices, not re-derive them.

## Printers

| Printer                  | Plate           | Multicolor                                                                           |
| ------------------------ | --------------- | ------------------------------------------------------------------------------------ |
| Bambu X1C / P1S / A1     | 256 × 256mm     | 4 slots per AMS unit, up to 4 units                                                  |
| Bambu H2D                | 350 × 320mm     | 4 slots per unit, dual nozzle, up to 25 slots                                        |
| Snapmaker U1             | 270 × 270mm     | 4 toolheads, built in. A hard ceiling of 4: nothing chains                           |

## What it must do

1. **Load a design.** A flat-color SVG, or a PNG, JPG or WebP image. An image is reduced to flat
   colors and traced. A transparent background is not a color. Gradients and pattern fills in an
   SVG are not supported: say so, skip them, keep going.
2. **Pick a part**, and for the chair, a surface. Show the part in 3D with the design on it.
3. **Place the design**: move, scale, rotate, flip. On the 3D view directly, not only with
   sliders. Offer a sticker (place once) and a repeating fill (tile it across the surface, at a
   size the volunteer sets). Offer a mirrored copy for a paired surface.
4. **Set depth.** A default for every color, with a per-color override. A recess shallower than
   a layer is nothing, so the smallest depth that prints is the floor. A depth deeper than the
   part has material for is capped, and the volunteer is told. Real numbers, in millimeters,
   always.
5. **Group colors into filament slots.** Show every color found, how many slots that needs, and
   how many the chosen printer has. Merge near-identical colors automatically at a strength the
   volunteer can turn up or down. Let them merge or split colors by hand. Let them send any
   color to the body instead of cutting it. Never let a slot be spent on a color that cuts
   nothing.
6. **Give them a template.** A true-size SVG of the design surface, so they can draw over it in
   Inkscape or Affinity and load the result. Where the surface spans printed pieces, mark the
   joins.
7. **Export a 3MF project** for the chosen printer: every piece on a plate, oriented and placed
   as the verified prints have it, prime tower placed clear of the parts, each recess a named
   object assigned to its slot, the body assigned to its own slot, print settings matching the
   verified prints. It opens in Bambu Studio, OrcaSlicer and Snapmaker Orca with no repair
   prompt and nothing left to assign.
8. **Never drop anything silently.** If a color, a shape or a piece is left out of the export for
   any reason, name what was dropped and why, in the volunteer's words, with one thing they can
   do about it. If one color fails, the others still export.
9. **Say what was not verified.** A plate layout, a tower position or a hubcap size that no
   human checked on a real printer is exported with a warning that says so, not presented as
   safe.

## What it should do

- Restore the session after a reload, and ask before losing unsaved work.
- Handle a photograph, not only line art: fewer colors, less speckle, edges that stay smooth
  however large it prints. Give the volunteer a Colors slider and a Detail slider and show what
  each did.
- Warn when two designs overlap each other on the same surface.
- Warn when a design hangs off its surface, and cut only what is on it.
- Work at 900px window width and up. Phones are out of scope.

## Provided in this repository

| Path                          | What it is                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `reference/parts/`            | The printed pieces, one 3MF each, and `parts.json` naming them.                                                                   |
| `reference/verified-prints/`  | Human-checked slicer projects. `MANIFEST.md` describes each.                                                                     |
| `reference/artwork/`          | Test designs: four flat-color pattern SVGs sized in mm, the MakeGood logo as a transparent PNG, and whatever else the manifest lists. |
| `reference/filaments.json`    | A starter list of common filament colors with hex values, for naming a slot's filament.                                          |
| `reference/brand/`            | MakeGood's design tokens (colors, spacing, type) and logo. Use them so the tool looks like it belongs to MakeGood.               |
| `EVAL.md`                     | The acceptance scenarios the result is judged against. Read it before you start.                                                 |

## Deliverables

- The working tool, in this repository, at the root.
- `README.md`: how to run it on a clean machine, in under five minutes, for a volunteer.
- `NOTES.md`: the decisions you made and why, what is not done, known limitations, and any
  measurement a claim rests on. A number without the command that produced it is a guess.
- `evidence/`: the exported 3MF from every scenario in `EVAL.md` you got working, named by
  scenario, so a reviewer can open them in a slicer without running the tool.
- Whatever tests you think earn their place.

Work through `EVAL.md` in order. A scenario that works end to end beats three that are half
built. Commit as you go, with messages that say what changed.

## What this brief deliberately does not say

The language, the framework, the libraries, whether it is a web page or a desktop app, how the
geometry is done, how the 3MF is written, how the code is laid out. Pick, and explain the pick
in `NOTES.md`. Formats and standards are fair game to look up. Do not go looking for an existing
tool that does this job and copy it: the point of this exercise is what you build from the
brief.
