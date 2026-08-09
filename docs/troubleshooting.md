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

**In Fill mode, don't trust the "self-intersecting path" part of the message.**
Fill unions one copy of the design per tile, and Turf 6.5 also fails on sheer
size — somewhere around 800k vertices in one operation — with the identical
warning. A design that unions cleanly as a Sticker but fails once repeated
across a chair zone (143 tiles of a 60mm pattern) is hitting the size limit,
not a bad path, and running Path → Union on it will change nothing. The tell
is that the failures arrive per-part in a batch rather than on one color, and
that the finished model carries visibly _less_ geometry than it should — the
fallback shape is coarser, so parts of the surface come out blank. The fix is
to simplify the design (fewer, larger shapes) or use Sticker mode. Measured
numbers and what closing it properly would take are in
[tech-debt.md](tech-debt.md) — "Turf's tile union has a vertex ceiling".

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

## Troubleshooting: "N AMS slots needed, but … tops out at M" warnings

The design needs more filament slots than the selected printer can address in
a single print. The count is one per cut color or merged group, plus one for
the body itself, and it's the same number the line under the color list shows.
Unlike most warnings here this one isn't a geometry problem — the 3MF is
correct and still exports; it just can't be printed in one pass on that
machine.

Which printer you have decides whether this is even reachable. Every AMS /
toolchanger unit holds 4 slots, but the Bambus daisy-chain: up to 16 on the
X1C / P1S / A1, and 25 on an H2D (24 across chained AMS units plus an external
spool on its second nozzle). The Snapmaker U1's 4 built-in toolheads don't
chain, so on that printer this warning appears the moment a design needs a
fifth slot. Past one unit but within the printer's maximum you get a quieter
note instead, saying the same thing without calling it an error — printable,
but not on one AMS.

To get the count down:

- **Merge two colors** — drag one color row onto another, or use that row's
  "Merge with…" dropdown. The group prints in its dominant member's color.
- **Print a color in the body** — "→ base" on a row moves it out of the cut
  colors entirely, so it stops costing a slot.
- **Auto-merge** raises the similarity threshold, which may or may not help:
  it merges colors that look alike rather than hitting a target count, and on
  the one real 7-color volunteer SVG measured so far only `Strong` moved the
  count at all, and only by one. See
  [tech-debt.md](tech-debt.md) — "Auto-merge is a similarity control".

Exporting anyway is supported and sometimes what you want: a single-AMS owner
can print the file with manual filament swaps at the slicer's colour-change
pauses.

## Troubleshooting: "Designs … overlap on the same surface" warnings

