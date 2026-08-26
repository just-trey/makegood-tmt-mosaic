# Troubleshooting

One section per user-visible warning string.

## Troubleshooting: "Couldn't merge the shapes" / "Couldn't trim the overlap" warnings

The polygon maths failed on one colour's shape. The warning usually names the
colour. One form of it does not: the flat build merges the shapes painted over
each region in batches, and a batch holds whatever colours fell in it, so a
failure there names none. Treat it as "somewhere in this design" and read on.
There are two causes and the warning does not guess between them: a
**self-intersecting path** in the source SVG (much the commoner one), or sheer
size in Fill mode (below).

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

**In Fill mode, suspect size before the path.** Fill merges one copy of the
design per tile, and the polygon library also fails on sheer size, around 800k
points in one operation, with the identical warning. A design that
unions cleanly as a Sticker but fails once repeated across a chair zone (143
tiles of a 60mm pattern) has hit the size limit, not a bad path, and Path →
Union will change nothing.

The tell: failures arrive per-part in a batch rather than on one colour, and the
model carries visibly _less_ geometry than it should, so parts of the surface
come out blank. Fix by simplifying the design (fewer, larger shapes) or using
Sticker. Numbers in [tech-debt.md](tech-debt.md), "Turf's tile union has a
vertex ceiling".

## Troubleshooting: "Couldn't cut color … into …" warnings (assembly mode)

Assembly mode clips each colour's region to the part's face, then extrudes it
into a 3D pocket. Dense line-work can come out of that clip touching itself at a
point: valid to the 2D maths, but not a sealed solid to the 3D engine. The app
repairs it automatically via Manifold's own 2D boolean engine, offsetting the
region by a hair and back to break the exact-touching topology, and retries
once. If the warning survives, that pocket was skipped, and the same source fix
as above usually resolves it.

**How much of the colour you lose depends on the colour.** The warning is raised
per region, not per colour, and the build carries on with the rest. A colour
split across two depths keeps the slice that did extrude, so it can come out
partly cut. That is why the warning names no outcome: check the part in the
preview rather than assuming the colour is gone.

**The 3D pass can also fail later.** Each failure degrades to something a slicer
can print rather than a broken file, and the warning tells you which outcome you
got. Two of them mean the part carries less artwork than you designed:

| Warning                                                                                                 | What you get                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Couldn't merge color … on …"                                                                           | That one colour is dropped from that part. Every other colour cuts normally.                                                                                                    |
| "Couldn't merge the recesses on …", or "Couldn't cut the recesses into …"                               | That part ships with **no artwork at all**. Still printable, just blank, so don't print it expecting the design.                                                                |
| "Couldn't fit the inlay for color …: its pocket is cut into the body but will print as an empty recess" | The recess is cut but nothing fills it, so that colour prints as a bare cavity.                                                                                                 |
| "Part … has no geometry to export, its pocket cut went all the way through …"                           | The cut succeeded but left nothing: a pocket reached the part's wall thickness and went clean through. The part is dropped from the export rather than shipping a hollow shell. |

These are 3D failures rather than the 2D clip problem above, so path-cleaning is
less reliably the fix. Suspect the part mesh and the amount of fine detail
landing on it. What they are _not_ is silent: before this handling existed, the
same failures either blanked the viewport or shipped an uncut body alongside
inlays occupying the same space, which a slicer resolves arbitrarily.

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
  "Merge with…" dropdown. The group prints in its dominant member's colour.
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
_different_ colours cross, the exported file carries two inlay solids in the
same space and the slicer picks between them however it likes. Invisible until
the file is opened.

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
still do, and that is a false alarm: the file is safe to print.

**Two designs both set to Fill always warn**, with their own message: a fill
repeats across everything it covers, so the second lands on the first
everywhere. Moving or rescaling cannot clear it. Switch one to Sticker, move it
elsewhere, or remove it.

