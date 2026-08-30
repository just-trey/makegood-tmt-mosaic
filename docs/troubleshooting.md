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

## Troubleshooting: "Could not load the Manifold boolean engine, so assembly cutting is unavailable"

Full text: _"Could not load the Manifold boolean engine, so assembly cutting is
unavailable. "_ — followed by the browser's own error.

Assembly mode's whole cutting pipeline — clipping colors to a face, cutting
pockets, building inlays — runs on Manifold, a WebAssembly boolean engine
loaded once per session, the first time a rebuild needs it. This fires when
that load itself fails, before any part-specific work starts.

**What it means.** The dynamic load of the boolean engine didn't come back:
an interrupted or blocked network fetch, a browser or extension blocking
WebAssembly, or an unsupported browser. The text appended after this message
is the browser's own error, and is the actual detail worth reading.

**What you get.** The rebuild stops there and returns nothing: the viewport
falls back to the parts exactly as loaded, uncut. No colors cut in, nothing
exports usable geometry, until a rebuild manages to load the engine.

**What to do.** Reload the page — a slow or interrupted first load is the
common cause. If it keeps happening, note the appended error text and report
it via **Feedback** or **Report a bug on GitHub**.

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
| "Couldn't fit the inlay for color …. Its pocket is cut into the body but will print as an empty recess" | The recess is cut but nothing fills it, so that colour prints as a bare cavity.                                                                                                 |
| "Part … has no geometry to export. Its pocket cut went all the way through …"                           | The cut succeeded but left nothing: a pocket reached the part's wall thickness and went clean through. The part is dropped from the export rather than shipping a hollow shell. |

These are 3D failures rather than the 2D clip problem above, so path-cleaning is
less reliably the fix. Suspect the part mesh and the amount of fine detail
landing on it. What they are _not_ is silent: before this handling existed, the
same failures either blanked the viewport or shipped an uncut body alongside
inlays occupying the same space, which a slicer resolves arbitrarily.

## Troubleshooting: "Clipping color region to the design face failed…" (assembly mode)

Full text: _"Clipping color region to the design face failed for …. Region
left unclipped, may extend past the face edge."_

**What it means.** Before a color's shapes are cut into a part, assembly mode
clips them to the part's design face — the same 2D polygon math behind
"Couldn't merge the shapes" and "Couldn't cut color … into …" above, applied
one step earlier. When that clip itself fails (dense or self-touching
line-work is the usual cause), the region is used unclipped rather than
dropped.

**What you get.** That region is not dropped, but it is also not proven to
stay inside the part's face: it may reach past the edge into space the part
doesn't have. An unclipped region is treated as if it reaches the part's
outer edge, so it can be cut all the way through instead of recessed to its
usual depth — see "… reaches the part's outer edge…" further down for what
that looks like. Everything else on the part is unaffected.

**What to do.** Same fix as the other clip failures above: simplify that
color's source path (Illustrator/Inkscape's Path → Union), or nudge Scale.
Check the part in the 3D preview afterward — the warning doesn't say which
outcome you got.

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
it doesn't, or the flagged face is the one you actually want, check the part
in the 3D preview and in your slicer before printing: the cut is attempted,
not guaranteed correct.

**Why it's rare in practice.** Every shipped part's default face is
horizontal, so ordinary use never reaches this. See
[tech-debt.md](tech-debt.md), "The placement frame's angle is unrelated to
the face it acts on…", for which of the library's other face choices land
here and what they cut when they do.

## Troubleshooting: "isn't a watertight/manifold mesh" warnings (assembly mode)

Full text: _"Part "Top" isn't a watertight/manifold mesh, so it can't be cut
cleanly. Repair it (close holes, fix flipped faces) and retry. Exporting it
uncut for now."_

**This fails earlier than the cut warnings above.** Those happen when a clipped
_region_ comes out non-watertight. This one fires when the part's own base
mesh — before any cutting is attempted — doesn't pass Manifold's own
watertight check: an open edge, a flipped face, or some other non-manifold
defect in the mesh itself.

**What you get.** That part exports uncut: its full, unmodified shape, with no
colour recesses or inlays. Every other part in the assembly still cuts and
exports normally — this failure is per-part, not per-build.

