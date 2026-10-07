# Troubleshooting

One section per user-visible warning string.

## Troubleshooting: "Couldn't merge the shapes" / "Couldn't trim the overlap" warnings

The polygon maths failed on one colour's shape. The warning usually names the
colour. One form doesn't: the build merges the shapes painted over each region
in batches, and a batch holds whatever colours fell in it, so a failure there
names none. Read it as "somewhere in this design". There are two causes and the
warning doesn't guess between them: a **self-intersecting path** in the source
SVG (much the commoner), or sheer size, which Fill mostly refuses before it gets
here (below).

The app already tries to fix this: near-duplicate points are removed before the
maths runs (usually two curve segments meeting at a seam a fraction of a unit
apart), zero-width slivers are scrubbed from the results, and failures retry at
lower precision. If the warning still appears:

- **That region falls back to its uncut shape.** It still exports, but may
  overlap its neighbour slightly instead of having the overlap removed.
- **The real fix is at the source.** In Illustrator or Inkscape, select that
  colour's path and run **Path → Union**.
- Common causes: strokes converted to outlines (sharp mitre joins), leftover
  boolean results from the design tool, hand-edited paths with crossed segments.

**Size is rarely the cause.** The polygon library takes at most 500,000 edges
in one operation. Past that the app splits the work into pieces that each fit,
and in Fill mode a design too big even for that is turned away with "… is too
detailed to fill …" (below) instead of reaching here.

Two cases can still reach here on size:

- **One shape of more than 500,000 edges**, which no split can divide.
- **Very many crossing edges.** The library also stops once the pieces it is
  tracking pass a million, which crossings multiply. 500 strips each way reach
  it from 4,000 edges.

Each colour's own shapes are merged before any tiling, so a size failure there
names no fill. The tell is the same either way: failures arrive per-part in a
batch rather than on one colour, and the model carries visibly _less_ geometry
than it should, so parts of the design come out blank. Simplify the design
(fewer, larger shapes). Limits and how they were found:
[2026-09-24 tile-union cap](findings/2026-09-24-tile-union-cap.md).

**One "Couldn't trim the overlap" is not about a colour.** It names `the hidden
surface on "<zone id>"` (`left`, `seat-left`, …): the chair's artwork clip
failing to have the assembled-over surface subtracted, in
`ConformalZoneMapper.boundary()`. Nothing is lost. The clip is kept
unsubtracted, so artwork cuts where it would have been trimmed, costing filament
changes on surface nobody sees once the chair is together. The hatch in the 3D
view and on the template still shows what should have been trimmed.

## Troubleshooting: "Could not load the Manifold engine, so assembly cutting is unavailable"

Full text: _"Could not load the Manifold engine, so assembly cutting is
unavailable. "_ — followed by the browser's own error.

Assembly mode's whole cutting pipeline — clipping colors to a face, cutting
pockets, building inlays — runs on Manifold, a WebAssembly boolean engine
loaded once per session, the first time a rebuild needs it. This fires when
that load itself fails, before any part-specific work starts.

**What it means.** The engine didn't load: an interrupted or blocked network
fetch, a browser or extension blocking WebAssembly, or an unsupported browser.
The appended text is the browser's own error, and is the detail worth reading.

**What you get.** The rebuild stops and returns nothing: the viewport falls back
to the parts as loaded, uncut. No colors cut in and nothing exports usable
geometry until a rebuild manages to load the engine.

**What to do.** Reload the page — a slow or interrupted first load is the
common cause. If it keeps happening, note the appended error text and report
it via **Feedback** or **Report a bug on GitHub**.

## Troubleshooting: "Couldn't cut color … into …" warnings (assembly mode)

Assembly mode clips each colour's region to the part's face, then extrudes it
into a 3D pocket. Dense line-work can come out of that clip touching itself at a
point: valid to the 2D maths, not a sealed solid to the 3D engine. The app
repairs it automatically via Manifold's own 2D boolean engine, shrinking the
region by a hair to break the exact-touching topology, and retries: 0.01mm,
then 0.05mm away from the part's edge. The chair's curved zones get the same
repair as a flat part. If the warning survives, that pocket was skipped, and
the same source fix as above usually resolves it.

**How much of the colour you lose depends on the colour.** The warning is raised
per region, not per colour, and the build carries on with the rest. A colour
split across two depths keeps the slice that did extrude, so it can come out
partly cut. That is why the warning names no outcome: check the part in the
preview rather than assuming the colour is gone.

**The 3D pass can also fail later.** Each failure degrades to something a slicer
can print rather than a broken file, and the warning says which outcome you got.
Two of them mean the part carries less artwork than you designed:

| Warning                                                                                                 | What you get                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Couldn't merge color … on …"                                                                           | That one colour is dropped from that part. Every other colour cuts normally.                                                                                                    |
| "Couldn't merge the recesses on …", or "Couldn't cut the recesses into …"                               | That part ships with **no artwork at all**. Still printable, just blank, so don't print it expecting the design.                                                                |
| "Couldn't fit the inlay for color …. Its pocket is cut into the body but will print as an empty recess" | The recess is cut but nothing fills it, so that colour prints as a bare cavity.                                                                                                 |
| "Part … has no geometry to export. Its pocket cut went all the way through …"                           | The cut succeeded but left nothing: a pocket reached the part's wall thickness and went clean through. The part is dropped from the export rather than shipping a hollow shell. |

These are 3D failures, not the 2D clip problem above, so path-cleaning is less
reliably the fix. Suspect the part mesh and the fine detail landing on it. They
are not silent: before this handling, the same failures either blanked the
viewport or shipped an uncut body alongside inlays occupying the same space,
which a slicer resolves arbitrarily.

## Troubleshooting: "Clipping color region to the design face failed…" (assembly mode)

Full text: _"Clipping color region to the design face failed for …. Region
left unclipped, may extend past the face edge."_

**What it means.** Before a color's shapes are cut into a part, assembly mode
clips them to the part's design face — the same 2D polygon math behind
"Couldn't merge the shapes" and "Couldn't cut color … into …" above, one step
earlier. When that clip fails (dense or self-touching line-work is the usual
cause), the region is used unclipped rather than dropped.

**What you get.** The region isn't dropped, but isn't proven to stay inside the
face: it may reach past the edge into space the part doesn't have. An unclipped
region is treated as reaching the part's outer edge, so it can be cut all the
way through instead of recessed to its usual depth — see "… reaches the part's
outer edge…" further down. Everything else on the part is unaffected.