Two designs placed on one surface are cut independently. The body takes the
union of their pockets and looks right in the preview, but each color's inlay
is built as (part ∩ that color's pocket) — so where two designs of _different_
colors cross, the exported file carries two inlay solids occupying the same
volume, and the slicer picks between them however it likes. That is the same
failure mode as the uncut-body case above, arrived at from placement rather
than from a boolean failure, and it is invisible until the file is opened.

The warning names both designs by filename ("Two placements of …" when they
are two copies of the same file). Fixes, any of which clears it:

- **Move one of them** — drag it on the face, or use Offset X/Y. The
  warning clears once they cover less than a tenth of each other.
- **Scale one down** so it fits in a gap in the other.
- **Put them on different surfaces**, on a part that has more than one: pick
  a different zone in the artwork row's dropdown.
- **Remove one** with the × on its row, if it was loaded by accident.

A little overlap is deliberately not flagged: designs placed side by side
routinely share a millimetre or two of empty bounding box, and warning about
that would make the pill worth ignoring.

**It compares rectangles, so it can warn about designs that don't really
touch.** The check uses each design's bounding box, not its artwork — so a
logo centered inside a frame, or a caption inside a border, reads as fully
covered even though the recesses never meet and the export is fine. If that
is what you have, the warning is a false alarm and the file is safe to print;
there is no way to clear the pill short of moving the inner design off-center.
Recorded in [tech-debt.md](tech-debt.md) with what an exact check would cost.

Two designs both set to **Fill** on the same surface always warn, and get
their own message: a fill repeats across the whole surface, so the second one
lands on the first everywhere. Moving or rescaling cannot clear that one —
switch one to Sticker, put it on another surface, or remove it. A fill _under_
a sticker is not flagged: a pattern background with a design on top is a real
workflow. That combination has the same overlapping-inlay problem where the
sticker's colors differ from the pattern's; it is a known gap, also in
[tech-debt.md](tech-debt.md).

## Troubleshooting: Fill warnings — "You have one tile instead"

Fill repeats one design across a whole zone. When it can't work out how to
repeat it, it falls back to placing the design once and says why. There are
four reasons, and only the first is fixed by changing Scale — the wording tells
you which one you have. One `###` per warning string below.

### "… is too small to fill … — it would take more than 1024 tiles."

The commonest one. A pattern scaled far down against a large surface (a 5%
pattern on a chair panel) needs tens of thousands of copies, and unioning that
many hangs the tab, so the app refuses rather than freezing. **Raise Scale**
until the count comes down — a larger tile is also usually what you wanted, a
pattern at 5% reads as texture rather than as a pattern.

### "… measures zero in one direction, so there is no tile to repeat across …"

The drawing itself has no extent one way — every filled shape lies on a single
line — in a file that also declares no usable `viewBox` to fall back on. (A
missing or zero `viewBox` alone does _not_ cause this: the app then measures the
tile from the artwork's own bounding box.) There is nothing to repeat. **Use a
design with both width and height.** Such a file would also cut nothing, so if
you see this the design is not printable either way.

### "The placement … has collapsed to no width or no height."

The design's placement on the surface maps its whole tile onto a line or a point, so there
is no grid to lay. This is a placement gone wrong rather than a file problem.
**Use "Reset to auto-fit"** in the Artwork fit panel.

### "… curves too much for … to tile evenly across it."

The surface's mapping isn't flat enough for a repeating grid to stay a grid on it — copies
would land in the wrong places rather than slightly off. No shipped part does
this today. **Place separate designs on it** (Sticker mode, one per area) instead of
filling it.

### "… for a reason the app didn't record"

A refusal path reached the user without naming itself. That is a bug in the app,
not in your design — please report it.

## Troubleshooting: "Depth for … was set to … mm" warnings (flat mode)

The flat shape modes cut every recess into a plate of one fixed thickness. A
recess that reached the back of the plate would cut clean through it — a hole
where a colored inset should be — so no depth is allowed past the thickness
less the 0.05 mm floor left under the deepest recess (3.95 mm on a 4 mm plate).
This warning means one of your depths was past that and the recess was cut at
the deepest the plate can take instead.

- **The file is still valid and printable** — the depth actually cut is the
  last number in the message. Nothing is dropped; only the depth differs from
  what you typed.
- Fix it from either end: lower that region's depth, or raise **Thickness** in
  the Part section so the depth you want fits.
- The name in the message is the color list row, worded exactly as that row
  labels itself: a hex for a plain color, "Merged (N)" for a merged group, and
  "Background" for the background recess row.
- A region with no depth of its own uses the global **Depth** field, so a
  global depth larger than the plate warns for every region at once — raise
  the thickness or lower the global depth rather than editing rows one by one.
  A row carrying its own depth is highlighted and has a "↺" button beside it;
  that button, or clearing the field, puts the row back under the global. If
  the global **Depth** field seems to move nothing, those are the rows to look
  at.

Assembly mode has the same hazard at the deep end but catches it later and
words it differently, because there the wall thickness varies across the part
and the cut-through only shows up once the boolean has run: see "Part … has no
geometry to export" above.

## Troubleshooting: "Depth for … is … thinner than the usual 0.20 mm print layer"

A quiet note, not an error, and it appears in both modes. The recess is cut
exactly as deep as you asked — nothing is clamped and nothing is dropped — but
it is shallower than one layer at the default 0.2 mm layer height, so on a
standard profile the slicer has no layer to put it in and it prints as bare
body.

- **If your profile uses a finer layer height** (0.08–0.12 mm is common for
  detail work), this is fine and the recess will print. The note has no way to
  read your slicer settings, so it can't tell.
- **If you are on a standard 0.2 mm profile**, raise the depth to at least
  0.2 mm or the color won't appear.
- A depth of exactly 0 or less is a different case: that cuts nothing at all
  whatever the profile, so it gets raised to 0.2 mm and warns rather than
  being noted.
- **It won't appear for a color that only lands on a cut-through part** (the
  wheel's cap). Such a part ignores the depth setting and takes its hole the
  whole way through, so the recess prints whatever your layer height is, and
  the note would be predicting a problem that can't happen. If the same color
  is also on a part that does cut to depth, the note still appears — it is
  about that part.

## Troubleshooting: "Depth for … is not a depth that can cut" warnings

A depth of zero or less cuts no pocket at all — a request that says nothing
about what was actually wanted. Both modes raise it to 0.20 mm, one typical
layer, and name the color and both numbers. In assembly mode this used to drop
the color from the part silently: no recess, no inlay, no message, just a part
missing one of its colors.

- **Nothing is dropped** — the color cuts, just shallowly. That matters beyond
  tidiness: a color cut nowhere gets no row in the color list, which would take
  away the very depth field this warning tells you to correct.
- The message reports the depth it **raised the setting to**, not the depth
  each part cut. What a part does with a depth is up to the part: the wheel's
  cap is cut all the way through whatever you set, so no single number would be
  true of every part.
- If you meant to remove the color, use "→ base" on its row to print it in the
  body instead; if you meant to cut it, give it a real depth.
- One warning per color, not per part: depth is a per-color setting, so a
  global **Depth** of 0 reports each affected color once however many parts
  carry it.
- Assembly mode bounds only the shallow end. There is no upper limit and no
  check against the wall, which varies across a part — a depth deeper than the
  wall in one spot cuts a hole through it and exports silently. "Part … has no
  geometry to export" only appears when the cut consumed the _whole_ part, so
  its absence is not a report that the depth was safe.

## Troubleshooting: "TMT Mosaic couldn't save this session — leaving now loses it" warnings

The app autosaves your session (design, placement, colors, depths) to the
browser's local storage after every change, and offers it back the next time
you open the app. Reloading or closing the tab normally shows nothing at all
— the browser's own "leave site?" prompt only appears when that autosave
itself failed, right before the page would actually unload.

The browser controls the prompt's exact wording (it ignores the app's text
and substitutes its own generic copy in most browsers), so what you see may
not match the string above verbatim.

- **The session isn't lost yet, but leaving now would lose it.** Export a 3MF
  or the STL set before closing the tab to keep the work regardless.
- Common causes: the session grew past the app's own size ceiling (a lot of
  large SVG artwork), the browser's storage quota for this site is full, or
  you're in a private/incognito window where storage is disabled or
  cleared on close.