A fill _under_ a sticker is not flagged, because a pattern background with a
design on top is a real workflow. It has the same overlapping-inlay problem
where the sticker's colours differ from the pattern's. Known gap, also in
[tech-debt.md](tech-debt.md).

## Troubleshooting: Fill warnings, "You have one tile instead"

Fill repeats one design across a whole part. When it can't work out how, it
places the design once and says why. Only the first reason below is fixed by
changing Scale; the last two mean a bug rather than a problem with your design.

### "… is too small to fill …: it would take more than 1024 tiles."

The commonest one. A pattern scaled far down against a large part (5% on a chair
panel) needs tens of thousands of copies, which would hang the tab, so the app
refuses instead of freezing.

**Raise Scale** until the count comes down. A larger tile is usually what you
wanted anyway: a pattern at 5% reads as texture, not as a pattern.

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

## Troubleshooting: "Depth for … was set to … mm" warnings (flat mode)

The flat shape modes cut every recess into a plate of one fixed thickness. A
recess reaching the back would cut clean through, so no depth is allowed past
the thickness less a 0.05 mm floor (3.95 mm on a 4 mm plate). One of your depths
was past that, and the recess was cut at the deepest the plate allows.

- **The file is still valid and printable.** The depth actually cut is the last
  number in the message. Nothing is dropped; only the depth differs.
- Fix from either end: lower that region's depth, or raise **Thickness** in the
  Part section.
- The name in the message is the colour list row, worded as that row labels
  itself: a hex, "Merged (N)", or "Background".
- A region with no depth of its own uses the global **Depth**, so a global depth
  larger than the plate warns for every region at once. Raise the thickness or
  lower the global rather than editing rows one by one.
- A row carrying its own depth is highlighted and has a "↺" beside it. That
  button, or clearing the field, returns it to the global. **If the global Depth
  field seems to do nothing, those are the rows to look at.**

Assembly mode has the same hazard but catches it later and words it differently,
because wall thickness varies across the part: see "Part … has no geometry to
export" above.

## Troubleshooting: "Depth for … is … thinner than the usual 0.20 mm print layer"

A quiet note, not an error, in both modes. The recess is cut exactly as deep as
you asked, nothing clamped and nothing dropped, but it is shallower than one
layer at the default 0.2 mm layer height. On a standard profile the slicer has
no layer to put it in, so it prints as bare body.

- **On a finer layer height** (0.08-0.12 mm is common for detail work) this is
  fine and the recess will print. The note can't read your slicer settings.
- **On a standard 0.2 mm profile**, raise the depth to at least 0.2 mm or the
  colour won't appear.
- Exactly 0 or less is a different case: it cuts nothing at any profile, so it
  is raised to 0.2 mm and warns rather than being noted.
- **It won't appear for a colour that only lands on a cut-through part** (the
  wheel's cap), which ignores the depth setting and holes the whole way
  through: the recess prints whatever your layer height is, so the note would
  be predicting a problem that can't happen. If the same colour is also on a
  part that cuts to depth, the note appears, and it is about that part.

## Troubleshooting: "Depth for … is not a depth that can cut" warnings

Zero or less cuts no pocket at all, and says nothing about what was wanted. Both
modes raise it to 0.20 mm, one typical layer, naming the colour and both
numbers. In assembly mode this used to drop the colour silently: no recess, no
inlay, no message.

- **Nothing is dropped.** The colour cuts, just shallowly. That matters: a
  colour cut nowhere gets no row in the colour list, which would remove the very
  depth field this warning tells you to correct.
- **The number is the setting it raised, not what each part cut.** What a part
  does with a depth is up to the part; the wheel's cap holes through whatever
  you set, so no single number is true of every part.
- To remove the colour, use "→ base" on its row. To cut it, give it a real
  depth.
- One warning per colour, not per part: depth is a per-colour setting, so a
  global **Depth** of 0 reports each affected colour once however many parts
  carry it.
- **Assembly mode bounds only the shallow end.** There is no upper limit and no
  check against the wall, which varies across a part, so a depth deeper than the
  wall in one spot cuts a hole and exports silently. "Part … has no geometry to
  export" only fires when the cut consumed the _whole_ part, so its absence is
  not a report that the depth was safe.