**What to do.** Same fix as the other clip failures: simplify that color's
source path (Illustrator/Inkscape's Path → Union), or nudge Scale. Check the
part in the 3D preview afterward — the warning doesn't say which outcome you
got.

## Troubleshooting: "detected face normal … isn't vertical" warnings (assembly mode)

Full text: _"Part "…": detected face normal (…) isn't vertical. Assembly
cutting assumes a horizontal face. Pick a different face or the cut may be
wrong."_

**What it means.** A part with no baked design zones is cut on the "flat"
path, which assumes its chosen design face points straight up and measures
every cut depth straight down from it. The numbers in parentheses are that
face's measured normal vector; anything under 0.9 in the vertical component
trips this.

**What to do.** If the part offers more than one face — behind the
"Advanced: per-part face & alignment" disclosure — pick a different one. If
it doesn't, or the flagged face is the one you want, check the part in the 3D
preview and in your slicer before printing: the cut is attempted, not
guaranteed correct.

**Why it's rare.** Every shipped part's default face is horizontal. On a face
pointing sideways the placement frame is drawn on that face in amber: the design
doesn't land on it. The
[findings report](findings/2026-08-24-placement-frame-angle.md) lists which of
the library's other face choices land here.

## Troubleshooting: "isn't a watertight mesh" warnings (assembly mode)

Full text: _"Part "Top" isn't a watertight mesh, so it can't be cut cleanly.
Repair it (close holes, fix flipped faces) and retry. Exporting it uncut for
now."_

**This fails earlier than the cut warnings above.** Those happen when a clipped
_region_ comes out non-watertight. This fires when the part's own base mesh,
before any cutting, fails Manifold's watertight check: an open edge, a flipped
face, or some other non-manifold defect.

**What you get.** That part exports uncut: its full, unmodified shape, with no
colour recesses or inlays. Every other part still cuts and exports normally —
this failure is per-part, not per-build.

**What to do.** You can't fix this from the app; there is no mesh-repair tool.
Every part comes from the built-in library (the free-form mesh upload path was
removed — see [tech-debt.md](tech-debt.md), "The custom-mesh upload path was
removed, and took a placement guard with it"), so a shipped part failing this
check is a packaging defect, not something your artwork caused. Report it via
**Feedback** or **Report a bug on GitHub**, naming the part.

## Troubleshooting: "Couldn't load this part. Reload the page to try again."

Full text: _"Couldn't load this part. Reload the page to try again."_

Shown two ways for the same cause: as a banner in the part panel once the parts
library manifest has settled, or as a dialog if you click **Load full
assembly** while it's still unreachable.

Both mean the manifest (`stl/parts.json`) never loaded, or loaded without an
entry the selected assembly kind's roles need. It is a **broken deployment**,
not a mistake you made. The app once offered a mesh-drop fallback, removed
because it can't check an arbitrary mesh is the part it claims to be, and every
verified export placement is baked against the shipped one (see the
`PlacementReason` comment in [src/export/placement.ts](../src/export/placement.ts)).

**What to do.** Reload the page — a flaky connection on first load is the
common case. If it keeps happening, report it via **Feedback** or **Report a
bug on GitHub**; there is nothing to fix on your end.

## Troubleshooting: "Not a valid 3MF: missing 3D/3dmodel.model"

Full text: _"Not a valid 3MF: missing 3D/3dmodel.model"_

You see it wrapped inside a load failure that names the part and file, for
example `Could not load library part "Footrest" from stl/footrest.3mf: Not a
valid 3MF: missing 3D/3dmodel.model`.

The app's 3MF reader expects a zip archive containing `3D/3dmodel.model`, the
XML file every 3MF must have. This fires when the fetched file isn't that: a
corrupted or truncated download, or a file at that path that isn't a 3MF (a
renamed STL, a differently-packaged zip).

Every part comes from the app's own library over a normal fetch; you can't hand
it a bad file. So like "Couldn't load this part", this is a one-off network
hiccup or a broken deployment, not something your artwork or settings caused.

**What to do.** Reload the page. If it recurs on the same part, report it via
**Feedback** or **Report a bug on GitHub**, naming the part.

## Troubleshooting: "… is a sticker now. The … can't repeat a design across it yet."

Full text: _"…" is a sticker now. The … can't repeat a design across it yet._
Or: _"…" is a sticker now. Cut to artwork shape can't repeat a design across the
shape it cut._ Two designs rewritten at once give you one of these each, not a
combined line.

**What it means.** You had a design set to **Fill** and moved it somewhere Fill
isn't offered. Two things do that: picking the chair body, which doesn't offer
Fill at all, and ticking **Cut to artwork shape** on the hubcap, which would
tile a shape with copies of itself. The message names which. The mode is
rewritten to **Sticker** rather than carried across, and this says so, because
the Sticker/Fill control isn't on screen to show it changed.

**What you get.** Each named design is placed once instead of repeated. Its
zone, scale, offset, rotation and colors are untouched.

**What to do.** Nothing, if one copy is what you wanted. To repeat the design,
scale it up and place copies by hand with "+zone", or use a part that offers
Fill. Fill on the chair is withheld on purpose — it took 93.6s to settle on a
single zone and dropped a color on one piece. See [tech-debt.md](tech-debt.md).

The message clears itself when you're back somewhere Fill works, but the mode
doesn't come back with it. Set it again from the row's Sticker/Fill control.

## Troubleshooting: "… has detail on "…" too fine to print"

Full text: _"\"…\" has detail on \"…\" too fine to print, so it wasn't cut. A
recess needs to be about 0.4 mm across to hold a bead."_

**What it means.** Something in that color on that part is smaller than the
printer's nozzle. Nothing that small can hold a single bead, so it is dropped
instead of cut, and this names the color and the part so nothing goes in
silence. One pill per color and part, however many scraps went.

Two things make them. Your design can simply be that fine. Or trimming can leave
a scrap: a design is trimmed to the part it sits on, to the piece of it a seam
gives that part, and to one half when Mirror is on. The message doesn't guess
which, or say how much went or what survived: the fix is the same either way,
and several trims can each drop something.

**What you get.** Everything else in that color is cut normally. Only the
scraps go.

**What to do.** Usually nothing. Two cases are worth a look:

- **A design far smaller than the part.** A design scaled down past about
  0.4 mm has nothing left to cut. Raise Scale.
- **A design running off the edge of a piece.** The part that hangs over is
  trimmed away, and what's left along the edge can be a hair. Move it in, or
  scale it down so it sits inside the piece.

If the color vanished from the part entirely, the build says that separately.

## Troubleshooting: "Couldn't load the design zones for "…"…"

Full text: _"Couldn't load the design zones for "…" (…: …). It will load
without design zones."_

**What it means.** Some parts carry design zones baked separately from their
mesh: a sidecar file loaded alongside the geometry (chair-body is the only
shipped part with one). This fires when the sidecar can't be fetched at all — a
network hiccup, or a broken deployment missing the file.

**What you get.** The part still loads and displays normally, without its baked
design zones. It falls back to the implicit flat zone every part has, so it can
still take a Sticker or Fill design on its largest flat face, just not the
per-surface zones.

**What to do.** Reload the page — a one-off network failure is the common
case. If it recurs, report it via **Feedback** or **Report a bug on
GitHub**, naming the part; a shipped sidecar failing on every attempt is a
packaging defect, not something you did.

## Troubleshooting: "…doesn't match the mesh its design zones were baked against"

Full text: _"Part "…" doesn't match the mesh its design zones were baked
against, so its design zones are unavailable. Re-run the zone bake for this
part."_

**What it means.** A part's design zones are baked against one specific mesh —
the same kind of fingerprint check "has no verified print placement" further
down uses for plate position, applied to zones. This fires when the loaded mesh
doesn't match, usually because it was re-packed after the bake without re-running
it.

**What you get.** The same fallback as the message above: the part loads with
no design zones and takes artwork only on its implicit flat zone.

**What to do.** This is a packaging defect on a shipped part, not fixable from
the app. Maintainers: re-run the zone bake (the `bake-zones` skill) after any
re-pack. Volunteers: report it via **Feedback** or **Report a bug on GitHub**,
naming the part.

## Troubleshooting: "Design zone "…" couldn't be applied to "…""

Full text: _"Design zone "…" couldn't be applied to "…": …"_

**What it means.** Even once a part's zone sidecar loads and its mesh
fingerprint checks out, each zone still has to be rebuilt against the part's
actual vertices. This fires when that fails for one zone — a defect in its
stored chart data, or a mismatch narrower than the whole-mesh fingerprint check
above catches.

**What you get.** Only that zone is left off the part; every other zone still
loads and takes artwork normally.

**What to do.** Same as the two messages above: a packaging defect, not fixable
from the app. Report it via **Feedback** or **Report a bug on GitHub**, naming
the part and the zone.

## Troubleshooting: "N filament slots needed, but … tops out at M" warnings

The design needs more filament slots than the printer can address in one print.
The count is one per cut colour or merged group, plus one for the body, and it
matches the line under the colour list.

**This is not a geometry problem.** The 3MF is correct and still exports; it
just can't print in one pass on that machine.

Your printer decides whether this is reachable at all. Every AMS or toolchanger
unit holds 4 slots, but the Bambus chain: up to 16 on the X1C, P1S and A1, and
25 on an H2D (24 across chained units plus an external spool on its second
nozzle). The Snapmaker U1's 4 built-in toolheads don't chain, so there this
warning appears the moment a design needs a fifth slot. Past one unit but within
the printer's maximum you get a quieter note instead, saying the design prints
across more units.

To get the count down:

- **Merge two colours.** Drag one colour row onto another, or use that row's
  "Merge with…" dropdown. The group prints in the group's main color.
- **Print a colour in the body.** "→ base" on a row moves it out of the cut
  colours, so it stops costing a slot.
- **Auto-merge** raises the similarity threshold, which may or may not help: it
  merges colours that look alike rather than hitting a target count. On the one
  real 7-colour volunteer SVG measured so far, only `Strong` moved the count,
  and only by one. See [tech-debt.md](tech-debt.md), "Auto-merge is a similarity
  control".

Exporting anyway is supported, and sometimes what you want: a single-AMS owner
can print the file with manual filament swaps at the slicer's colour-change
pauses.

## Troubleshooting: "Designs … overlap" warnings

Two designs in one place are cut independently. The body takes the union of
their pockets and looks right in the preview, but each colour's inlay is only
where the part and that colour's pocket overlap. So where two designs of
_different_ colours cross, the file carries two inlay solids in the same space
and the slicer picks between them however it likes. Invisible until the file is
opened.

The warning names both designs by filename ("Two placements of …" when they are
two copies of one file). Any of these clears it:

- **Move one.** Drag it on the face, or use Offset X/Y. The warning clears once
  they cover less than a tenth of each other.
- **Scale one down** so it fits a gap in the other.
- **Put them on different zones**, on a part that has more than one.
- **Remove one** with the × on its row.

A little overlap is deliberately not flagged: designs placed side by side
routinely share a millimetre or two of empty bounding box.

**It can still warn about designs that don't quite touch.** The check starts
from each design's bounding box, then asks how much of each one's artwork
reaches the box they share. A logo centred in a frame's empty middle no longer
warns. Two designs whose artwork both reach the shared box without crossing
still do: a false alarm, and the file is safe to print.

**Two designs both set to Fill always warn**, with their own message: a fill
repeats across everything it covers, so the second lands on the first
everywhere. Moving or rescaling can't clear it. Switch one to Sticker, move it
elsewhere, or remove it.

A fill _under_ a sticker is not flagged: a pattern background with a design on
top is a real workflow. The fill is cut back from under the sticker's colours,
so the two never share space in the export.

## Troubleshooting: "Couldn't fit … of … around the design on top of it on …"

Full text: _"Couldn't fit "…" of "…" around the design on top of it on "…".
Where they meet, both print in the same space. Move the design on top
slightly."_

**What it means.** A Fill is cut back from under every Sticker on the same
part, so the sticker shows through cleanly. For this fill colour on this part,
that trim failed. The colour is kept whole, so where it lies under the sticker
the export carries two inlays in the same space, and the slicer picks between
them. Every other colour and part is unaffected.

**What to do.** Move the design on top a millimetre and let it rebuild: the
trim fails on exact coordinates, and a new position usually clears it. If it
keeps failing, please report it via **Feedback** or **Report a bug on
GitHub**.

## Troubleshooting: "… is hidden everywhere by the designs on top of it, so it isn't cut" notice

Full text: _""…" is hidden everywhere by the designs on top of it, so it isn't
cut."_

**This is not a warning.** A Fill is cut back from under every Sticker on its
part. This colour of the fill only appears where stickers cover it, on every
part, so none of it is left to cut. It takes no filament slot. Move or shrink
the sticker if you want the colour to show.

## Troubleshooting: "… crosses the centre line of …" notice (assembly mode)

Full text: _""…" crosses the centre line of "…". Its … half is kept and mirrored
onto the …."_

A design bound to a zone with no twin (the chair's front and back panels)
mirrors across its own centre line instead of onto a paired zone. Ticking
Mirror on such a row keeps whichever half your design's placed centre lands on
and reflects it onto the other. If your design crosses that centre line, the
crossing part is cropped off before it's mirrored; this notice says which half
survived.

**This is not a warning.** Both halves still print; the design is just cropped
to one half before it repeats. To keep the whole design, move it entirely to one
side of the centre line (drawn dashed on the zone's template).

## Troubleshooting: "Couldn't crop … to its half of …" warnings (assembly mode)

Full text: _"Couldn't crop "…" to its half of "…". It and its mirror image
both print in full. Untick Mirror on that design."_

The same half clip as the notice above, except it couldn't be applied. Two
causes, both rare:

- The polygon clipper failed on this design's regions, the same way the
  ["Clipping color region to the design face failed…"](#troubleshooting-clipping-color-region-to-the-design-face-failed-assembly-mode)
  warning can.
- The zone has no centre line to clip at (a chart with no extent), which no
  shipped bake produces.

Either way the design and its reflection are both cut whole, so where they
cross the centre line the export carries two inlays claiming the same space, the
same problem the ["Designs … overlap"](#troubleshooting-designs--overlap-warnings)
warning describes. Untick Mirror on that row and the design cuts once, as
placed. Simplifying the design in Illustrator or Inkscape can clear the clipper
failure, after which Mirror can go back on.

## Troubleshooting: Fill warnings, "You have one tile instead"

Fill repeats one design across a whole part. When it can't work out how, it
places the design once and says why. The first reason below is fixed by changing
Scale and the second sometimes is, which its own message says. The last two mean
a bug rather than a problem with your design.

### "… is too small to fill …: it would take more than 1024 tiles."

The commonest one. A pattern scaled far down against a large part (5% on a chair
panel) needs tens of thousands of copies, which would hang the tab, so the app
refuses instead of freezing.

**Raise Scale** until the count comes down. A larger tile is usually what you
wanted anyway: a pattern at 5% reads as texture, not as a pattern.

### "… is too detailed to fill …"

**"Repeating its busiest color means merging 529 tiles of 1201 points each."**
The tile count is fine; the points inside it are not. Two limits say this:

- **Past 600,000 points** (tiles times points) the app refuses. On the one
  part measured the cut ran out of memory at 720,000, and the part exported
  with no artwork at all.
- **A colour whose tiles join into one shape of more than 500,000 edges**, such
  as a background that runs through every tile. The polygon maths can't take it
  in one piece. This one is found while tiling, so the product can be under
  600,000 and it still appears.

The points figure is per tile and for one colour, the busiest one.

**Raise Scale.** Fewer, larger tiles multiply out to fewer points, and the
message says so whenever that can work.

**When it says "at any Scale", it cannot.** The app checks the grid your design
would need with Scale wound to its maximum. When that is still over the limit the
message drops the Scale advice and asks you to simplify the design instead: fewer
nodes and fewer shapes in Illustrator or Inkscape. Placing it as a Sticker also
works, at the cost of the repeat.

Either way nothing is dropped: the whole design is placed once. Numbers and the
sweeps behind them:
[2026-09-24 tile-union cap](findings/2026-09-24-tile-union-cap.md).

### "… measures zero in one direction, so there is no tile to repeat across …"

The drawing has no extent one way (every filled shape sits on a single line) in
a file that also declares no usable `viewBox` to fall back on. A missing or zero
`viewBox` alone does _not_ cause this; the app then measures the tile from the
artwork's own bounding box.

**Use a design with both width and height.** Such a file would cut nothing
either way, so it isn't printable as it stands.

### "The placement … has collapsed to no width or no height."

The placement maps the whole tile onto a line or a point, so there is no grid to
lay. A placement problem, not a file problem. **Use "Reset to auto-fit"** in the
Artwork fit panel.

### "… curves too much for … to tile evenly across it."

The part's surface isn't flat enough for a repeating grid to stay a grid, so
copies would land in the wrong places rather than slightly off. No shipped part
does this today. **Place separate designs on it** in Sticker mode instead.

### "Couldn't measure the area to fill on … so … can't be tiled across it"

The part's design area measured as having no width or no height, so there is
nothing for tiles to cover. Nothing about your design causes this: the part's
geometry reached the fill path in a state it shouldn't. **A bug; please report
it**, naming the part.

### "… for a reason the app didn't record"

A refusal reached you without naming itself. A bug in the app, not your design.
Please report it.

## Troubleshooting: "Depth for … is … thinner than the usual 0.20 mm print layer"

A quiet note, not an error. The recess is cut exactly as deep as you asked,
nothing clamped and nothing dropped, but it is shallower than one layer at the
default 0.2 mm layer height. On a standard profile the slicer has no layer to
put it in, so it prints as bare body.

- **On a finer layer height** (0.08-0.12 mm is common for detail work) this is
  fine and the recess will print. The note can't read your slicer settings.
- **On a standard 0.2 mm profile**, raise the depth to at least 0.2 mm or the
  colour won't appear.
- Exactly 0 or less is a different case: it cuts nothing at any profile, so it
  is raised to 0.2 mm and warns rather than being noted.
- **It won't appear for a colour that only lands on a cut-through part** (the
  wheel's cap), which ignores the depth setting and holes the whole way
  through: the recess prints at any layer height, so the note would predict a
  problem that can't happen. If the same colour is also on a part that cuts to
  depth, the note appears, and it is about that part.

## Troubleshooting: "… is not a depth that can cut" warnings

Zero or less cuts no pocket at all, and says nothing about what was wanted. Both
modes raise it to 0.20 mm, one typical layer, naming every colour they raised
and both numbers. In assembly mode this used to drop the colour silently: no
recess, no inlay, no message.

- **Nothing is dropped.** The colour cuts, just shallowly. That matters: a
  colour cut nowhere gets no row in the colour list, which would remove the very
  depth field this warning tells you to correct.
- **The number is the setting it raised, not what each part cut.** What a part
  does with a depth is up to the part; the wheel's cap holes through whatever
  you set, so no single number is true of every part.
- To remove the colour, use "→ base" on its row. To cut it, give it a real
  depth.
- One warning, naming every colour it raised, however many parts they sit on. A
  global **Depth** of 0 raises every row and still says it once. It opens
  `Depth for` with one colour and `Depths for` with several.
- Two warnings only when two different depths were asked for: 0 on one row and
  -1 on another are separate facts, and each names its own colours.
- **The deep end is checked separately**, against the part and the wall under
  each colour. See "… deeper than "Wheel top" goes" and "… mm thick under it"
  below. On the chair body only the wall is checked.

## Troubleshooting: "TMT Mosaic couldn't save this session. Leaving now loses it" warnings

The app autosaves your session (design, placement, colours, depths) to browser
storage after every change and offers it back next time. Reloading normally
shows nothing; the browser's "leave site?" prompt appears only when that
autosave failed.

The browser controls the prompt's wording and usually substitutes its own
generic copy, so what you see may not match the string above.

- **The session isn't lost yet, but leaving now would lose it.** Export a 3MF
  before closing the tab.
- Common causes: the session grew past the app's size ceiling (a lot of large
  SVG artwork), the browser's storage quota for this site is full, or you are in
  a private window where storage is disabled.
- Free space (close other tabs on this site, clear old site data) and reload.
  The autosave runs again on the next change.

## Troubleshooting: "Some detail in … was too fine to print…"

Full text: _"Some detail in "yourfile.png" was too fine to print and was merged
into its surroundings. Lower Colors, or lower Detail, for a cleaner result."_

**An informational notice, not a failure.** The image loaded and cut normally.

Tracing produced more separate regions than `MAX_COMPONENTS`
([trace.ts](../src/raster/trace.ts)) allows, so the speckle floor was raised and
the image re-traced, as many times as it took to come in under the cap. Without
that cap a busy photograph hands thousands of speckle islands downstream and
freezes the tab for tens of seconds (cost measured in
[tech-debt.md](tech-debt.md)).

Features below the new floor were absorbed into whichever colour surrounds them.
Nothing is left as a hole and the regions still tile the image exactly, but fine
texture is gone. That is usually right anyway: detail near that size is below
what a 0.4mm nozzle can express.

A colour whose every piece was under the floor is gone from the colour list too,
and the notice names it: **"…merged into its surroundings, including 1 color."**
Raising Detail may not bring it back: the cap raises the floor again. On the
test image Detail 90 and 100 both end on the same floor
(`npx vitest run tests/raster-parse.test.ts -t "leaves a capped"`). The color-dropped notice below never shows beside this one.

The notice names the image, so each loaded image gets its own, and re-tracing
one at a setting that no longer needs capping retracts only that one.

To get a result you are happier with:

- **Lower Colors.** Usually the real fix. Fewer palette entries means fewer
  boundaries and far fewer islands; a photo at 4 colours prints much better than
  the same photo at 12.
- **Lower Detail.** It runs the opposite way to what the name suggests: it sets
  how small a speck survives, so _lowering_ it raises the floor and merges the
  fine stuff deliberately. Raising Detail quarters the floor and makes this
  notice more likely, up to the point where a nozzle width takes over: on a part,
  the floor never goes below what the design's placed size can print, and Detail
  doesn't move that half.
- **Crop or simplify the source.** A busy background the design doesn't need is
  what usually blows the budget.

## Troubleshooting: "… colors in … were dropped…"

Full text: _"3 colors in "yourfile.png" were dropped. Raise Detail to keep
more."_

One color reads in the singular: **"1 color in "yourfile.png" was dropped."**

**An informational notice, not a failure.** The image loaded and cut normally.

The Colors slider asks the quantizer for a number of colors. Tracing keeps only
the ones that still paint something once the despeckle floor has run
([parse.ts](../src/raster/parse.ts)); a color whose every piece sits under that
floor leaves the palette. The readout used to show the smaller number with
nothing saying it differed from what was asked for.

- **Raise Detail.** It sets how small a speck survives, so raising it lowers
  the floor and lets smaller pieces back through. The floor scales 4x at
  Detail 0 down to 1/4 at Detail 100, so 16x across the slider, and less
  wherever a placement's own floor is already close. That is the opposite of
  what "Some detail … was too fine to print…" above asks for, and the two never
  show on the same image: a capped trace keeps that notice, which names the
  color itself.
- **It doesn't say the pieces were unprintable, because usually they weren't.**
  With a placement, the floor that normally binds is the smallest feature flat
  art keeps: a 1.6mm square, four nozzle widths (`DESPECKLE_FEATURE_MM`). At
  512px across 185mm that is 20px², under the fractional floor's 39. With no
  placement it is that fraction. Neither is a nozzle width; where the nozzle
  floor does bind, the notice below replaces this one.
- **The count is against the colors that labelled pixels, not the slider.** An
  image with fewer colors than Colors asks for (a three-color logo at Colors 8)
  has lost nothing and never raises this. Neither does a color that won a
  cluster and then labelled no pixel, which the blur before clustering can
  produce: nothing of it was traced, so nothing comes back.
- **Detail already at 100 gets its own notice**, "… too small to trace, even at
  full Detail" below. There is no raising left.

## Troubleshooting: "… too small to print at this size…"

Full text: _"1 color in "yourfile.png" was too small to print at this size.
Make the design or the part bigger to keep more."_

**An informational notice, not a failure.** The image loaded and cut normally.

- **The design is placed small enough that the nozzle width sets the floor.**
  Nothing under one nozzle square (0.4mm across) can hold a bead, and Detail
  never scales that floor. At 128px across 12.8mm it is 16px², against a
  fractional 2, and the color goes at every Detail. Measured by
  `npx vitest run tests/raster-parse.test.ts -t "placement pins"`.
- **Make the design or the part bigger.** Scale, the hubcap diameter or the
  Design radius all work. The image is traced again about half a second after
  you stop, so the color can come back without touching Colors or Detail.
- **It says "keep more", not "get it back".** A bigger size lowers the floor,
  but a color's pieces can still be under the new one.

## Troubleshooting: "… Its pieces are too small to trace, even at full Detail. …"

Full text: _"1 color in "yourfile.png" was dropped. Its pieces are too small to
trace, even at full Detail. To keep it, use an image where that color covers
bigger areas."_

More than one reads in the plural: **"Their pieces are too small to trace, even
at full Detail. To keep them, use an image where those colors cover bigger
areas."**

**An informational notice, not a failure.** The image loaded and cut normally.

- **Raising Detail no longer lowers the floor.** Detail is at 100, or
  close enough to it that the floor rounds to the same size. The placement isn't
  what holds the floor up either, so the size notice above doesn't apply.
  Measured by `npx vitest run tests/raster-parse.test.ts -t "DETAIL_MAX"`.
- **The fix is a different image.** Use one where that color covers bigger
  areas. A bigger design can still lower the floor on flat art, but nothing
  measured says when it is enough, so the notice does not promise it.
- **Where it shows on the sample images**: 4 of 190 traces, all pattern-cow and
  pattern-zebra at Detail 100
  (`node_modules/.bin/vite-node scripts/bench-raster.ts dropped`, needs the
  gitignored `stubs/`). That bench samples Detail 50 and 100 only.

## Troubleshooting: "No opaque pixels were found in this image…"

Full text: _"No opaque pixels were found in this image. There is nothing to
cut."_

The image decoded fine, but every pixel fell below the alpha threshold the
quantizer uses to tell artwork from background. The load fails as a no-op:
whatever design was already loaded stays exactly as it was.

- **A fully transparent PNG.** Nothing was ever drawn on it, or every layer
  that was got flattened out before export.
- **A background that reads as "empty" to the app but not to your eyes.** A
  checkerboard baked into the pixels by an export preview, rather than real
  alpha, still counts as opaque background — see "This image has no transparent
  background…" under the hubcap section for the same distinction on a related
  path.

**What to do.** Re-export the image with a real transparent background (most
editors call it "export with alpha" or "transparent canvas"), and confirm
something is actually drawn on it before re-loading.

## Troubleshooting: "No color regions survived tracing …"

Full text: _"No color regions survived tracing "yourfile.png". Try raising
Detail, or use a less noisy image."_

The image had opaque pixels — it is not the case above — but after despeckling,
every traced region was smaller than the despeckle floor, so nothing survived
to build shapes from. Like the previous message, the load fails as a no-op and
whatever was already loaded is untouched.

This is the far end of "Some detail … was too fine to print…" above: that
notice means _most_ of the image survived and a little texture was merged away;
this error means the despeckle floor ate the whole image, usually because it is
uniformly noisy (a busy photograph, heavy film grain, a scan with visible
dither) rather than made of a few solid-coloured regions.

If the design's placed size, not noise, is what emptied it, the app shows
"Nothing … is big enough to print at this size" instead — see the next
section. Raising Detail can't help there, so it isn't offered.

**What to do**, in order of how much it usually helps:

- **Raise Detail.** This lowers the despeckle floor (see the Detail note under
  "Some detail … was too fine to print…" for why the name reads backwards), so
  smaller regions are allowed to survive.
- **Lower Colors.** Fewer palette entries means fewer, larger regions per
  colour, which is more likely to clear the floor.
- **Use a less noisy image**, or crop to the part that has distinct colour
  blocks. A photograph with soft gradients everywhere and no flat areas will
  keep failing here regardless of these settings.

## Troubleshooting: "Nothing in … is big enough to print at this size"

Full text: _"Nothing in "yourfile.png" is big enough to print at this size.
Make the design or the part bigger."_

Like the previous message, every traced region was smaller than the despeckle
floor and nothing survived. The difference is what raising Detail would buy,
which the app measures rather than guesses: it re-derives the floor this image
would get at full Detail. This message needs both halves of that answer — the
floor at full Detail is no lower than the one the trace ran under, **and** the
placed size is what holds it above the noise floor. Where Detail still moves
the floor at all, even a little, the previous message is shown instead.

The nozzle-width floor ([`printableFloorPx`](../src/raster/stats.ts)) is the
half Detail never scales, on purpose. A nozzle floor merely level with the noise
floor counts: full Detail quarters the noise half and the nozzle half stays put,
so the placed size is all that is left.

- **Make the design bigger.** Scale it up on the part, or place it on a
  larger design zone if the part offers more than one.
- **Make the part bigger**, if the shape allows it (a larger disc or plate).
- A photograph or a very small logo placed very small is the usual trigger:
  the same image loads fine at a larger size or on a bigger part.

## Troubleshooting: "This image could not be decoded…"

Full text: _"This image could not be decoded. The browser cannot read this
format, or the file is damaged. PNG, JPG and WebP always work; TIFF never
does. Re-export it as a PNG."_

The file was recognised as an image from its leading bytes, but the browser's
decoder refused it. The app carries no decoders of its own, so the supported set
is whatever your browser supports.

- **PNG, JPG and WebP** work everywhere.
- **GIF and BMP** work in practice, and are accepted for that reason.
- **TIFF** is never decodable in a browser. Re-export as PNG.
- A truncated or part-downloaded file lands here too. Re-download before
  blaming the format.

An SVG never reaches this message: format is sniffed from the first bytes, so
vector artwork goes to the SVG parser. That split is what stops a dropped image
failing with "SVG could not be parsed. Check the file is valid XML", true but
useless about a file that was never XML.

## Troubleshooting: "This image has no real-world size…"

Full text: _"This image has no real-world size, so it was auto-fit to the part
face. Use Scale to fine-tune."_

**Expected on every raster image, and safe to ignore unless the size is wrong.**
A PNG or JPG carries no trustworthy physical size: the DPI tags in consumer
files are almost always a meaningless 72 or 96, and honouring one would size a
phone photo at over a metre. The image is fitted to the part's design face and
`Scale` adjusts from there.

The SVG counterpart ("This SVG has no size in millimeters…") asks you to set the
document size in millimetres, which is impossible for an image; hence two
messages. An image can't be given an exact real-world size on load. Use the Part
section's design template to check the fit, and `Scale`/`Offset` to place it.

## Troubleshooting: "SVG could not be parsed. Check the file is valid XML."

Full text: _"SVG could not be parsed. Check the file is valid XML."_

**What it means.** The browser's own XML parser rejected the file before the
app looked at its shapes: an unclosed tag, an unescaped `&`, mismatched quotes,
or a file that isn't XML despite the `.svg` extension.

**What to do.** Open the file in a text or code editor and look for broken
markup, or re-export it from the tool that made it — a normal SVG export rarely
produces broken XML, so a hand-edited file is the likelier cause.

As "This image could not be decoded…" above notes, format is decided from the
file's own bytes, not its extension, so a non-SVG file renamed to `.svg` lands
here too: check the file really is SVG XML if this message makes no sense for
what you dropped in.

## Troubleshooting: "Shape … has a gradient/pattern fill…" warnings

Full text: _"Shape … (a <…>) has a gradient/pattern fill (not a flat color),
so it was skipped."_

**What it means.** The app only works in flat colors — that's what becomes a
printable region — so it can't trace an element filled with a gradient or a
pattern. Rather than guess at an average color, that shape is left out. A
gradient set on a group fills every shape in it that has no fill of its own,
so each of those shapes is named.

**What you get.** Only that shape is skipped. The number in the message counts
every shape element in document order — hidden ones and clip-mask ones
included — so counting down from the top of the file's XML/code view finds the
shape. Everything else loads and cuts normally.

**What to do.** In your editor, flatten the gradient or pattern to a single
flat fill (a "rasterize" or "expand" style operation, or a manual re-fill), or
accept the shape is left out — a gradient rarely reads as intended on a 3-4
color print anyway.

## Troubleshooting: "The hidden group … was skipped, with its … shapes" warnings

Full text: _"The hidden group "…" starting at shape N was skipped, with its N
shapes. Show it in your editor to print it."_ A group with no name has no
quoted name.

**What it means.** A group in the SVG is hidden, and nothing inside it was
imported. A hidden Inkscape or Illustrator layer is the usual case. Hidden means
any of:

- `display="none"`, as an attribute, an inline style or a class rule.
- `opacity="0"`.
- `fill-opacity="0"`. A shape inside that sets its own `fill-opacity` still
  imports, as it would draw in a browser.

**What you get.** The file loads as your editor shows it. The name is the
layer's name (`inkscape:label`, or Illustrator's `data-name`), else its `id`.

- The first number is the group's first shape element, counted from the top of
  the file as the gradient warning's is.
- The second counts only shapes that would otherwise have printed. Stroke-only,
  gradient-filled and self-hidden shapes are left out of it.
- A group hidden inside another hidden group raises no warning of its own. The
  exception is an outer group hidden only by `fill-opacity`: an inner group
  hidden by `display` or `opacity` then warns instead.

**What to do.** Nothing, if you hid the layer on purpose. If you meant it to
print, show the layer (or set its opacity back to 100%) in your editor, save,
and load the SVG again.

## Troubleshooting: "Masks aren't applied, so N shapes print uncropped" warnings

Full text: _"Masks aren't applied, so 3 shapes print uncropped and can cover
other colors. Crop the masked shapes in your editor."_

**What it means.** Some shapes sit under a clipping mask (`clip-path`) or a
mask (`mask`). The app reads each shape's own outline and doesn't crop to the mask,
so those shapes print whole, past the edge the mask hid.

**What you get.** The count is shapes, not masks. A shape the mask leaves
whole isn't counted.

- An artboard-sized clipping mask (the kind Illustrator writes around
  everything) crops nothing and raises no warning.
- A clipping mask the app can't measure counts every shape under it: a CSS
  shape such as `inset()`, one sized to the shape (`objectBoundingBox`), one
  holding text or a linked copy, or one with a hole in it.
- A `mask` always counts: it hides by brightness, so no outline proves it
  crops nothing.
- A mask that points at nothing, or at the wrong kind of element, is ignored,
  as a browser ignores it.

**What to do.** Crop the shapes for real, then save and load again. In
Inkscape, select the shape and its clip and use Path → Intersection. In
Illustrator, Pathfinder → Crop.

## Troubleshooting: "N linked copies were skipped" warnings

Full text: _"2 linked copies were skipped. Unlink clones and symbols in your
editor to print them."_ With one: _"1 linked copy was skipped. Unlink clones
and symbols in your editor to print them."_

**What it means.** The file draws something with `<use>`: an Inkscape clone or
an Illustrator symbol instance. The app doesn't follow the link, so the copy is
left out. The original still prints if it is drawn on its own.

**What you get.** One warning per load, counting copies that would have
drawn. Copies inside `<defs>`, in a hidden group, or set to `display:none` or
opacity 0 aren't counted.

**What to do.** Inkscape: select the clones and use Edit → Clone → Unlink
Clone. Illustrator: select the symbol instances and use Break Link to Symbol.
Save and load again.

## Troubleshooting: "N text objects were skipped" warnings

Full text: _"2 text objects were skipped. Convert text to outlines in your
editor to print it."_ With one: _"1 text object was skipped. Convert text to
outlines in your editor to print it."_

**What it means.** The app reads shapes, not fonts, so live text is left out.

**What you get.** One count per `<text>` element; its `<tspan>` lines are part
of it. Text that draws nothing (no fill and no stroke, hidden, or opacity 0)
isn't counted.

- **Template labels are never counted.** Text in the templates' guide blue
  (`#1a4f8f`) or canvas gray (`#bcbcbc`) is a label, not design. Loading a
  template, or a design drawn on one, stays quiet.

**What to do.** Convert the text to shapes, then save and load again.
Inkscape: Path → Object to Path. Illustrator: Type → Create Outlines.

## Troubleshooting: "N strokes with no fill were skipped" warnings

Full text: _"3 strokes with no fill were skipped. Convert strokes to paths in
your editor to print them."_ With one: _"1 stroke with no fill was skipped.
Convert strokes to paths in your editor to print them."_

**What it means.** The app prints fills only. A shape with `fill="none"` and a
visible stroke draws a line on screen and nothing on the print. The "no fill"
can be the shape's own or come from a group or the whole file: Figma sets it
on every export, so its outline-only shapes land here.

**What you get.** One warning per load. These aren't counted:

- A stroke that draws nothing: `stroke="none"`, width 0, stroke opacity 0,
  opacity 0, or hidden.
- **The design-boundary circle**: the largest circle in the file, often drawn
  as an outline on purpose (see "This SVG has a circle around most of the
  artwork…" below).
- **Template guide lines**: strokes in the templates' guide blue (`#1a4f8f`)
  or canvas gray (`#bcbcbc`).

A stroke on a filled shape is a different case: the fill prints and the stroke
is dropped, with no warning.

**What to do.** If the line should print, turn it into a filled shape, then
save and load again. Inkscape: Path → Stroke to Path. Illustrator: Object →
Path → Outline Stroke. If it's a guide, ignore the warning or delete the line.

## Troubleshooting: "No flat-filled shapes were found in this SVG."

Full text: _"No flat-filled shapes were found in this SVG."_ When text, linked
copies or strokes are why, it names them: _"No flat-filled shapes were found in
this SVG. Skipped: … Convert or unlink them in your editor."_ The list
reads like "2 text objects, 1 linked copy, 1 stroke with no fill".

**What it means.** The file parsed as valid XML, but nothing usable was left
after skipping elements with a gradient or pattern fill (see above) and elements
with no fill at all. Like "No opaque pixels were found…" and "No color regions
survived tracing…" earlier, the load fails as a no-op: whatever design was
already loaded stays exactly as it was.

**Usual causes.**

- Stroke-only line art. The app ignores strokes everywhere and looks only at
  fills.
- Live text, or linked copies (`<use>`) of shapes kept in `<defs>`. The
  sections above say how to convert each.
- Every shape uses a gradient or pattern fill, and all of them were skipped.
- Everything meaningful sits inside a `<defs>` or `<clipPath>` and nothing is
  drawn from it.
- Every layer is hidden (see the hidden-group warning above). Show the ones
  you want printed.

**What to do.** Open the file in your editor and confirm it has filled
shapes, not just outlines: select all and check the Fill/Stroke panel. Give
outline-only art a flat fill first if that's what you want printed.

## Troubleshooting: "This SVG has unusually deeply nested geometry…"

Full text: _"This SVG has unusually deeply nested geometry (rings nested past
a normal depth) and couldn't be processed."_

The app resolves which shapes are holes inside which others by nesting depth — a
ring inside a ring inside a ring. That resolution recurses once per level, and
this message replaces the raw "Maximum call stack size exceeded" a browser would
show when the recursion runs the JS call stack out, so the failure names what
was nested too deep instead of reading as a crash.

**What causes it.** Thousands of concentric rings (holes-within-holes) or, for
the sibling message from the SVG parser itself — full text: _"This SVG has
unusually deeply nested groups (elements nested past a normal depth) and
couldn't be processed."_ — `<g>` elements nested hundreds of layers deep. Both
are pathological, not something a normal export produces: a hand-authored SVG, a
generator script gone wrong, or an editor's "expand" operation applied
recursively.

**What to do.** Flatten the file in your editor (Illustrator/Inkscape's
ungroup, applied repeatedly, or Object → Flatten) before loading it. No app
setting raises this: the recursion depth isn't bounded on purpose, only caught
after the fact, so a merely deep-but-normal file (thousands of independent
shapes, not nested ones) doesn't trip it.

## Troubleshooting: "This SVG has no size in millimeters…"

Full text: _"This SVG has no size in millimeters, so it was auto-fit to the part
face. Set the document size in millimeters for an exact fit, or fine-tune with Scale."_

**Expected on every artwork the app ships, and on most editor exports.** The
document sheet is fitted to the part's design face, so a template round-trip
still lands 1:1.

Three files reach it:

| The file says                    | Why it can't be trusted                           |
| -------------------------------- | ------------------------------------------------- |
| `width="100%"`                   | No size at all. Affinity's default SVG export     |
| `width="755px"`, viewBox or not  | Pixels at the editor's own DPI, not a measurement |
| neither width/height nor viewBox | Nothing to fit; the design is placed 1:1 (below)  |

**The px case used to be silently wrong.** A `px` length means 1/96 inch per the
SVG spec, but Affinity writes px at the document's DPI. Our own 266mm footrest
template, edited in Affinity and re-exported at 72 DPI, comes back as
`width="755px"`. Read at 96 DPI that is 199.8mm, exactly 75%, and the design
printed a quarter too small with no warning. A size given only in pixels now
counts as no size, and the sheet is fitted to the face.

**Ticking "Set viewBox" on export doesn't fix this.** It writes
`viewBox="0 0 755 525"` beside the same `755px`, and 755px over 755 units is the
96 DPI assumption again: same 199.5mm, same silence. Both shapes are rejected.

**For an exact size instead of a fit**, set the document units to millimetres
before exporting: Document Setup in Affinity, Document Properties in Inkscape,
Artboard settings in Illustrator. `cm`, `in`, `pt` and `pc` are trusted too. If
the sheet and the part face have the same proportions (every shipped template
does), the fit is exact anyway.

**It can scale up as well as down.** A small mark on a large px page grows with
the page: a 200px icon on a 200px page lands at 185mm on the footrest, not
52.9mm. `Scale` brings it back. A saved session re-reads the file on reload, so a
design placed before this changed comes back at the new size.

### The 1:1 variant

Full text: _"This SVG has no size in millimeters, so its true print size is
unknown. It was placed 1:1 with its coordinate units. Set the document size in
millimeters, or use Scale to correct the fit."_

The file gives no sheet to fit: no `viewBox`, and not both of width and height.
A lone `width="755px"` lands here, as does `width="755px" height="100%"`. Each
coordinate unit is placed as 1mm, a guess and usually a large one. Set the
document size in millimetres, or use `Scale` to correct it by eye against the
design template.

Being visibly wrong is deliberate. Reading that lone `755px` at 96 DPI would put
the design at 199.5mm on a 266mm face: plausible, printable, and 25% wrong with
nothing said. A design three times too big gets noticed.

## Troubleshooting: "Path N has broken data partway through its outline" warnings

A `<path>` element's `d` attribute has a coordinate that isn't a number, most
often a truncated or hand-edited file (a save interrupted mid-write, a value
deleted while editing the raw XML). N is that path's position among **all** the
`<path>` elements in the file, hidden ones and clip-mask ones included — open
the SVG's XML/code view in your editor and count from the top to find it.

**What happens.** The one subpath (the run of drawing commands between one
`M`/moveto and the next) that hit the bad value is dropped whole, not just the
part after it: a subpath cut off mid-draw and closed on its own would be a
shape you never drew. Any subpath completed before it is kept. Any subpath
**after** it in the same path goes too, which is what "everything from that
point on" means. Other shapes in the file are unaffected.

**What to do.** Open the file in the tool you made it in and re-save, or
re-export the design. If a shape looks like it's missing part of its outline
after import, check that path first.

An arc command (`A`) also lands here when a flag position holds something
other than `0` or `1`. Its large-arc flag written `1.0` is the common one: the
grammar reads a flag as one character, so the `.0` left over is not a flag.
The shorthand that glues a flag to the coordinate after it (`A5 5 0 1110 0`)
is fine and parses.

## Troubleshooting: "… outlines cross over themselves and their halves cancel out, so they were left out" warnings

Full text: _"3 outlines cross over themselves and their halves cancel out, so
they were left out. Redraw them as separate shapes that don't cross."_ With one
outline it reads _"1 outline crosses over itself and its halves cancel out, so
it was left out."_

**What it means.** An outline in the SVG crosses over itself, and the two sides
of the crossing are the same size: a figure-8, an infinity sign, a bow-tie with
equal halves. One half runs clockwise and the other counter-clockwise, so their
areas add up to zero and the app reads the outline as empty. Your editor fills
both halves.

**What you get.**

- Those outlines are not cut. Everything else in the design is.
- If they were the only shapes, no colors show and Export stays off.
- One drawn as a hole inside another shape prints filled instead.
- The count covers every design loaded, each file once however often it is
  placed.

Halves of different sizes import fine, as do stars and subpaths that overlap.
A zero-width sliver (a line, or an outline traced out and back) fills nothing
in your editor either, so it is left out without a warning. A traced PNG or
JPG has not been seen to raise this: none of 6,250 traced outlines over the
raster corpus did (`node_modules/.bin/vite-node
scripts/measure-cancelling-outlines.ts`).

**What to do.** Redraw the outline as separate shapes that meet at the
crossing, two teardrops for a figure-8, and load the SVG again.

## Troubleshooting: "The hubcap disc is too small to reach its mounting clips"

Full text: _"The hubcap disc is too small to reach its mounting clips. They
would print as four loose pieces. Increase the diameter."_

The hubcap is generated rather than loaded: only its four clips ship as a mesh,
and the disc is built at whatever **Hubcap diameter** is set. The two bodies meet
on one flat plane and share no volume, so the disc must cover the clips' top
faces (a ring from 10.6mm to 16.0mm out from the axis) to be one printable
solid. Below about 21mm across the disc sits inside that ring, touches nothing,
and the part is five loose pieces.

That is why the diameter floor is about 32mm: the size at which the disc fully
covers those faces, not the smaller size at which it grazes them. The control
clamps to it, so **you shouldn't be able to reach this message by typing a
number.** If you see it, the diameter bypassed the control, most likely a
restored session from a different or hand-edited build.

The fix is the one the message gives: raise the diameter. Nothing is silently
discarded meanwhile; the warning stays until the part regenerates at a working
size, then retracts on its own.

**The failure it prevents is invisible from the app.** A hubcap whose clips
didn't bond looks normal in the viewport and exports a 3MF that slices without
complaint. It only shows up as loose parts on the finished plate, which is why
this is a hard floor rather than advice.

## Troubleshooting: "The hubcap is set to follow your artwork's shape, but no artwork is loaded"

Full text: _"The hubcap is set to follow your artwork's shape, but no artwork
is loaded. It stays round until you add one."_

The **Cut to artwork shape** checkbox and the artwork on the part are the same
object by design: there is no separate silhouette upload, so with nothing loaded
there is nothing to cut to. The part stays a plain circle at the **Hubcap
diameter** size and reshapes the moment you add artwork.

## Troubleshooting: "That shape doesn't cover the hubcap's mounting clips"

Full text: _"That shape doesn't cover the hubcap's mounting clips, so it stays
round. Make it bigger, or use artwork whose middle is filled in."_

The clips need solid material under them, in a ring 10.6-16.0mm out from the
axis: the requirement the plain-circle floor (`HUBCAP_MIN_DIAMETER_MM`)
enforces. A silhouette can fail it two ways a circle can't: too small overall,
or a hole or thin waist passing through the clip ring even at a reasonable size,
such as a ring-shaped logo.

Either way the part falls back to a circle rather than exporting clips bonded to
nothing. Increase the size, or pick artwork that stays solid in the middle.

## Troubleshooting: "A hubcap cut to shape can only follow one design"

Full text: _"A hubcap cut to shape can only follow one design. Remove the
others, or turn \"Cut to artwork shape\" off."_

With two designs loaded there is no single answer to "the shape": their union is
one option, either one alone is another, and nothing says which was meant. So
the part stays round. Remove the extra artwork with the × on its row, or turn
the checkbox off to keep both as designs on a round part.

## Troubleshooting: "This image has no transparent background, so the hubcap came out rectangular"

Full text: _"This image has no transparent background, so the hubcap came out
rectangular. Export a PNG with the background removed to cut it to the
artwork's shape."_

**Not a refusal.** A rectangular hubcap is a legitimate thing to want, so the
part builds. This checks for the likelier case: a WebP or flattened PNG that
lost its transparency, where what looked like a cut-out character is opaque to
its bounding box, so the "silhouette" is that box.

If you wanted a non-rectangular shape, re-export the source as a PNG with the
background actually removed, not just displayed as transparent in an editor that
drops transparency on export.

## Troubleshooting: "… lands entirely off the part and won't print"

Full text, one color: _"\"#ff0000\" lands entirely off the part and won't
print. Lower Scale or move the design to bring it back."_ Several colors:
_"4 colors land entirely off the part and won't print: "#101010", "#e07020",
"#f5d020", "#c1272d". Lower Scale or move the design to bring them back."_
A merged group is named the way its row is: _"Merged (3)"_.

Assembly mode only. Artwork is clipped to the part's design face, so a color
whose shapes all sit outside it cuts nothing anywhere. The usual causes are a
high Scale (at 400% only the middle of a design still fits) or a large offset
from dragging the design.

The named colors are dropped from the color list, the filament slot count, and
the exported 3MF's filament list: they cost nothing, they just don't print.
Bringing the design back (lower Scale, or drag it toward the face) restores
them, rows and slots included.

If a color should be partly on the face but this fires anyway, check where the
design is anchored. An SVG with no `<circle>` boundary marker is auto-centered
on its bounding box, which a stray decorative element can move.

**Its sibling below is a different cause with a different fix.** A color that
reached the part but only on covered surface gets "… only reaches surface
that's hidden once assembled" instead. Lowering Scale won't help there.

## Troubleshooting: "… only reaches surface that's hidden once assembled"

Full text, one color: _"\"#ff0000\" only reaches surface that's hidden once
assembled and won't print. Move it off the hatching to bring it back."_
Several colors: _"3 colors only reach surface that's hidden once assembled and
won't print: "#101010", "#e07020", "#f5d020". Move them off the hatching to
bring them back."_ A merged group is named the way its row is: _"Merged (3)"_.

Assembly mode, chair only today. The chair's design zones run under the wheels
and the cushions, and the app doesn't cut artwork into surface that is covered
once the chair is together. This says the only surface the color reached is that
covered surface, so nothing of it prints.

**It says nothing about the rest of the design.** A color can be mostly off the
part while the one piece that does reach it sits on a covered strip, and "it all
landed on covered surface" would be false of that. What the app knows is that no
visible surface took the color, and some covered surface did.

**It is not the same as landing off the part.** Part of the design is on the
part, on the covered strip, so Scale is the wrong control: a smaller design
centred on the same spot is still on covered surface. Move it. If moving it off
the hatching doesn't bring it back, it was the straddling case and needs a
bigger move than the hatching's own width.

**Where to move it to.** The covered surface is crosshatched in the 3D view and
hatched on the printable template, both before any artwork is placed. `Left seat
side` and `Right seat side` catch people out: 81% of each is covered once the
chair is assembled (the bake log's per-zone `dead` figure over the zone's
claim), so a design dropped there with no adjustment lands almost entirely
covered. The seat pan itself is in no zone.

The named colors are dropped from the color list, the filament slot count, and
the exported 3MF's filament list, and come back with the design when it moves.

If a color should be on visible surface but this fires anyway, check the
placement offsets and the zone the design is bound to. Every zone has its own
template, and the design is centred on the whole zone, not the part you can see.

## Troubleshooting: "Couldn't shade the hidden surface on …"

Full text: _"Couldn't shade the hidden surface on "seat-left". Artwork still won't cut
there. Only the hatching is missing. Please report this."_

Assembly mode, chair only today. The app failed to build the crosshatch for one
patch of covered surface on that zone. The print is unchanged: the surface is
still covered, and artwork placed on it is still clipped away. What's missing is
the picture of where that is.

**It matters because the hatching is the instruction.** The sibling warning
above tells you to move a design off the hatching. If a patch is missing, that
spot looks like somewhere artwork is welcome and it isn't.

**What to do.** Download the zone's template from the Templates panel: it is
drawn from the same baked regions and generally still shows the patch, so it is
the second opinion. Then report it, with the zone name from the message — a bug
in the app, not your file, and nothing you change in the design will clear it.

## Troubleshooting: "This SVG has a circle around most of the artwork, but some falls outside"

A design template marks its boundary with a circle drawn around everything, and on a
round part the app sizes your artwork to that circle. This says the circle is
there but something in the file sits outside it, so the circle wasn't used and
the design was fitted by its overall size instead.

**The usual cause is a stray filled shape**: a dot parked off to one side, a
leftover filled rectangle, a stray copy of something. It has to be filled to
count. Stroke-only objects are ignored everywhere, so a loose guide line or an
unfilled outline isn't what tripped this.

**It moves the design as well as shrinking it.** The fallback centres on the
whole drawing, stray included, so the artwork comes out smaller and off-centre.
Scale alone won't put it back; use Offset X/Y too, or remove the stray and let
the circle do its job.

- **Find what is outside the circle** and delete it. In Inkscape or Illustrator,
  select all and compare the selection bounds against the template outline.
- **Or set the fit by hand** with Design radius / Scale / Offset.

**A circle that holds little or none of your drawing says nothing**, and isn't
used either. That is ordinary decoration (suns, balloons, eyes, polka dots).
Before this rule the largest such circle became the boundary, so a corner dot
could be blown up to the whole face while the rest of the design was thrown off
the part in silence.

## Troubleshooting: "This shape was too big for the wheel, so it was scaled down to fit"

Full text: _"This shape was too big for the wheel, so it was scaled down to fit.
The hubcap and its artwork are smaller than the size you set. Reduce the size
or the scale to take control."_

Nothing may overhang the wheel the hubcap mounts on, which is 280mm across. A
silhouette can exceed that while its **Hubcap diameter** reading looks fine,
because that number is the longest side and a shape's corners reach further: a
square 280mm on a side reaches 198mm from the axis and hangs 58mm past the rim.

Rather than refusing, the whole placement is scaled down until it clears, and
the artwork by exactly the same factor so the picture still lands on the shape
cut for it. Without this message the symptom is the size control appearing to
stop working. Lower the diameter or the artwork's Scale until it clears to take
control back.

## Troubleshooting: "Some of this shape is thinner than 1mm"

Full text: _"Some of this shape is thinner than 1mm, about one nozzle wide.
Those parts will be fragile. Simplify the artwork or enlarge the hubcap to
thicken them."_

Unlike the other silhouette warnings, this one does **not** fall back to a
circle. The part builds at the shape and size you set, because a thin spike
still makes a valid solid.

A printability notice, not a geometry error: a 0.5mm sliver is one nozzle-width
of plastic standing 3mm tall, likely to snap off in handling or not adhere while
printing. Hair spikes and thin limbs on a character are the usual cause.

Making the hubcap bigger thickens every feature proportionally, since the whole
outline scales together. Or simplify the source artwork.

## Troubleshooting: "… reaches the part's outer edge, so that region cuts the full 3.00 mm through"

**A note, not a problem.** It describes what a hubcap **cut to your artwork's
shape** does on purpose.

The disc is a 3 mm shell. Normally a colour is recessed into it at its depth
setting (1 mm by default), leaving base-colour plastic underneath. That is right
for artwork in the middle of the part and wrong at the very edge: the outline is
the whole reason the part was cut to your shape, and a recess would leave it as
a 2 mm band of base colour visible from every angle except straight on. So any
region reaching the outline is cut the full 3 mm, and the rim prints in that
colour.

- **It names the colours it did this to.** A colour's _interior_ regions still
  cut at its recess depth; only those touching the edge go through. A colour
  with regions in both places is cut both ways.
- **It overrides a depth you set, at the edge only.** A depth you typed still
  applies to interior regions. That is why the note lists colours rather than
  just describing the rule.
- **Only on a hubcap following your artwork's shape.** Turn "Cut to artwork
  shape" off and every colour goes back to a plain recess. A round hubcap never
  does this: its rim is chamfered, so the design face is inset 1 mm and cutting
  through wouldn't reach the rim anyway.
- **Not the same as the wheel's cap**, which cuts _every_ colour through because
  the whole part is built that way. This rule is per region.
- **Outside edge only.** If your silhouette encloses a hole (a letter "O", a
  doughnut) the rim around that hole is still a recess and prints in the base
  colour. Known limitation, in [tech-debt.md](tech-debt.md).
- **No way to opt out today.** Moving the artwork in from the outline (Scale
  slightly below 100%) keeps every region clear of the edge, at the cost of a
  base-colour rim.

## Troubleshooting: "Couldn't tell whether … reaches the part's outer edge"

The clip step failed while working out whether one colour region touched the
part's outline, so that region was cut as a normal recess rather than through.
Everything else on the part is unaffected.

**This is the safe direction to fail in.** A recess is what every part did before
the edge rule existed, and it prints; a through-cut where one wasn't wanted
would be a hole. The visible symptom is one colour's edge stopping short of the
rim while others reach it, which is why it says so rather than staying quiet.

Same cause as the "Couldn't merge the shapes" warnings above: dense or
self-touching line-work the 2D maths can't resolve. Simplifying that colour's
regions, or nudging Scale, usually clears it.

## Troubleshooting: "That saved session could not be opened, so it was cleared"

**What it means.** The app found a saved session from a previous visit, you asked
for it back, and it couldn't be read. The save has been removed so it won't be
offered again.

**What to do.** Reload the page before carrying on. Most failures stop before
touching your printer, shape or colour settings, so those are usually unchanged.
A reload starts clean.

**Why it happens.** The stored session is JSON in the browser's local storage for
this site. It reads as valid JSON but describes something this build can't use:
another tab or extension wrote to the same key, or the session came from a build
whose settings no longer line up. Settings that didn't exist when the session
was saved are filled in at their normal values rather than failing, so this
message means something beyond that. A save damaged outright can't be parsed at
all, so it is discarded on load without a banner ever being offered.

**What it does affect.** The printer, shape and colour settings only change once
every design in the session has come back, so a failed one usually leaves them as
they were. A saved part that doesn't load has its own message (below). The app
stops saving until you reload, so nothing is written over what you had, but
anything you do before reloading won't be saved. Reload first.

## Troubleshooting: "Couldn't restore your session: the … didn't load"

Full text: _Couldn't restore your session: the Footrest didn't load. Reload the
page to try again._ The part named is the one the session was saved on.

A second form: _Your session wasn't restored: the part changed before the
Footrest loaded. Reload the page to try again._ That one means a different part
was picked while the saved one was still loading.

**What it means.** You asked for a saved session back, and the part it was saved
on didn't load. Usually the parts library couldn't be reached: a dropped
connection, or a site update landing mid-visit.

**What it does affect.** Nothing from the session is applied. Your settings and
designs stay as they were before you clicked Restore, on the part you had or the
one you picked. The saved session is kept, and the next visit offers it again.

The app stops saving until you reload, so the saved session isn't replaced.
Anything you do before reloading won't be saved.

**What to do.** Reload once the connection is back, and click Restore again.

## Troubleshooting: "… could not be restored from the saved session…"

Full text: _"…" could not be restored from the saved session. Load the image
again to put it back. Everything else in the session was restored."_

**What it means.** Different from "That saved session could not be opened…"
above: the session was read fine, but one image inside it failed while the app
decoded it and re-ran Colors/Detail on it — usually a corrupted or truncated
saved copy. Only that source is lost; every other design and setting comes back
normally.

**What to do.** Load that image again from your original file. Nothing else needs
fixing — the rest of the session is unaffected, name and all, so re-adding the
design in the same spot is the whole recovery.

## Troubleshooting: "… deeper than "Wheel top" goes. It was cut at … mm instead"

**What it means.** The depth you asked for is more than the part has material
for, measured from its design face straight back. It was cut at the deepest the
part can take, a fraction of a millimetre short of breaking out the back. The
colour's row shows the same number beside its Depth field ("cut at … ").

**What to do.** Nothing, if the number was a slip. For a deep pocket, the part is
the limit; there is nothing to raise it to.

**This is not the wall check.** A part's wall varies across it, and a recess under
this limit can still reach the back of a thin spot. That has its own warning,
"… mm thick under it" below, and this one stays quiet for it.

**Some parts raise no limit and cut silently to whatever you asked — not a bug;
both cases are read straight from the code:**

- **The part declines to measure a limit.** `maxCutDepth()` returns `Infinity`
  when it has nothing to measure against:
  - A face the cut axis can't read: not near-vertical (its normal's Y
    component is at most 0.1), or the projected face plane lands outside the
    part's own vertical extent (a tilted or sideways patch).
  - A part too thin to hold even the smallest printable recess (0.20 mm) once
    the through-safety floor is subtracted.
  - No mesh loaded yet.
  - **Every part on a baked design surface** (the chair body is the only
    shipped example): a curved chart has no single axis to measure a depth
    against, unlike a flat patch. The wall under each colour is still checked
    there: "… mm thick under it" below.
- **A limit applies, but nothing was cut at it.** The clamped number is
  computed, but the part discards it, so nothing in the message would be true:
  - **A cut-through part** (the wheel's cap) ignores the setting and holes a
    fixed or measured depth of its own.
  - **A colour that lands entirely on the part's outer wall.** The edge rule
    (see "reaches the part's outer edge" above) cuts it full thickness instead.
    The warning only fires for the part of a colour cut at the clamped number.

**A rotated copy is a part in its own right here.** The wheel's two halves are
"Top" and "Bottom", so a colour clamped on only one names that half, and a colour
on both gets a pill for each. Colours clamped from the same depth setting share
one pill per half; a colour with its own depth gets its own.

## Troubleshooting: "… is only … mm thick under it"

Full form: `Depth for "#ff0000" was set to 5.00 mm, but "Hubcap" is only 3.00 mm
thick under it. It was cut at 2.95 mm instead.`

**What it means.** The part as a whole had room for the depth, but the wall
under that colour doesn't. Cut as asked, the pocket would break out the back.
It was cut 0.05 mm short of the thinnest wall anywhere under the colour instead.
Over a wall thinner than 0.25 mm it is cut at the 0.20 mm minimum, which still
reaches the back there. The colour's row in the colour list shows the same
number ("cut at … ").

- One depth per colour per part. A colour spread over thick and thin spots is
  cut to the thinnest.
- The shipped hubcap is the usual case: 8.12 mm deep at its clips, but a 3 mm
  shell everywhere else.
- On the chair body the wall is measured along the curved surface, the way the
  cut follows it. Its thinnest is 2.03 mm, at the handles' edges, so the default
  1 mm depth is never cut short.

**What to do.** Nothing, if a recess this deep is fine. For a deeper pocket where
the part is thicker, give that area its own colour. A colour that never reaches
the thin spot keeps its full depth.

**When it stays quiet**, and a pocket can still break through:

- **A thin spot under 1 mm across on the chair body.** Its wall is sampled every
  1 mm, plus along each colour's outline near a zone's edge, so a spot that
  narrow can fall between samples.
- **The part-wide checks declined.** The same cases as "… deeper than "Wheel
  top" goes" above: a sideways or tilted face, a face plane off the part.
- **Cut-through parts and edge regions.** They go the whole way through on
  purpose.
- **A colour that couldn't be trimmed to the face.** That has its own warning,
  "Clipping color region to the design face failed…".

Grouped like the part-wide warning: one pill per part per pair of numbers,
naming every colour that shares it.

## Troubleshooting: "… zones still blank" notices (assembly mode)

Full text: _"…: … of … zones still blank. Add more from the zone dropdown, or
pick "All zones" to cover every zone."_ ("zone", singular, when only one is
missing.)

**An informational notice, not a warning**, on a part offering more than one
design zone (the chair body is the only shipped example). By default a loaded
design binds to one zone only, since binding every zone would recut the whole
part on every nudge. The notice exists because that default is easy to miss: a
design bound to one zone of five looks like a finished part in the viewport,
right up until it's opened in a slicer and most of it prints in the base color.

**What to do.** Either is fine, depending on what you want:

- **Add more designs**, one per zone, from each zone's dropdown.
- **Pick "All zones"** on one design to cover every zone with it.
- **Leave it as is**, if you only meant to decorate part of the piece. The
  notice makes the coverage visible; it doesn't ask you to change anything.

## Troubleshooting: "… designs were on zones this part no longer has"

Full text: _"1 design was on a zone this part no longer has. It's on All zones
now."_ ("2 designs were on zones this part no longer has. They're on All zones
now." for more than one.)

**Only on restoring a saved session**, and only when the part still loads. The
saved session stores which zone each design was on by name. A release that
re-bakes a part's zones can rename or retire one, and the saved name then
matches nothing on the part that just loaded.

The design is not lost. It is moved to All zones, the binding that always cuts
something, and the zone badge on its row says so.

**What happened to the chair.** The seat pan came out of every zone, because the
cushion covers all of it, and the `Seat` zone became `Left seat side` and `Right
seat side` on the two shelves either side. A session saved before that names a
zone the chair no longer has.

**What to do.** Pick the zone you want from the design's dropdown, or leave it
on All zones. Saving again writes the new name, so the notice doesn't come back.

## Troubleshooting: "…" is set to cover the whole part, but this part has no whole-part sheet"

Full text: _""…" is set to cover the whole part, but this part has no
whole-part sheet. Pick a single zone for it from the list."_

**What it means.** This design's row is bound to **Whole chair**, but the
loaded part has no whole-part sheet — it isn't the chair, or its zone data
predates that option. The binding survives switching parts and reloading the
page, so it's easy to carry over from a session where it did apply.

**What to do.** Pick a single zone from the row's dropdown. Switching back to
the chair restores **Whole chair** as an option.

## Troubleshooting: "The "…" zone isn't loaded, so "…" won't be cut there"

Full text: _"The "…" zone isn't loaded, so "…" won't be cut there. Reload the
page to try again."_

**What it means.** A design bound to **Whole chair** cuts onto every zone the
whole-part sheet places. One of those zones didn't load, so this design gets
nothing there. Every zone that did load still gets its cut.

**What to do.** Reload the page. If it keeps happening, report it via
**Feedback** or **Report a bug on GitHub**, naming the part.

## Troubleshooting: "The "…" zone isn't on the whole-part sheet, so "…" won't reach it"

Full text: _"The "…" zone isn't on the whole-part sheet, so "…" won't reach
it. Add another design and target that zone."_

**An informational notice, not a warning.** The loaded part carries a design
zone the whole-part sheet doesn't place — a zone a future re-bake added without
giving it a spot on the sheet. A design bound to **Whole chair** never reaches
that zone.

**What to do.** Add a separate design and target that zone directly from its
own row's dropdown.

## Troubleshooting: "…" reaches part of the whole-part sheet that "…" owns"

Full text: _""…" reaches part of the whole-part sheet that "…" owns. It is cut
there, not on "…"."_

**An informational notice, not a warning.** Two zones can lie over each other
on the whole-part sheet, and the seam between them decides which one owns the
shared area. A design bound to **Whole chair** that reaches into it is cut on
the zone that owns it, once — not on both, and not nowhere. The whole-part
template hatches those areas and names the zone that cuts them.

**Where those areas are on the part.** The 3D view cross-hatches them too, while
a **Whole chair** row is the active one. That hatch crosses in two directions in
the second accent, so it doesn't read as the single-direction hidden-surface
hatch beside it, which means something else.

**What to do.** Nothing, unless you wanted that mark on the other zone. For
that, bind a separate design to that zone from its own row's dropdown: a
per-zone binding reaches all of its zone's surface, hatched areas included.
Select that row and the cross-hatch goes, since nothing is withheld from it.

## Troubleshooting: "Couldn't trim "…" to the part of the whole-part sheet "…" owns"

Full text: _"Couldn't trim "…" to the part of the whole-part sheet "…" owns.
Some of it prints twice. Bind that design to one zone instead."_

**What it means.** The trim above couldn't be applied, so this zone cut the
area another sheet also cuts. That part of the design prints in two places on
the chair. Either the polygon clipper failed on it, or the baked record of what
this zone gives up wouldn't load.

**What to do.** Bind the design to a single zone from its row's dropdown, which
skips the trim. Please also report it via **Feedback** or **Report a bug on
GitHub** — this failing is a bug, not a placement you can draw around.

## Troubleshooting: "…" crosses between "…" and "…", where the two sheets do not join"

Full text: _""…" crosses between "…" and "…", where the two sheets do not join.
It prints in two pieces, about …mm apart. Bind it to one zone instead."_

**What it means.** Two sheets sit side by side on the whole-part template all
along their shared edge, but the surfaces under them only meet over part of it.
The template draws that part as a solid line and the rest as a dotted one. A
design bound to **Whole chair** that crosses the dotted part is cut correctly on
both zones and still comes out as two marks, on faces of the chair tens of
millimetres apart. The distance quoted is the typical gap along that stretch.

On the chair today, the left flank meets the back over about 120mm around the
storage-box corner, and the right flank over about 16mm. Everywhere else along
those two edges, this is what happens.

**What to do**, in order of least work:

- Move the design so it sits inside one zone's own area, away from the dotted
  edge. The template shows where that is.
- Or bind it to a single zone from its row's dropdown. A per-zone binding cuts
  all of one zone's surface and stops at its edge, so there is no second piece.
- Two marks meant to line up across the join have to sit on the solid stretch.
  Nothing else on that edge lines up.

## Troubleshooting: "Exporting with artwork on … of … zones…" warnings

Full text: _"Exporting with artwork on … of … zones. The other … zones will
print body-colored with no design."_ ("zone", singular, for one.)

The same coverage gap as the notice above, escalated to a red pill at the last
moment before an export downloads — easy to have scrolled past earlier, harder
to miss right before the file. It doesn't block the export: the file is valid
and prints fine, just with blank zones.

**What to do.** Same as above: add more designs, or switch one to "All zones",
if the blank zones weren't intentional. If they were — you're decorating one
panel and leaving the rest plain — there's nothing to change; the export
proceeds either way.

## Troubleshooting: "has no verified print placement" warnings

Full text: _"Part "Footrest" has no verified print placement under its part id
"footrest", so it was placed automatically. Check it in your slicer before
printing."_

**What it means.** Every shipped part's pose on the plate is normally baked
from a reference file a human checked in a slicer. This part exported without
that check, so the automatic placement it fell back to has never been verified
to avoid overlaps or print cleanly. It still exports — a warning, not a failure
— but check it before printing.

The message ends the same way for two different reasons, and one of them is not
a defect:

- **"…has no verified print placement under its part id…"** — this part id has
  no baked placement at all. Either a new part kind hasn't had its pose baked
  yet, or the id is wrong. See the `PLACEMENT` provenance comment in
  [src/export/placement.ts](../src/export/placement.ts) for why it's a lookup
  table keyed by part id rather than data on the part definition.
- **"…doesn't match the mesh its verified print placement was baked
  against…"** — a placement exists, but the loaded mesh's fingerprint doesn't
  match what it was baked against. This happens when a shipped part's mesh is
  re-packed without re-running `bake-part-fingerprints.mjs` afterward (see the
  `add-part` skill, "run this after every re-pack of a shipped part, not just
  new ones"). It is deliberately loud rather than silently trusting a stale
  pose — see the header comment in
  [scripts/bake-part-fingerprints.mjs](../scripts/bake-part-fingerprints.mjs).
- **"…is generated to the size you chose. No pre-verified print placement
  applies…"** is the third, unremarkable case: a part like the hubcap, built to
  the dimensions you set, has no fixed mesh for a pose to be verified against.
  It shows as an informational notice, not a warning.

**What to do.** Check the part's position and rotation in your slicer before
printing, as with the prime-tower warning below. A maintainer seeing the
mesh-mismatch form on a shipped part needs to re-bake its placement; there's no
workaround on your end.

## Troubleshooting: "The prime tower … has no verified position. Every corner … overlaps a part"

**What it means.** The plate is crowded enough that the prime tower has nowhere
clear to go. The tower is the block the printer wipes filament into on every
color change, and it needs its own floor space.

The message ends one of two ways, and they ask for different things:

- **"It was put at (x, y), so move the tower in your slicer."** A position was
  saved, and it overlaps a part. Open the plate in your slicer, drag the tower
  somewhere clear, and save before printing.
- **"No tower position was saved, so your slicer will place it."** Every plate
  that prints a tower was crowded, so nothing was written and your slicer picks
  the spot. Check where it landed before printing.

**What to do about the crowding.** Fewer colors means a smaller tower. Merging
two similar colors in Colors detected, or sending one to the base, frees space.
So does a smaller part on the plate, where the size is yours to choose.

**Why it happens.** The check measures each corner against each part's own
footprint, drawn a little wider than the real shape. A part with a deep notch is
drawn quite a lot wider, so it can be reported as blocking a corner it leaves
open. That is on purpose: a tower printed through a part is worse than one you
place yourself. The tower size the check assumes is nominal, so check the real
one in your slicer either way.

## Troubleshooting: "Rebuild failed: …"

Full text: _"Rebuild failed: …"_ — followed by whatever error the rebuild
threw.

**This is the app's last-resort catch, not a specific diagnosis.** Every other
warning in this doc is raised deliberately by code that expected the failure and
degraded gracefully. This one means an exception escaped all of that: something
the rebuild didn't expect to throw, did.

**What it means.** The text after the colon is the actual JavaScript error
message, also logged to the browser console with a full stack trace. Neither is
written for a volunteer; both are for whoever investigates the report.

**What you get.** The rebuild for that attempt is abandoned. Depending on when
it threw, the viewport may show the previous build, a partial one, or the bare
uncut parts — no single guaranteed state, since this is the path for the
unexpected.

**What to do.** Try the rebuild again (nudge a setting, or reload the page) —
many causes are one-off. If it keeps happening, open the browser console, copy
the full error and stack trace, and report it via **Feedback** or **Report a bug
on GitHub** with that detail and what you were doing right before.

## Troubleshooting: "The browser stopped partway through cutting the design"

Full text: _"The browser stopped partway through cutting the design, often from
running out of memory. The 3D view still shows the last result, and export is
off. Change any setting to try again."_

**The cutting runs in a background worker, and the browser ended it partway.**
Usually memory: a very large Fill or a design covering every zone of the chair
is the likeliest cause. (A worker that fails to load at all isn't this: the app
then cuts on the page instead, slower to respond but with nothing lost.)

- **What you get.** The 3D view keeps whatever it showed before. Export stays
  off until a rebuild succeeds, so nothing stale can be exported.
- **What to do.** Change any setting: the next rebuild starts a fresh worker.
  If it happens again on the same design, lower Scale, bind the design to one
  zone, or switch a Fill to Sticker.
- If it happens on a small design, open the browser console and report the
  error with **Feedback**.

## Troubleshooting: "Couldn't cut the design because of a problem in the app, not your file"

Full text: _"Couldn't cut the design because of a problem in the app, not your
file. The 3D view still shows the last result, and export is off. Reload the
page to try again."_

**A bug in the hand-off to the background worker that cuts the design**, not
anything about the design itself. The browser console holds the detail, logged
as `build worker: …`.

- **What you get.** The 3D view keeps whatever it showed before, and Export
  stays off until a rebuild succeeds.
- **What to do.** Reload the page. If it comes back, report it with
  **Feedback**, including the `build worker:` line from the console.

## Troubleshooting: "Refusing to write a non-finite coordinate into the exported 3MF."

Full text: _"Refusing to write a non-finite coordinate into the exported
3MF."_

You see it as `Export failed: Refusing to write a non-finite coordinate into
the exported 3MF.` — the export button's generic failure dialog wrapping this
refusal.

**This is a last-line-of-defense guard, not something your artwork can trigger
directly.** Every vertex coordinate is checked as the file is written, and a
`NaN` or `Infinity` anywhere refuses the write outright rather than shipping a
3MF a slicer could silently mis-render or reject. The check also covers the
prime tower's saved position and each plate's transform.

**What it means when it fires.** A geometry operation upstream — a boolean cut,
a mesh transform, a degenerate zero-area shape — produced a coordinate that
isn't a real number, and nothing caught it before export. This shouldn't happen
on ordinary artwork.

**What to do.** Note what you last changed (which part, which colour, which
setting) and report it via **Feedback** or **Report a bug on GitHub** with that
detail — the message doesn't say which vertex or part is at fault, so
reproducing it is what makes the report useful.

## Troubleshooting: "Couldn't trace the whole edge of the design face on …" (assembly mode)

The chosen design face has edges that no closed outline can take. That happens
only on a face whose triangles overlap or fold over each other, so a vertex has
more edges leaving it than arriving. No packed part in `public/stl/` has such a
face: `tests/patch-boundary.test.ts` traces every face the Advanced dropdown
offers on each of them. The Hubcap's disc is generated at run time and isn't in
that corpus; it comes out of the boolean engine as a closed solid, which can't
produce an open edge.

- **The rings that did close are kept and clip the artwork.** The edges that
  didn't are what the warning is about. Artwork near them may be cut past a gap
  or stop short of one.
- **"… so no artwork will be cut on it"** is the same fault with no ring
  closing at all. The part then has no design face, the build skips it, and it
  exports in body colour only.
- **Pick another design face** from the Advanced disclosure. The warning clears
  when the new face traces in full, and goes with the part when the part is
  removed.
- A face whose edge touches itself at a single point (a hole meeting the
  outline, two islands sharing a corner) doesn't raise this. That case traces
  correctly.

## Troubleshooting: "Couldn't load "…", so the export will be missing it"

A part's file didn't download (a 404, a dropped connection) or didn't parse. The
alert named the part; this warning stays after it is dismissed.

- **Export still works, without that part.** The 3MF holds every part that did
  load. The wheel with no Top exports its Cap alone; a chair missing one part
  exports the other twelve.
- **Reload the page to try again.** The warning clears when a later load of the
  part succeeds, or when the part type changes.
- **A part type that fails as a whole** is not left half loaded. Switching to it
  puts the previous one back, with an alert, and this warning is not raised.
- If it keeps happening, the file is missing from the deploy: check the browser's
  network tab for the named file under `stl/`.

## Troubleshooting: "Couldn't send that" in the feedback panel

The Feedback panel posts to Formspree. Two failures show there, and neither
touches your work: the app keeps running and the note stays in the box.

| Message                                                             | What happened                                                       |
| ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `Couldn't send that. Check your connection.`                        | The request never reached Formspree, or took longer than 15 seconds |
| `Couldn't send that (HTTP 429). Use the GitHub link below instead.` | Formspree answered and refused. `429` is the monthly submission cap |

- **Your note is still there.** Send again once you are back online. Nothing is
  cleared until a send succeeds.
- **A 4xx code means the form refused, and retrying won't clear it.** `429` is
  the monthly cap, `403` a form switched off. The message says to use **Report a
  bug on GitHub** in the same panel, and that is the fix.
- **A 5xx code is Formspree being down.** That one is worth retrying.
- **No Feedback button at all** means the build was made without
  `FEEDBACK_ENDPOINT` set, which is every fork. See
  [.env.example](../.env.example).