- Freeing space (closing other tabs on the same site, or clearing old site
  data) and reloading — the autosave runs again on the next change.

## Troubleshooting: "Some detail in … was too fine to print…"

Full text: _"Some detail in "yourfile.png" was too fine to print and was merged
into its surroundings. Lower Colors, or lower Detail, for a cleaner result."_

The notice names the image, so with several images loaded each gets its own —
and re-tracing one at a setting that no longer needs capping retracts only
that one.

An informational notice, not a failure — the image loaded and cut normally.
It appears when tracing a raster image produced more separate regions than
`MAX_COMPONENTS` ([src/raster/trace.ts](../src/raster/trace.ts)) allows, so
the despeckle floor was raised to exactly the size that fits and the image
re-traced. Without that cap, a busy photograph would hand the region pipeline
thousands of speckle islands and freeze the tab for tens of seconds (the cost
is measured in [tech-debt.md](tech-debt.md)).

What it means in practice: features below the new floor were absorbed into
whichever color surrounds them. Nothing was dropped or left as a hole, and the
regions still tile the image exactly — but fine texture is gone. That is
usually the right answer anyway, since detail near that size is below what a
0.4mm nozzle can express.

To get a result you're happier with:

- **Lower Colors.** Most of the time this is the real fix. Fewer palette
  entries means fewer boundaries, which means far fewer islands — a photo at
  4 colors reads much better as a print than the same photo at 12.
- **Lower Detail.** Detail runs the other way round from what the name
  suggests here: it sets how small a speck survives, so _lowering_ it raises
  the floor and merges the fine stuff deliberately instead of letting the cap
  do it. Raising Detail quarters the floor and makes this notice more likely,
  not less.
- **Crop or simplify the source** before loading. A busy background the design
  doesn't need is what usually blows the budget.

## Troubleshooting: "This image could not be decoded…"

Full text: _"This image could not be decoded — the browser cannot read this
format, or the file is damaged. PNG, JPG and WebP always work; TIFF never
does. Re-export it as a PNG."_

The file was recognised as a raster image from its leading bytes, but the
browser's own image decoder refused it. TMT Mosaic does not carry decoders of
its own — it hands the file to the browser — so the supported set is whatever
the browser supports.

- **PNG, JPG and WebP** work everywhere.
- **GIF and BMP** work in practice, and are accepted for exactly that reason.
- **TIFF** is never decodable in a browser, however the file was produced.
  Re-export as PNG from whatever made it.
- A truncated or partly-downloaded file lands here too. Re-download it and try
  again before blaming the format.

An SVG never reaches this message: the format is sniffed from the file's first
bytes, so vector artwork goes to the SVG parser and only raster formats come
here. That split is also what stops a dropped image from failing with "SVG
could not be parsed — check the file is valid XML", which is true but useless
about a file that was never XML.