**What to do.** You cannot fix this from the app; there is no mesh-repair tool
here. Every part comes from the built-in library (the free-form mesh upload
path was removed — see [tech-debt.md](tech-debt.md), "The custom-mesh upload
path was removed, and took a placement guard with it"), so a shipped part
failing this check is a packaging defect, not something your artwork caused.
Report it via **Feedback** or **Report a bug on GitHub**, naming the part.

## Troubleshooting: "Couldn't load this part. Reload the page to try again."

Full text: _"Couldn't load this part. Reload the page to try again."_

Shown two ways for the same cause: as a banner in the part panel once the parts
library manifest has settled, or as a dialog if you click **Load full
assembly** while it's still unreachable.

Both mean the manifest (`stl/parts.json`) either never loaded, or loaded
without an entry the selected assembly kind's roles need. Either way it is a
**broken deployment**, not a mistake you made: the app used to offer a
mesh-drop fallback here, but it was removed because the app has no way to
check an arbitrary mesh is the part it claims to be, and every verified export
placement is baked against the shipped one (see [tech-debt.md](tech-debt.md),
"The custom-mesh upload path was removed, and took a placement guard with
it").

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
corrupted or truncated download, or a file at that path that isn't actually a
3MF (a renamed STL, a differently-packaged zip).

Every part the app loads comes from its own library over a normal fetch — there
is no path for you to hand it a bad file (see the previous section on the
custom-mesh upload path's removal). So like the "Couldn't load this part"
message, this is either a one-off network hiccup or a broken deployment, not
something your artwork or settings caused.

**What to do.** Reload the page. If it recurs on the same part, report it via
**Feedback** or **Report a bug on GitHub**, naming the part.

## Troubleshooting: "Couldn't load the design zones for "…"…"

Full text: _"Couldn't load the design zones for "…" (…: …). It will load
without design zones."_

**What it means.** Some parts carry design zones baked separately from their
mesh: a sidecar file the part loads alongside its geometry (chair-body is
the only shipped part with one today). This fires when that sidecar can't be
fetched at all — a network hiccup, or a broken deployment missing the file.

**What you get.** The part still loads and displays normally, just without
any of its baked design zones: it falls back to the implicit flat zone every
part has, so it can still take a Sticker or Fill design on its largest flat
face, only not the per-surface zones the part was meant to offer.

**What to do.** Reload the page — a one-off network failure is the common
case. If it recurs, report it via **Feedback** or **Report a bug on
GitHub**, naming the part; a shipped sidecar failing on every attempt is a
packaging defect, not something you did.

## Troubleshooting: "…doesn't match the mesh its design zones were baked against"

Full text: _"Part "…" doesn't match the mesh its design zones were baked
against, so its design zones are unavailable. Re-run the zone bake for this
part."_

**What it means.** A part's design zones are baked against one specific
mesh — the same kind of fingerprint check "has no verified print placement"
further down uses for plate position, applied here to zones instead. This
fires when the loaded mesh doesn't match what its zones were baked against,
usually because the mesh was re-packed after the bake without re-running it.

**What you get.** The same fallback as the message above: the part loads
with no design zones and takes artwork only on its implicit flat zone.

**What to do.** This is a packaging defect on a shipped part, not something
fixable from the app. If you're a maintainer, re-run the zone bake (the
`bake-zones` skill) for this part after any re-pack. If you're a volunteer
seeing this on a shipped part, report it via **Feedback** or **Report a bug
on GitHub**, naming the part.

## Troubleshooting: "Design zone "…" couldn't be applied to "…""

Full text: _"Design zone "…" couldn't be applied to "…": …"_

**What it means.** Even once a part's zone sidecar loads and its mesh
fingerprint checks out, each zone still has to be rebuilt against the part's
actual vertices. This fires when that step fails for one zone specifically —
a defect in that zone's stored chart data, or a mismatch narrower than what
the whole-mesh fingerprint check above catches.

**What you get.** Only that one zone is left off the part; every other zone
it carries still loads and takes artwork normally.

**What to do.** Same as the two messages above: a packaging defect, not
something to fix from the app. Report it via **Feedback** or **Report a bug
on GitHub**, naming the part and the zone.

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

## Troubleshooting: "… colors in … were dropped…"

Full text: _"3 colors in "yourfile.png" were dropped. Raise Detail to keep
more."_

One color reads in the singular: **"1 color in "yourfile.png" was dropped."**

**An informational notice, not a failure.** The image loaded and cut normally.

The Colors slider asks the quantizer for a number of colors. Tracing then keeps
only the ones that still paint something once the despeckle floor has run
([parse.ts](../src/raster/parse.ts)), and a color whose every piece sits under
that floor leaves the palette. The readout used to show the smaller number with
nothing saying it differed from what was asked for.

- **Raise Detail.** It sets how small a speck survives, so raising it quarters
  the floor and lets the smaller pieces back through. That is the opposite of
  what "Some detail … was too fine to print…" above asks for, and the two never
  show on the same image: a capped trace keeps that notice and never raises
  this one.
- **It does not say the pieces were unprintable, because usually they were
  not.** The floor it fires under is a fraction of the image, not a nozzle
  width. At part scale that fraction is millimetres across.
- **The count is against the colors that labelled pixels, not the slider.** An
  image that simply has fewer colors than Colors asks for (a three-color logo at
  Colors 8) has lost nothing, and never raises this. Neither does a color that
  won a cluster and then labelled no pixel at all, which the blur before
  clustering can produce: nothing of it was ever traced, so there is nothing to
  bring back.
- **Placed small, nothing is said at all.** Below roughly a nozzle width per
  working pixel the placement floor binds instead, Detail moves nothing, and the
  notice would be false, so it is withheld: 128px across 12.8mm has a printable
  floor of 16px² against a fractional 2, and drops a color silently at every
  Detail. The same image at 512px across 185mm has a printable floor of 1px²,
  the no-op, against a fractional 39, and does raise the notice. Both measured
  by `npx vitest run tests/raster-parse.test.ts -t "stays silent"` and
  `-t "part scale"`. `docs/tech-debt.md` carries it, with the capped case.

## Troubleshooting: "No opaque pixels were found in this image…"

Full text: _"No opaque pixels were found in this image. There is nothing to
cut."_

The image decoded fine, but every pixel in it fell below the alpha threshold
the quantizer uses to tell artwork from background. The load fails as a no-op:
whatever design was already loaded stays exactly as it was.

- **A fully transparent PNG.** Nothing was ever drawn on it, or every layer
  that was got flattened out before export.
- **A background that reads as "empty" to the app but not to your eyes.** A
  checkerboard pattern baked into the pixels by an export preview, rather than
  real alpha, still counts as opaque background — see "This image has no
  transparent background…" under the hubcap section for the same distinction
  on a related path.

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

This is the far end of "Some detail … was too fine to print…" below: that
notice means _most_ of the image survived and a little texture was merged
away; this error means the despeckle floor ate the whole image, usually
because it is uniformly noisy (a busy photograph, heavy film grain, a scan with
visible dither) rather than made of a few solid-coloured regions.

If the design's placed size, not noise, is what emptied it, the app shows
"Nothing … is big enough to print at this size" instead — see the next
section. Raising Detail cannot help there, so it isn't offered.

**What to do**, in order of how much it usually helps:

- **Raise Detail.** This lowers the despeckle floor (see the Detail note under
  "Some detail … was too fine to print…" for why the name reads backwards), so
  smaller regions are allowed to survive.
- **Lower Colors.** Fewer palette entries means fewer, larger regions per
  colour, which is more likely to clear the floor.
- **Use a less noisy image**, or crop to the part that actually has distinct
  colour blocks. A photograph with soft gradients everywhere and no flat areas
  will keep failing here regardless of these settings.

## Troubleshooting: "Nothing in … is big enough to print at this size"

Full text: _"Nothing in "yourfile.png" is big enough to print at this size.
Make the design or the part bigger."_

Like the previous message, every traced region was smaller than the despeckle
floor and nothing survived. The difference is which floor did it: at this
design's placed size, the nozzle-width floor
([`printableFloorPx`](../src/raster/stats.ts)) was already above the ordinary
noise floor before despeckling ran, so raising Detail cannot help — Detail
never scales that half, on purpose.

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

The SVG counterpart of this notice ("This SVG has no size in millimeters…")
asks you to set the document size in millimetres, which is right there
and impossible for an image; hence two messages. There is
no way to give an image an exact real-world size on load. Use the Part section's
design template to check the fit, and `Scale`/`Offset` to place it.

## Troubleshooting: "SVG could not be parsed. Check the file is valid XML."

Full text: _"SVG could not be parsed. Check the file is valid XML."_

**What it means.** The browser's own XML parser rejected the file before the
app ever looked at its shapes: an unclosed tag, an unescaped `&`, mismatched
quotes, or a file that isn't really XML despite the `.svg` extension.

**What to do.** Open the file in a text or code editor and look for broken
markup, or re-export it from the tool that made it — a normal SVG export
rarely produces broken XML, so a hand-edited file is the likelier cause.

As "This image could not be decoded…" above notes, format is decided from
the file's own bytes, not its extension, so a non-SVG file renamed to `.svg`
lands here too: check the file really is SVG XML if this message otherwise
makes no sense for what you dropped in.

## Troubleshooting: "Shape … has a gradient/pattern fill…" warnings

Full text: _"Shape … (a <…>) has a gradient/pattern fill (not a flat color),
so it was skipped."_

**What it means.** The app only works in flat colors — that's what becomes a
printable region — so it cannot trace an element filled with a gradient or a
pattern. Rather than guess at an average color, that one shape is left out.

**What you get.** Only that shape is skipped. The number in the message
counts filled shapes in document order, so opening the file's XML/code view
and counting down to it finds the shape. Everything else in the file loads
and cuts normally.

**What to do.** In your editor, flatten the gradient or pattern to a single
flat fill (a "rasterize" or "expand" style operation, or a manual re-fill),
or accept the shape is left out — a gradient rarely reads as intended on a
3-4 color print anyway.

## Troubleshooting: "No flat-filled shapes were found in this SVG."

Full text: _"No flat-filled shapes were found in this SVG."_

**What it means.** The file parsed as valid XML, but nothing usable was left
after skipping elements with a gradient or pattern fill (see the message
above) and elements with no fill at all. Like the raster messages "No opaque
pixels were found…" and "No color regions survived tracing…" earlier in this
doc, the load fails as a no-op: whatever design was already loaded stays
exactly as it was.

**Usual causes.**

- Stroke-only line art. The app ignores strokes everywhere and looks only at
  fills.
- Every shape uses a gradient or pattern fill, and all of them were skipped.
- Everything meaningful sits inside a `<defs>` or `<clipPath>` and nothing is
  actually drawn from it.

**What to do.** Open the file in your editor and confirm it has filled
shapes, not just outlines: select all and check the Fill/Stroke panel. Give
outline-only art a flat fill first if that's what you want printed.

## Troubleshooting: "This SVG has unusually deeply nested geometry…"

Full text: _"This SVG has unusually deeply nested geometry (rings nested past
a normal depth) and couldn't be processed."_

The app resolves which shapes are holes inside which other shapes by nesting
depth — a ring inside a ring inside a ring, and so on. That resolution recurses
once per level of nesting, and this message replaces the raw "Maximum call
stack size exceeded" a browser would otherwise show when the recursion runs the
JS call stack out, so the failure names what was nested too deep instead of
reading as a crash.

**What causes it.** Thousands of concentric rings (holes-within-holes) or, for
the sibling message from the SVG parser itself — full text: _"This SVG has
unusually deeply nested groups (elements nested past a normal depth) and
couldn't be processed."_ — `<g>` elements nested hundreds of layers deep. Both
are pathological rather than something a normal export produces: a
hand-authored SVG, a generator script gone wrong, or an editor's "expand"
operation applied recursively.

**What to do.** Flatten the file in your editor (Illustrator/Inkscape's
ungroup, applied repeatedly, or Object → Flatten) before loading it. There is
no setting in the app that raises this — the recursion depth isn't currently
bounded on purpose, only caught after the fact, so a merely deep-but-normal
file (thousands of independent shapes, not nested ones) does not trip it.

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

## Troubleshooting: "Path N has broken data partway through its outline" warnings

A `<path>` element's `d` attribute has a coordinate that isn't a number, most
often a truncated or hand-edited file (a save interrupted mid-write, a value
deleted while editing the raw XML). N is that path's position among the
`<path>` elements in the file, counting only ones with a real fill — open the
SVG's XML/code view in your editor to find it.

**What happens.** The one subpath (the run of drawing commands between one
`M`/moveto and the next) that hit the bad value is dropped whole, not just the
part after it — a subpath cut off mid-draw and closed on its own would be a
shape you never drew. Any subpath completed before it is kept. Any subpath
**after** it in the same path goes too, which is what "everything from that
point on" means. Other shapes in the file are unaffected.

**What to do.** Open the file in the tool you made it in and re-save, or
re-export the design. If a shape looks like it is missing part of its outline
after import, this is why: check that path first.

An arc command (`A`) also lands here when a flag position holds something
other than `0` or `1`. Its large-arc flag written `1.0` is the common one: the
grammar reads a flag as one character, so the `.0` left over is not a flag.
The shorthand that glues a flag to the coordinate after it (`A5 5 0 1110 0`)
is fine and parses.

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
axis: the same requirement the plain-circle floor (`HUBCAP_MIN_DIAMETER_MM`)
enforces. A silhouette can fail it two ways a circle can't. It can be too small
overall, or it can have a hole or thin waist passing through the clip ring even
at a reasonable size, such as a ring-shaped logo.

Either way the part falls back to a circle rather than exporting clips bonded to
nothing. Increasing the size, or picking artwork that stays solid in the middle,
both fix it.

## Troubleshooting: "A hubcap cut to shape can only follow one design"

Full text: _"A hubcap cut to shape can only follow one design. Remove the
others, or turn \"Cut to artwork shape\" off."_

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

Full text: _"This shape was too big for the wheel, so it was scaled down to fit.
The hubcap and the artwork on it are both smaller than the size you set. Reduce
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

Full text: _"Some of this shape is thinner than 1mm, about one
nozzle wide. Those parts will be fragile. Simplifying the artwork or making
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

**What to do.** Reload the page before carrying on. Most failures stop before
touching your printer, shape or colour settings, so those are usually still what
they were. The one case that can still change something is a failure while
switching to the saved session's part: the part can already be the saved one
while its designs never came back. A reload starts clean.

**Why it happens.** The stored session is JSON in the browser's local storage for
this site. It reads as valid JSON but describes something this build cannot use:
another tab or extension has written to the same key, or the session came from a
build whose settings no longer line up. Settings that simply did not exist when
the session was saved are filled in at their normal values rather than failing, so
this message means something beyond that.

A save that is damaged outright, rather than merely unusable, does not reach this
message. It cannot be parsed at all, so it is discarded on load without a banner
ever being offered.

**What it does affect.** The printer, shape and colour settings only change once
every design in the session has come back, so a failed one usually leaves them
exactly as they were. Switching to the saved session's part happens separately,
and can still leave that part set while its designs do not come back. The app
stops saving until you reload, so nothing gets written over what you had, but it
also means anything you do before reloading will not be saved. Reload first.

## Troubleshooting: "… could not be restored from the saved session…"

Full text: _"…" could not be restored from the saved session. Load the image
again to put it back. Everything else in the session was restored."_

**What it means.** This is different from "That saved session could not be
opened…" above: the session itself was read fine, but one image inside it
failed while the app tried to decode it and re-run Colors/Detail on it —
usually a corrupted or truncated saved copy. Only that one source is lost;
every other design, and every setting, comes back normally.

**What to do.** Load that image again from your original file to put it
back. There is nothing else to fix — the rest of the session is unaffected,
name and all, so re-adding the design in the same spot is the whole
recovery.

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

## Troubleshooting: "… zones still blank" notices (assembly mode)

Full text: _"…: … of … zones still blank. Add more from the zone dropdown, or
pick "All zones" to cover every zone."_ ("zone", singular, when only one is
missing.)