## Troubleshooting: "TMT Mosaic couldn't save this session. Leaving now loses it" warnings

The app autosaves your session (design, placement, colours, depths) to browser
storage after every change and offers it back next time. Reloading normally
shows nothing; the browser's "leave site?" prompt appears only when that
autosave failed.

The browser controls the prompt's wording and substitutes its own generic copy
in most cases, so what you see may not match the string above.

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
([trace.ts](../src/raster/trace.ts)) allows, so the speckle floor was raised to
exactly the size that fits and the image re-traced. Without that cap a busy
photograph hands thousands of speckle islands downstream and freezes the tab for
tens of seconds (cost measured in [tech-debt.md](tech-debt.md)).

In practice: features below the new floor were absorbed into whichever colour
surrounds them. Nothing was dropped or left as a hole, and the regions still
tile the image exactly, but fine texture is gone. That is usually right anyway,
since detail near that size is below what a 0.4mm nozzle can express.

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
  does not move that half. The flat disc and plate shapes have no such bound.
- **Crop or simplify the source.** A busy background the design doesn't need is
  what usually blows the budget.

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

The SVG counterpart of this notice ("This SVG has no size in millimeters…")
asks you to set the document size in millimetres, which is right there
and impossible for an image; hence two messages. There is
no way to give an image an exact real-world size on load. Use the Part section's
design template to check the fit, and `Scale`/`Offset` to place it.

## Troubleshooting: "This SVG has no size in millimeters…"

Full text: _"This SVG has no size in millimeters, so it was auto-fit to the part
face. Set the document size in millimeters for an exact size, or use Scale to
fine-tune."_

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
printed a quarter too small with no warning. The app now treats a size given
only in pixels as no size at all and fits the sheet to the face instead.

**Ticking "Set viewBox" on export does not fix this.** It writes
`viewBox="0 0 755 525"` beside the same `755px`, and 755px over 755 units is
just the 96 DPI assumption again: same 199.5mm, same silence. Both shapes are
rejected now.

**To get an exact size instead of a fit**, set the document units to millimetres
before exporting: Document Setup in Affinity, Document Properties in Inkscape,
Artboard settings in Illustrator. `cm`, `in`, `pt` and `pc` are trusted too.

If the sheet and the part face have the same proportions (they do for every
template the app ships), the fit is exact anyway.

**It can scale up as well as down.** The sheet is fitted to the face, so a small
mark on a large px page grows with the page: a 200px icon on a 200px page lands
at 185mm on the footrest, not 52.9mm. That is the same rule working in the other
direction, and `Scale` brings it back. A saved session re-reads the file on
reload, so a design placed before this changed comes back at the new size.

### The 1:1 variant

Full text: _"This SVG has no size in millimeters, so its true print size is
unknown. It was placed 1:1 with its coordinate units. Set the document size in
millimeters, or use Scale to correct the fit."_

The file gives no sheet to fit: no `viewBox`, and not both of width and height.
A lone `width="755px"` lands here, and so does `width="755px" height="100%"`.
Each coordinate unit is placed as 1mm, which is a guess and usually a large one.
Set the document size in millimetres, or use `Scale` to correct it by eye
against the design template.

Being visibly wrong here is deliberate. Reading that lone `755px` at 96 DPI
instead would put the design at 199.5mm on a 266mm face: plausible, printable,
and 25% wrong with nothing said. A design three times too big gets noticed.

## Troubleshooting: "The hubcap disc is too small to reach its mounting clips"

Full text: _"The hubcap disc is too small to reach its mounting clips, they
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
is loaded, it stays round until you add one."_

The **Cut to artwork shape** checkbox and the artwork on the part are the same
object by design: there is no separate silhouette upload, so with nothing loaded
there is nothing to cut to. The part stays a plain circle at the **Hubcap
diameter** size and reshapes the moment you add artwork.