## Troubleshooting: "This image has no real-world size…"

Full text: _"This image has no real-world size, so it was auto-fit to the part
face. Use Scale to fine-tune."_

Expected on every raster image, and safe to ignore unless the size is wrong.
A PNG or JPG carries no trustworthy physical dimensions — the DPI tags in
consumer files are almost always a meaningless 72 or 96, and honoring one
would size a phone photo at well over a metre — so the image is fitted to the
part's design face instead and `Scale` adjusts from there.

The SVG counterpart of this notice ("This SVG has no absolute width/height in
mm…") asks you to set the document size in millimeters, which is the right fix
there and an impossible one for an image; that is why they are two separate
messages. There is no way to give a raster image an exact real-world size on
load — use the Part section's design template to check the fit visually, and
`Scale`/`Offset` to place it.

## Troubleshooting: "The hubcap disc is too small to reach its mounting clips"

Full text: _"The hubcap disc is too small to reach its mounting clips — they
would print as four loose pieces. Increase the diameter."_

Unlike every other part, the hubcap is generated rather than loaded: only its
four mounting clips ship as a mesh, and the disc that carries them is built at
whatever **Hubcap diameter** is set. Those two bodies meet on one flat plane
and share no volume, so the disc has to actually cover the clips' top faces —
an annulus from 10.6mm to 16.0mm out from the axis — for the result to be a
single printable solid. Below about 21mm across, the disc lands entirely
inside that annulus, touches nothing, and the part is five separate bodies
that would come off the plate loose.

This is why the diameter has a floor of about 32mm: the size at which the disc
fully covers those faces, rather than the smaller size at which it merely
grazes them. The control clamps to it, so **you shouldn't be able to reach
this message by typing a number** — if you see it, the diameter came from
somewhere that bypassed the control, most likely a restored session saved by a
different or hand-edited build.

The fix is the one the message gives: raise the diameter. Anything from the
floor upward bonds across the whole clip face. Nothing is silently discarded
in the meantime — the warning stays up until the part regenerates at a size
that works, and it retracts on its own once it does.

Worth knowing that the failure this prevents is invisible from the app: a
hubcap whose clips didn't bond looks completely normal in the viewport, and
exports to a 3MF that opens and slices without complaint. It only shows up as
loose parts on the finished plate, which is why the check is a hard floor
rather than advice.

## Troubleshooting: "The hubcap is set to follow your artwork's shape, but no artwork is loaded"

Full text: _"The hubcap is set to follow your artwork's shape, but no artwork
is loaded — it stays round until you add one."_

The **Cut to artwork shape** checkbox and the artwork on the part are the same
object by design — there's no separate silhouette upload, so with nothing
loaded there's nothing to cut to. The part stays a plain circle at the size
set in **Hubcap diameter** until you add artwork; it reshapes itself the
moment you do, with no further action needed.

## Troubleshooting: "That shape doesn't cover the hubcap's mounting clips"

Full text: _"That shape doesn't cover the hubcap's mounting clips, so it stays
round — make it bigger, or use artwork whose middle is filled in."_

The clips need a solid annulus under them (10.6–16.0mm out from the axis) to
bond to, the same requirement the plain-circle floor
(`HUBCAP_MIN_DIAMETER_MM`) enforces there. A silhouette can fail this two
ways a circle can't: it can be too small overall, the same as the circle case,
or it can have a hole or a thin waist that happens to pass through the clip
ring even at a reasonable size — a ring-shaped logo, for instance. Either way
the part falls back to a circle rather than exporting clips that bond to
nothing; increasing the size or picking artwork that stays solid in the
middle both fix it.

## Troubleshooting: "A hubcap cut to shape can only follow one design"

Full text: _"A hubcap cut to shape can only follow one design — remove the
others, or turn 'Cut to artwork shape' off."_

With two pieces of artwork loaded there's no single answer to "the shape" —
their union is one option, but so is either one alone, and nothing says which
was meant. Rather than guess, the part stays round and this names the fix:
remove the extra artwork (the Artwork panel's list has a remove action per
row), or turn the checkbox off if you meant to keep both as separate designs
on a round part.

## Troubleshooting: "This image has no transparent background, so the hubcap came out as its rectangle"

Full text: _"This image has no transparent background, so the hubcap came out
as its rectangle. Export it as a PNG with the background removed to cut it to
the artwork's real shape."_

This isn't a refusal — a rectangular hubcap is a legitimate thing to want, so
the part builds. It's a check for the far more likely case: a WebP or a
flattened PNG that lost its alpha channel on the way here, where what looked
like a character cut out on a transparent background is actually opaque all
the way to its bounding box, and the "silhouette" is just that box. If a
non-rectangular shape was the goal, re-export the source image as a PNG with
the background actually removed (not just displayed as transparent in an
editor that doesn't preserve alpha on export) and reload it.

## Troubleshooting: "This shape was too big for the wheel, so it was scaled down to fit"

Full text: _"This shape was too big for the wheel, so it was scaled down to fit —
the hubcap and the artwork on it are both smaller than the size you set. Reduce
the size or the scale to take control of it yourself."_

Nothing may overhang the wheel the hubcap mounts on, which is 280mm across. A
silhouette can exceed that while its **Hubcap diameter** reading looks fine,
because that number describes the longest side and a shape's corners reach
further than its longest side does — a square 280mm on a side reaches 198mm
from the axis and would hang 58mm past the rim.

Rather than refusing, the whole placement is scaled down until it clears, and
the artwork is scaled by exactly the same factor so the picture still lands on
the shape cut for it. The visible symptom without this message is the size
control appearing to stop working, which is why it says so rather than doing it
silently. Lowering the diameter or the artwork's Scale until this clears puts
you back in control of the size.

## Troubleshooting: "Some of this shape is thinner than 1mm"

Full text: _"Some of this shape is thinner than 1mm, which is about one
nozzle wide — those parts will be fragile. Simplifying the artwork or making
the hubcap bigger will thicken them."_

Unlike the other silhouette warnings, this one doesn't fall back to a circle
— the part builds at the shape and size you set, because a thin spike still
extrudes into a valid solid. It's a printability notice, not a geometry
error: a 0.5mm-wide sliver is one nozzle-width of plastic standing 3mm tall,
which is likely to snap off in handling or not adhere well during printing.
Fine detail like hair spikes or thin limbs on a character silhouette are the
usual cause. Making the hubcap bigger thickens every feature proportionally,
since the whole outline scales together, or simplify the source artwork to
remove the thin part.

## Troubleshooting: "… reaches the part's outer edge, so that region cuts the full 3.00 mm through"

A note, not a problem — it describes what a hubcap **cut to your artwork's
shape** does on purpose.

The disc is a 3 mm shell. Normally a color is recessed into it at its depth
setting (1 mm by default), which leaves base-color plastic underneath. That is
right for artwork sitting in the middle of the part, and wrong for artwork at
the very edge: the outline is the whole reason the part was cut to your shape,
and a recess would leave it as a 2 mm band of base color that you see from
every angle except straight on. So any region that reaches the outline is cut
the full 3 mm instead, and the rim prints in that color.

- **It names the colors it did this to.** A color's _interior_ regions still
  cut at its recess depth — only the ones touching the edge go through. A color
  with regions in both places appears in the note and is cut both ways.
- **It overrides a depth you set yourself, at the edge only.** If you typed a
  depth for one of the named colors, that number still applies to its interior
  regions; its edge regions are cut through regardless. This is why the note
  lists the colors rather than just describing the rule.
- **It only appears on a hubcap following your artwork's shape.** Turn "Cut to
  artwork shape" off and every color goes back to a plain recess. A round
  hubcap never does this: its rim is chamfered, so the design face is inset
  1 mm from the edge and cutting through wouldn't put your color on the rim
  anyway.
- **It is not the same as the wheel's cap**, which cuts _every_ color through
  because the whole part is built that way. This rule is per region.
- **It applies to the shape's outside edge only.** If your silhouette encloses a
  hole — a letter "O", a doughnut, a character with a gap through it — the rim
  around that hole is still cut as a recess and prints in the base color. Known
  limitation, recorded in [tech-debt.md](tech-debt.md).
- **If you wanted a recess at the edge**, there is no way to opt out today.
  Moving the artwork in from the outline (Scale slightly below 100%) keeps
  every region clear of the edge, at the cost of a base-color rim.

## Troubleshooting: "Couldn't tell whether … reaches the part's outer edge"

The clipper failed while working out whether one color region touched the
part's outline, so that region was cut as a normal recess rather than through.
Everything else on the part is unaffected.

This is the safe direction to fail in — a recess is the behavior every part had
before the edge rule existed, and it prints; a through-cut where one wasn't
wanted would be a hole. The visible symptom is one color's edge stopping short
of the rim while others reach it, which is why it says so rather than staying
quiet.

Same underlying cause as the "Boolean union/subtraction failed" warnings above:
dense or self-touching line-work that the 2D clipper can't resolve. Simplifying
that color's regions, or nudging Scale slightly, usually clears it.