**An informational notice, not a warning**, on a part offering more than one
design zone (the chair body is the only shipped example today). By default,
loading a design binds it to one zone only, since binding every zone would
recut the whole part on every nudge. This notice exists because that default
is easy to miss: a design bound to one zone of five looks like a finished
part in the viewport, right up until it's opened in a slicer and most of it
prints in the base color.

**What to do.** Either is fine, depending on what you want:

- **Add more designs**, one per zone, from each zone's dropdown.
- **Pick "All zones"** on one design to cover every zone with it.
- **Leave it as is**, if you only meant to decorate part of the piece. The
  notice just makes the coverage visible; it doesn't ask you to change
  anything.

## Troubleshooting: "Exporting with artwork on … of … zones…" warnings

Full text: _"Exporting with artwork on … of … zones. The other … zones will
print body-colored with no design."_ ("zone", singular, for one.)

This is the same coverage gap as the notice above, escalated to a red pill at
the last moment before an export downloads — easy to have scrolled past
earlier, harder to miss right before the file. It does not block the export:
the file is valid and prints fine, just with blank zones on it.

**What to do.** Same as above: add more designs, or switch one to "All
zones", if the blank zones weren't intentional. If they were — you're
decorating one panel and leaving the rest plain — there's nothing to change;
the export proceeds either way.