## Troubleshooting: "That shape doesn't cover the hubcap's mounting clips"

Full text: _"That shape doesn't cover the hubcap's mounting clips, so it stays
round. Make it bigger, or use artwork whose middle is filled in."_

The clips need solid material under them, in a ring 10.6-16.0mm out from the
axis: the same requirement the plain-circle floor (`HUBCAP_MIN_DIAMETER_MM`)
enforces. A silhouette can fail it two ways a circle can't. It can be too small
overall, or it can have a hole or thin waist passing through the clip ring even
at a reasonable size, such as a ring-shaped logo.

Either way the part falls back to a circle rather than exporting clips bonded to
nothing. Increasing the size, or picking artwork that stays solid in the middle,
both fix it.

## Troubleshooting: "A hubcap cut to shape can only follow one design"

Full text: _"A hubcap cut to shape can only follow one design. Remove the
others, or turn 'Cut to artwork shape' off."_

With two designs loaded there is no single answer to "the shape": their union is
one option, either one alone is another, and nothing says which was meant.
Rather than guess, the part stays round. Remove the extra artwork with the ×
on its row, or turn the checkbox off to keep both as designs on a round part.

## Troubleshooting: "This image has no transparent background, so the hubcap came out as its rectangle"

Full text: _"This image has no transparent background, so the hubcap came out
as its rectangle. Export it as a PNG with the background removed to cut it to
the artwork's real shape."_

**Not a refusal.** A rectangular hubcap is a legitimate thing to want, so the
part builds. This checks for the more likely case: a WebP or flattened PNG that
lost its transparency, where what looked like a cut-out character is actually
opaque to its bounding box, so the "silhouette" is that box.

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

The named colors are dropped from the color list, the filament slot count, and the
exported 3MF's filament list: they cost nothing, they just don't print.
Bringing the design back (lower Scale, or drag it toward the face) restores
them, and their rows and slots come back with them.

If a color should be partly on the face but this fires anyway, check where the
design is anchored. An SVG with no `<circle>` boundary marker is auto-centered
on its bounding box, which a stray decorative element can move.

## Troubleshooting: "This SVG has a circle around most of the artwork, but some of it falls outside"

A design template marks its boundary with a circle drawn around everything, and on a
round part the app sizes your artwork to that circle. This says the circle is
there but something in the file sits outside it, so the circle was not used and
the design was fitted by its overall size instead.

**The usual cause is a stray filled shape**: a dot parked off to one side, a
leftover filled rectangle, a stray copy of something. It has to be filled to
count. The app ignores stroke-only objects everywhere, so a loose guide line or
an unfilled outline is not what tripped this.

**It moves the design as well as shrinking it.** The fallback centres on the
whole drawing, stray included, so the artwork comes out both smaller and
off-centre. Scale alone will not put it back; use Offset X/Y too, or remove the
stray and let the circle do its job.

- **Find what is outside the circle** and delete it. In Inkscape or Illustrator,
  select all and compare the selection bounds against the template outline.
- **Or set the fit by hand** with Design radius / Scale / Offset.

**A circle that holds little or none of your drawing says nothing**, and is not
used either. That is ordinary decoration, and clipart is full of it: suns,
balloons, eyes, polka dots. Before this rule existed the largest such circle
became the boundary, so a corner dot could be blown up to the whole face while
the rest of the design was thrown off the part in silence.

## Troubleshooting: "This shape was too big for the wheel, so it was scaled down to fit"

Full text: _"This shape was too big for the wheel, so it was scaled down to fit,
the hubcap and the artwork on it are both smaller than the size you set. Reduce
the size or the scale to take control of it yourself."_

Nothing may overhang the wheel the hubcap mounts on, which is 280mm across. A
silhouette can exceed that while its **Hubcap diameter** reading looks fine,
because that number is the longest side and a shape's corners reach further: a
square 280mm on a side reaches 198mm from the axis and hangs 58mm past the rim.