## Troubleshooting: "has no verified print placement" warnings

Full text: _"Part "Footrest" has no verified print placement under its part id
"footrest", so it was placed automatically. Check it in your slicer before
printing."_

**What it means.** Every shipped part's pose on the plate is normally baked
from a reference file a human checked in a slicer. This part exported without
that check, so whatever automatic placement the app fell back to has never been
verified to avoid overlaps or print cleanly. It still exports — this is a
warning, not a failure — but check it before printing.

The message ends the same way for two different reasons, and one of them is not
a defect:

- **"…has no verified print placement under its part id…"** — this part id has
  no baked placement at all. Either a new part kind hasn't had its pose baked
  yet, or the id itself is wrong. See [tech-debt.md](tech-debt.md), "Per-part
  export placement is a lookup table … not part of the part definition".
- **"…doesn't match the mesh its verified print placement was baked
  against…"** — a placement exists, but the loaded mesh's fingerprint doesn't
  match what it was baked against. This happens when a shipped part's mesh is
  re-packed without re-running `bake-part-fingerprints.mjs` afterward (see the
  `add-part` skill, "run this after every re-pack of a shipped part, not just
  new ones"). It is deliberately loud rather than silently trusting a stale
  pose — see [tech-debt.md](tech-debt.md), "The export-placement seal proves a
  mesh hasn't changed, not that anyone re-verified it".
- **"…is generated to the size you chose. No pre-verified print placement
  applies…"** is the third and unremarkable case: a part like the hubcap that
  is built to the dimensions you set has no fixed mesh for a pose to be
  verified against, by design. It shows as an informational notice, not a
  warning.

**What to do.** Check the part's position and rotation in your slicer before
printing, same as the prime-tower warning below. If you're a maintainer seeing
the mesh-mismatch form on a shipped part, that part needs its placement
re-baked, not a workaround on your end.

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
A smaller part on the plate does too, where the size is yours to choose.

**Why it happens.** The check measures each corner against each part's own
footprint, drawn a little wider than the real shape. A part with a deep notch in
it is drawn quite a lot wider, so it can be reported as blocking a corner it
leaves open. That is on purpose. A tower printed through a part is worse than
one you place yourself. The tower size the check assumes is nominal, so check
the real one in your slicer either way.

## Troubleshooting: "Rebuild failed: …"

Full text: _"Rebuild failed: …"_ — followed by whatever error the rebuild
threw.

**This is the app's last-resort catch, not a specific diagnosis.** Every
other warning in this doc is raised deliberately by code that expected the
failure it's reporting and degraded gracefully. This one instead means an
exception escaped all of that: something the rebuild didn't expect to throw,
did.

**What it means.** The text after the colon is the actual JavaScript error
message, and it's also logged to the browser console with a full stack
trace. Neither is written for a volunteer to read; both are there for
whoever investigates the report.

**What you get.** The rebuild for that attempt is abandoned. Depending on
when it threw, the viewport may show the previous build, a partial one, or
the bare uncut parts — there's no single guaranteed state, since this is
the path for the unexpected.

**What to do.** Try the rebuild again (nudge a setting, or reload the page)
— many causes are one-off. If it keeps happening, open the browser console,
copy the full error and stack trace, and report it via **Feedback** or
**Report a bug on GitHub** with that detail and what you were doing right
before it happened.

## Troubleshooting: "Refusing to write a non-finite coordinate into the exported 3MF."

Full text: _"Refusing to write a non-finite coordinate into the exported
3MF."_

You see it as `Export failed: Refusing to write a non-finite coordinate into
the exported 3MF.` — the export button's generic failure dialog wrapping this
specific refusal.

**This is a last-line-of-defense guard, not something your artwork can
trigger directly.** Every vertex coordinate is checked as the file is written,
and a `NaN` or `Infinity` anywhere refuses the write outright rather than
shipping a 3MF a slicer could silently mis-render or reject. The same check
also covers the prime tower's saved position and each plate's transform.

**What it means when it fires.** A geometry operation upstream — a boolean cut,
a mesh transform, a degenerate zero-area shape — produced a coordinate that
isn't a real number, and nothing caught it before export. This should not
happen on ordinary artwork.

**What to do.** Note what you last changed (which part, which colour, which
setting) and report it via **Feedback** or **Report a bug on GitHub** with that
detail — the message itself does not say which vertex or part is at fault, so
reproducing it is what makes the report useful.

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