Rather than refusing, the whole placement is scaled down until it clears, and
the artwork is scaled by exactly the same factor so the picture still lands on
the shape cut for it. Without this message the symptom is the size control
appearing to stop working. Lowering the diameter or the artwork's Scale until it
clears puts you back in control.

## Troubleshooting: "Some of this shape is thinner than 1mm"

Full text: _"Some of this shape is thinner than 1mm, which is about one
nozzle wide, so those parts will be fragile. Simplifying the artwork or making
the hubcap bigger will thicken them."_

Unlike the other silhouette warnings this one does **not** fall back to a
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
for artwork in the middle of the part and wrong for artwork at the very edge:
the outline is the whole reason the part was cut to your shape, and a recess
would leave it as a 2 mm band of base colour visible from every angle except
straight on. So any region reaching the outline is cut the full 3 mm, and the
rim prints in that colour.

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
for it back, and it could not be read. The save has been removed so it will not
be offered again.

**What to do.** Reload the page before carrying on. The restore assigns settings
as it goes, so a failure part-way can leave the printer set to one value while the
picker shows another. A reload starts clean.

**Why it happens.** The stored session is JSON in the browser's local storage for
this site. It reads as valid JSON but describes something this build cannot use:
another tab or extension has written to the same key, or the session came from a
build whose settings no longer line up. Settings that simply did not exist when
the session was saved are filled in at their normal values rather than failing, so
this message means something beyond that.

A save that is damaged outright, rather than merely unusable, does not reach this
message. It cannot be parsed at all, so it is discarded on load without a banner
ever being offered.

**What it does affect.** The restore had already applied some settings before it
stopped, so what is on screen is a mix of the saved session and what you had. The
app stops saving until you reload, so this mixed state is never written back, but
it also means anything you do before reloading will not be saved. Reload first.

## Troubleshooting: "… deeper than "Wheel top" goes. It was cut at … mm instead"

**What it means.** The depth you asked for is more than that part has material
for, measured from its design face straight back. It was cut at the deepest the
part can take, a fraction of a millimetre short of breaking out the back.

**What to do.** Nothing, if the number was a slip. If you meant a deep pocket,
the part is the limit, so there is nothing to raise it to.

**This is not a wall check, and not every part has one.** A part's wall varies
across it, and a recess well under this limit can still break through a thin spot
without any warning. Some parts raise no limit at all: a design face the app
cannot measure a depth against, or a part too thin to hold the minimum. Look at
the cut in the 3D view, and in your slicer's preview, before printing. See
[tech-debt.md](tech-debt.md).

## Troubleshooting: "The prime tower … has no verified position, and every corner … overlaps a part"

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
A smaller part on the plate does too, where the size is yours to choose.

**Why it happens.** The check measures each corner against the parts' bounding
boxes, which over-reports a round part: a disc can be reported as blocking a
corner it does not reach. That is deliberate for now, since a tower printed
through a part is worse than one you place yourself, and it is written up in
[tech-debt.md](tech-debt.md).

## Troubleshooting: "Couldn't send that" in the feedback panel

The Feedback panel posts to Formspree. Two failures show there, and neither
touches your work: the app keeps running and the note stays in the box.

| Message                                                             | What happened                                                       |
| ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `Couldn't send that. Check your connection.`                        | The request never reached Formspree, or took longer than 15 seconds |
| `Couldn't send that (HTTP 429). Use the GitHub link below instead.` | Formspree answered and refused. `429` is the monthly submission cap |

- **Your note is still there.** Send again once you are back online. Nothing is
  cleared until a send succeeds.
- **A 4xx code means the form refused, and retrying will not clear it.** `429`
  is the monthly cap, `403` a form switched off. The message says to use
  **Report a bug on GitHub** in the same panel, and that is the fix.
- **A 5xx code is Formspree being down.** That one is worth retrying.
- **No Feedback button at all** means the build was made without
  `FEEDBACK_ENDPOINT` set, which is every fork. See
  [.env.example](../.env.example).
