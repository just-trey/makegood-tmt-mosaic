# Tech debt

**Open** deferred work and known-wrong behavior. One section per item, each
stating what was measured, why it was deferred, and what closing it would
take. Update the relevant section instead of re-deriving the number from
scratch.

**When an item is fixed, delete its section — don't mark it `FIXED` and leave
it.** The CHANGELOG entry and the commit are the record of the fix. Anything a
future reader still needs — the measurement behind a constant, an approach
that was tried and lost — belongs in a comment next to the code it constrains,
not here: that is where someone changing the line will actually see it. Keep a
closed item only where it is still load-bearing for something open.

**Before deleting, read what the section still owes and move that out first.** A
section can be almost entirely closed and still carry the one thread that isn't
— a follow-up, an unclaimed optimization, a caveat nobody has measured. That
survives as its own section; only the closed part goes. Checking that the diff
removed only the lines you meant to remove is _not_ this check: it confirms the
scope of the edit, not that what left was finished.

## A Fill tile with no mm size is stretched to one repeat, which is what forceRect exists to prevent

`designMmPerUnit` ([src/geometry/assembly.ts](../src/geometry/assembly.ts))
auto-fits the document canvas to the design face whenever `userUnitMM` is null,
and that branch runs for `forceRect` (Fill) too. Its own docstring says the
opposite: "a tile is a real-world period: radius-driven scaling would stretch
one period across the whole design."

**Measured** on a 60-unit two-color tile against the footrest's 266x185mm face:

| The tile declares               | mm per unit | Tile period |
| ------------------------------- | ----------- | ----------- |
| `width="60mm"`                  | 1.0000      | 60.0mm      |
| `width="100%"` + viewBox        | 3.0833      | 185.0mm     |
| `width="60px"` (viewBox or not) | 3.0833      | 185.0mm     |

185mm on a 185mm face is a single repeat, so Fill produces a stretched sticker.

- **Pre-existing**, not introduced by the px-size fix. The `width="100%"` row is
  what an Affinity export has always done.
- **Not reachable with a shipped pattern.** All four in `public/patterns/` declare
  `width="60mm"`, so only a user's own tile hits it.
- The px-size fix widened the set of files that land here, which is how it was
  found.

Closing it means deciding what a periodless tile should repeat at, which is a
real product question and not a constant to invent: the design face is wrong,
1:1 is a guess, and the honest answer may be to refuse Fill and say so. It is a
different change from sizing a Sticker, which is why it is written down instead
of bolted onto that one.

## Raster status notices dedupe by filename, not by source id

`rasterCappedMessage`/`rasterTracedMessage` in
[src/raster/parse.ts](../src/raster/parse.ts) key their `notice()`/
`dismissNotice()` calls off the loaded file's name, because the message text
itself names the file for the user. Two different raster sources that happen
to share a filename (re-loading a same-named export, two different photos
both called `IMG_0001.jpg`) can land on opposite sides of the capped/traced
split, and both notices then stand at once, reading as contradictory advice
about what looks like one file.

Fixing it means separating the dedupe key from the display text (an id-keyed
entry whose rendered message still names the file), which touches every call
site of `notice`/`dismissNotice` for these two messages
(`src/ui/artworkPanel.ts`, `src/ui/artworkListPanel.ts`,
`src/state/persist.ts`) plus the `Notice` shape in
[src/warnings.ts](../src/warnings.ts). Deferred: the collision needs two
sources with an identical name loaded in the same session, which is rare, and
the existing capped-only notice already carried the same limitation before
`rasterTracedMessage` was added.

## Two of convention 19's neighbours are open, and one has a second instance

Convention 19 itself is closed in both halves. The viewport frame and its handles are `--text`,
and the three DOM instances are neutral as of the base-and-selection pass: the filament swatch
takes a two-tone ring, the artwork row takes `--text` plus `--panel-2`, and the auto-merge label
keeps its weight and drops `--accent-2`. Every measurement behind the viewport half is on
`FRAME_COLOR` in [src/scene/designGizmo.ts](../src/scene/designGizmo.ts).

**Convention 20**: greyed-back excluded geometry must not look like geometry printing in grey.
Untested either way, and the body renders `#b9c0c6`, which is a grey somebody prints in.

**Convention 21**: a meaning-carrying overlay has to be distinguishable from artwork by pattern or
motion rather than hue alone, and the placement frame's off-surface warning state is still hue
alone (amber `0xe0a33a`, which matches no token). That one is deliberately as it is: it is a
warning rather than a selection, and the comment on it defends the choice against a desaturated
alternative. The sharper version, from a conventions review of the shipped screenshots: with the
resting frame `--text` and the off-surface frame amber, **the app has two different frame
treatments in the same widget**, one on-token and one not.

**Dimming the unselected surroundings is the mechanism nobody has used**, and it is what
convention 20 asks for on its own account. Deliberately not attempted: it changes the model's
materials in an app whose subject is showing true colour. Convention 20 is the reason: the body
already renders a grey somebody prints in, so dimming risks creating the exact collision the
next convention names. "How much dim, and only while something is selected?" is a decision, not a
tweak.

**Legibility is not the thing to trade against here.** On the part thumbnail
(`src/ui/shapeThumb.ts`), the neutral measured _more_ legible than the accent it replaced: 7.3:1
against 5.3:1, where the accent's farthest shaded surface was 2.9:1, under WCAG's 3:1 non-text
minimum.

## Colors detected needs a paragraph of prose because none of its mechanisms are visible

Convention 5 of [ui-conventions.md](ui-conventions.md): prose in a panel is a symptom, and a panel
needing several sentences to explain what its controls do to each other is describing a
relationship that should be visible instead. This is the rubric's own worked example.

Measured before the copy-tightening pass: the hint ran 96 words and carried six mechanisms. Five
are still carried by copy rather than shown:

| Mechanism                                            | Why copy is carrying it                            |
| ---------------------------------------------------- | -------------------------------------------------- |
| Drag one row onto another to merge                   | Drag targets are not indicated                     |
| The ⠿ grip marks what is draggable                   | A glyph that has to be named in prose              |
| The "Merge with…" dropdown does the same thing       | Two paths to one result, neither obviously primary |
| A merged group shares one depth                      | Not shown on the group                             |
| A merged group prints in its dominant member's color | Not shown on the group                             |

The hint is now two sentences and the detail lives in the help dialog, which is where mechanism
belongs (convention 6). That is the copy fix and it is done. What remains is the reason the copy
existed: closing this means making these five legible.

**The sixth is closed.** "→ base" replaced the base while dragging a row onto the Base row added
to it: two gestures, opposite semantics, same target, and the destructive one was the button, with
the only warning in a `title` tooltip. Both now add. Nothing was lost by dropping replace, because
removing a member is what the "×" on each Base row member already does: it was a shortcut that
destroyed work without saying so, not a capability. `replaceBase` went with it.

## The placement frame's angle is unrelated to the face it acts on, and it shares the viewport with a second affordance

Conventions 13–14 of [ui-conventions.md](ui-conventions.md): a gizmo is aligned to the frame of
the thing it acts on, and only one manipulation affordance is offered at a time. Both are
reported broken — the placement frame renders at an angle with no relation to the part face, and
corner handles compete with an axis handle for the same drag.

**Measured 2026-08-24, and it is a bug, not a rendering choice**
([findings report](findings/2026-08-24-placement-frame-angle.md)). `scripts/measure-frame-angle.ts`
re-measures it. The anchor hijack that faked this in the 2026-08-16 run is fixed (PR E), so the
angle now reads honestly.

- **8 of the 18 patches the part panel offers put the frame 90.0° off the face**, across the three
  file-based design meshes. Always exactly 90.0°: `FlatZoneMapper.frameAt` returns a literal
  horizontal basis whatever the part is shaped like.
- **7 of the 8 clip the cut to exactly 0 mm².** Nothing prints there, so the build's "the cut may
  be wrong" understates it. The eighth is `wheel-hub-cap`, which sets `cutThrough` and so is not
  clipped at all; what it cuts on a sideways face is untested.
- **Every kind's default face reads 0.0°**, all four parts, read from the app rather than from the
  area ranking (`defaultPatchIdx` prefers the role's `preferFaceNormal`, and two default to rank
  1). That is why ordinary use never shows it.
- Not silent: the sideways-face warning and the "colors land entirely off the part" warning both
  fire, and the second is accurate.

Two defects left open. A third, the "face detected" line not tracking the dropdown, is fixed: the
row now recomputes it in place through `faceStatusText`.

1. `frameAt` hardcodes the horizontal basis. `faceY` already carries a fallback for a sideways
   normal, so the case is known and drawn through anyway.
2. The gizmo cannot warn: the amber off-surface state keys on `offSurfaceMM`, and the flat path
   returns `offChartMM: 0` unconditionally, so that state is unreachable on every flat part.

**Bounded, which is what keeps the fix small.** Every shipped part's default face is horizontal
because `pack-part.mjs` aligns it, so all 8 measured cases need a deliberate pick from the
dropdown, behind the "Advanced: per-part face & alignment" disclosure. An uploaded mesh has no
such guarantee and would hit both defects at its default face with no interaction at all, but the
STL/3MF drop target is only offered when the parts library is unreachable (see
`buildAsmPartRow`'s docstring in [src/ui/assemblyPanel.ts](../src/ui/assemblyPanel.ts)), so that
is a degraded-mode path rather than a normal one. Undriven either way.

The competing-affordances half (corner handles against an axis handle for the same drag,
convention 14) is separable, is a UI decision, and was not touched here. This is the last of the
group that made the viewport not behave like the direct-manipulation surface it looks like; the
other one, "Zone picking has no occlusion test," is closed (`npm run check:zone-occlusion`
re-measures it — by hand, it is not in CI).

## Changing a part's design face leaves its rotated duplicate on the old one

The wheel's Bottom half is a rotated duplicate of its Top. `asmAddDuplicate`
([src/assembly/parts.ts](../src/assembly/parts.ts)) copies `patchIdx`, `patchNormal`, `topZ`,
`boundaryLoops` and `restPositions` into the duplicate at the moment it is created, and a
duplicate's row offers pivot, angle and Remove but no design-face control of its own. Nothing
re-derives those fields afterwards, so picking a different face on the source cuts the two halves
on different faces.

Not measured beyond reading the copy list: found while reviewing the frame-angle change
(2026-08-24), which fixed the neighbouring "the panel says the wrong face" bug and made the
question obvious. This one is a wrong cut rather than a wrong label, so it is the more serious of
the pair.

Closing it means deciding what a duplicate _is_: re-derive its face from its source on every
change (the source becomes the single owner, and the copied fields become a cache), or give the
duplicate its own face control and let the two differ on purpose. The first matches how
`asmPartFaceNormal` already falls back to the source when a duplicate has no `patchNormal`. The
second is the bigger change and nothing has asked for it.

## The chair's prime-tower positions have only been verified on one bed size

All of its export placement — plate assignment, rotation, position,
the per-part brim/support/infill overrides, and now the tower — is baked by
[scripts/bake-chair-placement.mjs](../scripts/bake-chair-placement.mjs) into
[src/export/chairPlacement.ts](../src/export/chairPlacement.ts) from two
human-checked files: MakeGood's 12-plate Bambu Studio project for the poses
(the script re-verifies every shipped mesh against it before writing, worst
plate-space disagreement 0.024 mm), and a four-filament export with every
tower dragged into place for the towers. The second one had to exist
separately because the first prints in one or two filaments and never had a
real tower on it.
What's left: both shipped bed sizes have had that pass (270mm Snapmaker,
256mm A1), and the deltas are stored relative to each plate's anchor part so
they follow the part when a bed re-centers the group. Seven of the ten
transferred between the two beds unchanged, which is the evidence the
relative model works; the two wheel-mount plates (1.8mm and 3.9mm) and one
handle plate (1.2mm) did not, and carry a `primeTowerDeltaByPlate` entry for
256x256. **Any third bed size inherits the 270mm numbers untested** — the
350x320 `bambu-h2d` entry in [src/export/printers.ts](../src/export/printers.ts)
is the one that exists today, and the first non-square bed of the three.
Adding a bed means another pass:
`scripts/export-chair-examples.mjs` builds the files, and the bake takes one
`--towers` file per bed and works out for itself which plates disagree.
The caster plates stay on `suggestTowerPos` in
[src/export/threemf.ts](../src/export/threemf.ts), which is correct — they
print one filament and get no tower.
One loose end in the tooling: whether `wipe_tower_x/y` names the tower's
center or its origin corner isn't pinned down, so the export script only
checks that a tower lands on the bed, not that a given footprint clears the
edge. Both reference files put a tower at exactly x = 15 on a 256mm bed,
which a center-based check would wrongly reject.

## The caster mounts have no design zone, and settling that means settling what the "central rear brace" is

They are absent from
[scripts/zone-configs/chair-body.json](../scripts/zone-configs/chair-body.json)'s
part list — the other eleven pieces are all in it — on the chair body plan's
call that "caster mounts and wheel mounts are structural-only". (That plan was
deleted once the chair shipped; it is in git history.) That call was already
revised for half of
it: the wheel mounts now carry `left`, `right`, and `seat`. The casters are
decoratable too (10,395 mm² of flat upward face at y = 120, the same in both
variants), so this is worth revisiting.
What makes it more than adding four lines to the config: that file's `_note`
reserves a volume for "the central rear brace in the CAD assembly ... the app
has no part for it, so a zone must never grow onto it", and the bounds it
quotes (x −90..90, y 92..186, z −663..−455) are exactly the two caster
mounts' combined bounding box (x −89.9..89.9, y 92..185.6, z −662.5..−454.9,
the note's numbers rounded outward). Either the note is describing the
casters — in which case the 1.008 mm gap it protects is the gap _to_ them,
and raising `seamWeldTolMm` past it would grow a neighbouring zone onto them
as intended — or there really is an unshipped brace inside that same volume
and the note stands as written. Resolve that against the CAD assembly before
touching the tolerance, because it is the tolerance the existing seven zones'
measured coverage was tuned against; changing it re-bakes all of them.

## Assembly mode bounds a depth by the part, not by its wall

The 2026-08-24 cycle's **T0-3**, half closed.

**What was wrong.** Assembly mode had no upper bound on recess depth at all.
Depth 20mm and 9999mm on the wheel both built and exported with **zero
warnings**, while flat mode clamped and warned for the same input, and
`geometry/depth.ts`'s own comment stated the contract as "a zero is raised and a
too-deep value clamped, so both warn". That second half was false for every part
a user could select, and the flat modes leaving the UI made the unbounded path
the only reachable one.

**What is fixed.** `ZoneMapper.maxCutDepth()` bounds the setting, and a clamp is
warned about by name. The flat mapper measures how far the part extends behind
its design face **along Y, the axis `buildCutter` extrudes down**, off the loaded
mesh. Measuring along the face normal instead was tried and is wrong: on
wheel-half's -Z patch it read 139.88mm against 24.13mm of real material. A face
whose normal is not substantially along Y declines outright, since the plane
offset is then an X or Z distance and there is nothing to measure. The conformal
mapper declines too: it cuts along a normal field rather than one axis.

**What is not.** That bound is the part, not the wall. On the wheel it is
**48.45mm**, so a mistyped 9999 is caught and a 20mm pocket in a 3mm wall is not.
**The wall is what closes the rest, and nothing measures it.** A part's wall
varies across it, so a pocket deeper than the wall in one spot still cuts a hole
clean through and exports without comment. That is the open half of this item, not
a separate one: the prose that used to carry it lived in the README's limitations
list and now points here.

**Three cases decline outright** rather than guessing, and raise no warning at
all: a conformal zone (it cuts along a normal field, not one axis), a face whose
plane lands outside the mesh, and a part too thin to hold the minimum. On those
the deep end is unbounded exactly as before.

Deliberately not solved with a constant. `AssemblyPart.baseDepth` states "mm of
material behind the face this replaces" and looks like the answer, but nothing in
the build has ever read it, so adopting it would have given a dormant,
user-editable field control of cut depth as a side effect of a bug fix.

Closing it means measuring the wall under each cut region, most likely by casting
into the mesh along the cut direction, and comparing that against the setting per
region rather than per part.

## Rebuild performance needs ongoing work — this is a heavy application

The flat-mode half of this closed on 2026-08-23. `computeNetRegionsByColor`
now calls the clipping engine n-ary (`COVERED_BATCH`,
[src/geometry/regions.ts](../src/geometry/regions.ts)) and measures **1.76x
faster on the 135-path SVG**, 1.5-2.9x across the corpus, with per-color areas
unchanged (0.000% worst relative drift). See
[docs/findings/2026-08-23-boolean-pass-and-weld.md](findings/2026-08-23-boolean-pass-and-weld.md).

**The ~9s figure this section used to quote was wrong, by 4.5x.** Measured in
Chrome against the real module, the pass on that SVG took **2066ms** before
the change and 1177ms after. Nothing was found that would have made it 9s, and
the reading was never reproduced. A whole flat rebuild of that file is ~5s, so
the pass was never the majority of it either.

Two leads from this section are now settled rather than open:

- **Turf's wrappers cost nothing.** `turf.union` is a one-line pass-through to
  the same engine. A pairwise loop calling the engine directly lands within 3%
  of the pairwise loop calling Turf, on every corpus file. The win came from
  n-ary sweeps, not from bypassing Turf.
- **`cleanFeature` re-scrubbing costs nothing.** The old loop scrubbed the
  accumulator three times per shape; skipping that measured 1.02-1.06x. It was
  5-7% of the pass, and 93-95% was inside the engine.

Still open here: the Web Worker lead (doesn't reduce compute, makes the wait
invisible). Still a measured dead end: bbox pre-filtered per-shape diffs, ~2x
SLOWER than the accumulator on real artwork (full-canvas backgrounds overlap
everything) — see the comment on `computeNetRegionsByColor`.

**Do not "improve" `COVERED_BATCH` by raising it.** Never folding the
accumulator is the fastest setting on a 140-shape file and **10x slower than
the old loop at 400 shapes**, because every difference then carries every shape
above it. The constant is measured over 50/100/200/400 shapes and 8 sits on a
flat plateau; the bench that produced it is `scripts/bench-regions.ts scaling`.

The chair-body/Fill combination is an order of magnitude worse than the
number above, measured on `MOSAIC_GPU=1` production build, 2026-08-02: the
bundled `public/patterns/zebra.svg` in Fill mode on the chair's Left side
alone (one of five zones) took **405.6s** to settle, non-linear progress
(41% at t+15s, 43% at t+60s, 52% at t+180s). The same design set to "All
zones" (all five zones, the conformal-recut cost `state/artwork.ts`'s
zone-binding-default comment already warns about) did not finish inside a
900s timeout. This is the conformal-wrap + per-part CSG path specifically,
not the flat-mode boolean pass measured above — the per-part cut solids and
the cross-part zone triangulation both scale with triangle count, and the
chair's zones carry hundreds of thousands of triangles (see the "1.7 MB raw"
sidecar-size section below). See the next section for the interaction
consequence.

**Partly superseded, 2026-08-03.** Those numbers were taken against a zebra
asset carrying 13.6k vertices per tile, most of which were marching-squares
oversampling rather than shape (see "Turf's tile union has a vertex ceiling"
below). With the thinned asset the same single-zone case measures
**93.6s**, against **468.7s** re-measured on the old one — and it is doing
_more_ work, not less: 2.07M triangles against 853k, because the old asset's
tile union was failing and falling back to unmerged shapes. So a large share
of what was recorded here as "conformal-wrap + per-part CSG is slow" was one
bad asset. The path is still slow enough to want the accumulator or worker
fix above — 93.6s is not interactive — but re-measure before quoting the
405.6s figure as the cost of the pipeline itself. The "All zones" >900s
result has not been re-measured.

**Withheld from users, 2026-08-05.** The chair-body kind now carries
`withholdFill` (`src/types.ts`), so Fill and the pattern strip are not offered
on it and no user can reach the numbers above. This is a gate, not a fix: the
path is unchanged and every measurement here still stands. Clearing the flag
needs the accumulator-or-worker fix and the "Handle (left)" color loss below.
Sticker on the chair is unaffected and was measured at 19.5s for a full
five-zone rebuild on the same box, which is why only Fill was withheld.

**Don't quote that 19.5s without saying at what design size.** It used a design
covering the zones;
[docs/findings/zone-rebuild-cost.md](findings/zone-rebuild-cost.md) reproduces it
at 400% (17.0s) and measures an ordinary auto-fit sticker on all five zones at
4.0s — a 5x spread on the same path. What is paid for is pocket area, not
surfaces touched.

## The per-color union in the flat pass is one atomic sweep, bounded by nothing

`computeNetRegionsByColor` ([src/geometry/regions.ts](../src/geometry/regions.ts)) merges each
color's visible pieces with a single n-ary call. The accumulator fold beside it is capped at
`COVERED_BATCH`, so it always hands the engine a bounded call; this one hands it however many
pieces the artwork produced. The pass yields between colors, never inside one.

**Measured, and small on everything real**: 30ms across the whole corpus, 18ms worst
(`scripts/bench-regions.ts`). It is kept n-ary because the alternative costs real time: folding it
through `unionAllCooperative` instead measures dino ring at 158ms against 123ms.

The case that is not covered is a raster trace near `MAX_COMPONENTS` (800, src/raster/trace.ts)
where one shade owns most of the components. Nothing in the corpus reaches it, so the freeze is
unobserved rather than ruled out.

**Closing it means chunking the sweep, and the chunk size has to be measured, not picked.**
`COVERED_BATCH` was swept over 50/100/200/400 shapes before it was chosen; this is a different
operation (many small pieces unioned, rather than a growing accumulator subtracted) and its curve
has not been taken. Do that first. A constant copied across from the other call site would close
the finding without measuring anything, which is the failure this file exists to prevent.

## Cancel still waits for the part being cut, once cutting has started

Mostly closed by the 2026-08-24 cycle's **T0-7**, and reduced to a much smaller
claim than this section used to make.

**What was wrong.** The single check at the top of the part loop was in the wrong
phase. The cycle measured 140.4s of latency on a 6000-region wheel with the button
reading "Cancelling…" throughout, and read that as the per-part cut being
uninterruptible. It was not. Driving the same fixture and clicking Cancel at a
fixed t+10s, the readout stood at **11%** at the click, which is inside
`computeNetRegionsByColor` ([regions.ts](../src/geometry/regions.ts)) — the 2D
paint-order pass that runs before any Manifold solid exists. A check at its yield
points takes that fixture from **140.4s to 0.3s**, and is safe precisely because
that pass holds no solids.

The cycle recorded the readout climbing 24%→40% on this fixture, so it is not
stuck; the phase is simply long enough that a click at t+10s lands early in it.
Every number here comes from
[2026-08-25 cancel latency](findings/2026-08-25-cancel-latency.md), including the
40-colour run that showed the first fix doing nothing.

Two checks were added, and only one of them mattered. The per-colour one inside
the cutter loop is correct and carries its own owner over `colorPrisms`, but on
that fixture it never fired, because the time was not there. It is kept for the
case where it is.

**What is still open.** Once cutting has genuinely started, cancelling waits for
the part being cut to finish: `owned` and `partMan` are freed by hand on each
branch with no outer try/finally, so a check anywhere else in the per-part body
leaks WASM that repeated cancelling accumulates.

The 177.0 MB heap-flat figure quoted here previously was measured on 2026-08-17
against the single original call site, and is not evidence about the two added
since. Neither the `colorPrisms` catch nor the regions.ts sites have a heap
measurement behind them: the first is reasoned from ownership, the second from
there being nothing allocated to leak.

**And `computeNetRegionsByColor` is memoized on the shapes array identity**, so a
rebuild reusing a cached pass skips both of its checks. A second rebuild forced by
a depth edit was measured and still cancelled in 0.3s, so the case did not
reproduce, but that is not proof it cannot.

- **A single-part assembly still cannot be cancelled mid-cut**, nor can a press
  landing during the last part.
- **`unionAllCooperative` is still not a safe place to check.** It is shared with
  Fill's tiling, which runs inside the per-part body holding solids. This is the
  trap [src/cancel.ts](../src/cancel.ts) records, and it is why the fix went where
  it did rather than there.

Closing the rest is still one job: give the per-part loop body a `finally` that
releases what it holds. It is worth much less than it was, since the phase that
actually took minutes is now interruptible.

## The depth field cannot show a clamp that depends on the part

Half of the 2026-08-24 cycle's **T0-9**.

The field shows the depth that was asked for and deliberately does not write the
built value back: doing that pinned every row to its clamped depth, so the global
Depth field stopped reaching those rows and the warning went quiet (the reasoning
is on `shownDepth` in [colorList.ts](../src/ui/colorList.ts)).

**Fixed:** a depth of zero or less now says `raised to 0.20` beside the field.
The panel can work that out on its own, since the floor is a constant. It names
the _setting_, never a cut: a cut-through part discards the setting entirely, so
"cut at" would be false there.

**Not fixed:** a depth deeper than the part is clamped too, and the field says
nothing. That bound is `ZoneMapper.maxCutDepth()` — per part, measured off the
loaded mesh, and not knowable in the colour list, which has no part. The warning
names it; the field does not.

Closing it means carrying the applied depth out of the build on
`ColorListEntry`, which today holds only what the palette knows. It has to stay
display-only when it gets there, or it re-creates the pinning bug above.

**Also open, from the same finding:** one depth edit raises one warning per
colour. Typing `0` with four colours loaded stacks four identical pills, and on a
photograph it would stack ten. They are per-colour because the build warns as it
cuts each one; saying it once needs the loop to collect rather than announce.

## Auto-merge is a similarity control; the user's actual constraint is a slot count

The slider (`None`/`Slight`/`Medium`/`Strong` — `src/ui/colorList.ts`,
`initColorListPanel`) walks a ΔE similarity threshold, merging colors that
look alike. Measured against a real 7-color volunteer SVG on the chair,
2026-08-02: `None` → 7 AMS slots, `Slight` (the default) → 7, `Medium` → 7,
`Strong` → 6. Second data point, 2026-08-16, a 7-color test SVG on the wheel:
`None` 8, `Slight` 7, `Medium` 7, `Strong` 7. The audience's actual question — per
[docs/audience.md](audience.md) — is "I have a 4-slot AMS Lite, make this
fit," a target-count constraint, not a similarity tolerance. The near-term
fix landing now (see the plan that added this section) reconciles the
computed slot count against the selected printer's capacity and warns when
it's over, which makes the mismatch visible; it does not change what the
slider controls. Closing this properly means re-deriving the ΔE thresholds
against a wider sample of real volunteer SVGs and either replacing the
aggressiveness slider with a "fit N slots" input that binary-searches a
threshold, or adding one alongside it. Needs real artwork to tune against,
not just the one measured sample — that's the reason it's deferred rather
than done alongside the reconciliation warning.

## Two open defects in the chair / pattern-library workflow

Two of four defects the maintainer named on 2026-08-05; the other two are fixed.
Both features are withheld from the UI for the beta: `chair-body` carries
`hidden: true` and `PATTERN_LIBRARY_ENABLED` is `false`. The report is the
maintainer's, the diagnosis is not, and where the cause is confirmed it says so.

1. **Dead zones still need defining — open.** It is written up in
   [roadmap.md](roadmap.md) ("Dead zones: mark the parts of a design zone that
   are hidden by an adjacent part"). Without it a design placed across a joint
   spends filament changes on surface nobody sees.

2. **The SVG templates have odd/wrong edges — confirmed, same root as the cut
   outline.** Every shipped template in `public/templates/` is a pure `L`
   polyline with no curve commands: the zone boundary is traced along mesh
   triangle edges and emitted vertex-for-vertex. So a template's outline is as
   faceted as the tessellation under it. Two of them are also very ragged
   rather than merely faceted — `back` carries a 355-point boundary with **18
   holes**, `front` 146 points with 3 — which is what a grown-region boundary
   looks like when it stops mid-surface, and is the same boundary the cut
   clips to. Note the repo already has curve fitting for the raster tracer
   (`src/raster/curve.ts`); nothing equivalent runs on a zone boundary.

`?kind=chair-body` still reaches the chair, which the `bake-zones` and
`debug-csg-failure` skills and every chair drive script depend on. Nothing
public names that parameter: it is out of the README's `?kind=` example list.

Neither flag is the fix. Restoring the chair needs the two defects above closed;
restoring the pattern library needs the Zebra/Fill color loss below.

## A library part shipped as an STL would shade the slow way

Display shading reads a mesh's own vertex index where one exists
([src/geometry/creasedNormals.ts](../src/geometry/creasedNormals.ts)): Manifold
returns one from every boolean, and a packed 3MF carries one in the file.
Measured in Chrome, that is **8.7x** on five chair parts (234.8ms -> 26.9ms), with
616 of 864,800 pixels changed in the render and a max channel delta of 8/255:
[docs/findings/2026-08-23-indexed-crease-normals.md](findings/2026-08-23-indexed-crease-normals.md),
with the Node attribution behind it in
[docs/findings/2026-08-23-boolean-pass-and-weld.md](findings/2026-08-23-boolean-pass-and-weld.md).

The larger half of this item closed with that change, and the rest closed with
the custom-mesh upload path (below): every mesh the app now takes comes from
`public/stl/parts.json`, all 19 entries are 3MF, and all of them carry an index.

**What is left is one live branch nothing exercises.** `asmLoadPartBuffer`
offers no index for an `.stl`, because an STL records no sharing at all. Adding
an STL to the manifest would therefore put that part on three's
`toCreasedNormals`, which rediscovers the sharing by hashing every corner twice.
Pack parts as 3MF and it never comes up. Nothing enforces that.

Closing it properly means welding first, and the weld is the expensive half:
keying a soup's corners is the same work the bench prices at 358ms for the
chair, so that path lands about **1.5x** rather than 8.7x.

Whatever replaces it has to keep the crease behaviour rather than drop it. A
blanket weld plus `computeVertexNormals()` was measured and rejected: it melted
the embossed logo on the storage box. See `CREASE_ANGLE_RAD`.

## The custom-mesh upload path was removed, and took a placement guard with it

Until this release, a failed `fetch('stl/parts.json')` put the assembly panel
into a manual mode: per-role "+ Add …" buttons and an STL/3MF drop target on
every part row. It was the only way to reach `asmLoadPartFile`, and so the only
producer of `AssemblyPart.meshFromUpload`.

Removed because the app cannot check that an arbitrary mesh is the part it
claims to be, and every verified export pose is keyed to the shipped one. A
broken deployment was the only route there, so it now reports an error instead.

**What went with it, and is worth knowing before anyone reopens the path:**

- `resolvePlacement`'s `'unverified-upload'` and `'no-baked-placement'` reasons
  ([src/export/placement.ts](../src/export/placement.ts)). They existed to tell
  "the user brought their own mesh", a supported case worth a quiet info, from
  "our own asset drifted", a defect worth a warning. With no uploads the split
  has no meaning: a foreign mesh on a sealed role is now `'mesh-mismatch'`, and
  an unsealed one is `'unknown-part'`. Both warn. **Reopening uploads without
  restoring that split would report every user mesh as a repo defect.**
- The provenance ordering in `resolvePlacement`, which checked
  `meshFromUpload` _before_ `libraryPartId` precisely because a drop onto an
  auto-loaded part deliberately left the old id in place.
- `asmAdoptMesh`'s upload branch, which cleared `assetPositions`,
  `edgeCutThroughDepth` and `buildWarning` so a mesh dropped onto a generated
  role (the hubcap) replaced the part rather than being fed to its builder.

## The raster edge-density reading depends on how big the file is

**Measured**: [2026-08-19 photo cluster](findings/2026-08-19-raster-photo-cluster.md) supersedes
result 1 of
[2026-08-19 raster corpus calibration](findings/2026-08-19-raster-corpus-calibration.md). Six of
seven photographs separate cleanly from the flat cluster and the 0.285 cutoff sits in that gap;
the seventh, a balloon against a clear sky, stays inside the flat band. The size dependence below
is what is left open.

`measureImage().edgeDensity` counts the share of pixels that differ from a neighbour, and that
share depends on the size the image is measured at. `MEASURE_EDGE` caps rather than resamples, so
a source under 512px is measured at its own size and reads higher for it.

| Source                                        | Measured         | Reads                                 |
| --------------------------------------------- | ---------------- | ------------------------------------- |
| `public/patterns/zebra.svg` exported at 128px | 0.6324           | photo                                 |
| the same file exported at 256px               | 0.3661           | photo                                 |
| the same file exported at 384px               | 0.2430           | flat, and this is where it flips      |
| the same file at 512px and above              | 0.1823 to 0.2086 | flat, a noisy band and not one number |
| `red-sox-logo`, a real 300px logo             | 0.2531           | flat, 0.03 from the cutoff            |

Two flat colours at every size. Only the export resolution changed.

The `sizes` bench mode shows the same effect from the other direction, on the measurement rather
than the file: `mario` reads 0.433 (photo) measured at 256 and 0.253 (flat) at 512. That rung is
diagnostic rather than shipping, since `mario` is always worked at 1024, but it isolates the
measurement size from the file size.

**Closing it**: derive the reading from something size-independent, or measure at a fixed size the
source is always resampled _to_ rather than capped at. The second is the smaller change and would
alter what every existing threshold means, so it wants its own measurement pass.

### Still unmeasured

Where volunteer uploads land. Six of the seven photographs are CC-licensed Commons files, which is
sound for asking whether the statistic _can_ score a busy photograph high and is not a sample of
what this app receives. `FLAT_EDGE_DENSITY` (0.12) and `PHOTO_EDGE_DENSITY` (0.45) are untested by
that run, which exercised only the midpoint. Flat art reaching 0.2532 is mild evidence against the
flat endpoint.

## Colors is the one trace control still fixed, and no single value suits real artwork

**Rejected, measured**: [2026-08-20 knee detector](findings/2026-08-20-knee-detector.md). Picking
the palette size from a knee in the region-count curve is right on two of the four sources that
have a column at their shipping size, moves with working size without a trend, and costs 3.5 to 5
seconds. Supersedes the "6 of 8" reading in
[2026-08-19 raster corpus calibration](findings/2026-08-19-raster-corpus-calibration.md), which
was hand-scored off one full-resolution curve. **The problem below is unchanged and unfixed.**

Working resolution, blur and despeckle are all chosen from the image. The default palette size is
not — it is a constant, and measured across the sample corpus (`stubs/raster test/`, 2026-08-04) no
constant works. Asking for more colours than an image actually has does not return fewer, the way
it does on synthetic flat art: real files are lossy and anti-aliased, so the quantizer always finds
more tones and spends the surplus on the fringe around every edge.

Measured on the 300x300 Boston Red Sox logo, which has three real colours:

| Colors | Regions | Slots | Result                                            |
| ------ | ------- | ----- | ------------------------------------------------- |
| 3      | 37      | 4     | clean                                             |
| 4      | 56      | 5     | clean                                             |
| 6      | 364     | 7     | pale halo rings around the ring, letters and sock |
| 8      | 712     | 9     | worse                                             |

The same default is right for a five-colour cartoon (Tweety traces cleanly at 6) and too low for a
nine-colour one (Mario loses its yellow buttons at 6, and recovering them at 8 costs the blue iris
to a desaturated entry). So the harm runs both ways, but not symmetrically: too few colours reads as
a simplification, while too many reads as a defect — halos look broken, cost filament slots, and
multiply region count tenfold.

The region count looked like a usable signal for choosing it automatically, and is not: see the
rejection above. The curve is unstable across working size, the full ladder costs seconds rather
than the tens of milliseconds a quantize pass suggested, and the rule is right on two of the four
sources that have a column at their shipping size.

What closing it needs is a different signal, measured. Distinct colours surviving a coarse
quantize, or the ΔE spread of the palette, are both single-pass and neither has been looked at.
Whatever the candidate, it has to be checked on photographs, where region growth is smoothest and
any signal weakest, and the traces have to be **judged by eye**: region count cannot tell a cleaner
trace from a coarser one.

## The trace parameters are calibrated against a downscale that is no longer constant

**Measured**: [2026-08-19 raster corpus calibration](findings/2026-08-19-raster-corpus-calibration.md)
quantifies the cost; [2026-08-20 blur vs downscale](findings/2026-08-20-blur-vs-downscale.md) is an
invalid test of the fix this section proposes. Read the second before designing another.

`decode.ts` has always noted that the downscale to the working size "doubles as the first noise
filter", and the blur/despeckle endpoints in [stats.ts](../src/raster/stats.ts) were tuned with
that filter in place. It was doing more work than the note implies: a 1588px source averaged 3:1
down to 512px loses the anti-aliased fringe on every colour boundary outright.

Making the working size adaptive broke that assumption without touching the parameters. Flat art
now averages about 1.5:1, the fringe survives, and those pixels sit between two palette entries and
get assigned alternately — a cartoon's eye came back striped blue and white. Flat art carries a
one-pixel blur to compensate, and quantization was split so that the palette is discovered from the
source while only assignment reads the blurred copy (otherwise a blend tone that exists nowhere in
the file wins an entry and costs a filament slot; `tests/raster-quantize.test.ts` pins both halves).

What is still unresolved: the compensation is a constant, not a function of how much downscaling
actually happened. A small source that is never downscaled at all gets the same one-pixel blur as a
1588px one that was halved, and neither is the case the endpoints were tuned for.

**Still open, and one attempt to test it was invalid.**
[2026-08-20 blur vs downscale](findings/2026-08-20-blur-vs-downscale.md) tried to check whether the
benefit tracks the ratio by re-rendering vector patterns at several sizes. It cannot: the working
size is always 1024, and a vector baked large then filtered down gives essentially the same raster
as one baked small, so the anti-aliased fringe the compensation exists to replace is never created.
Four of the five sources' control arms do not change at all across the ladder, and the fifth moves
with its own base-blur flip rather than with the ratio. Read it before designing another test.

A valid version needs genuinely different raster pixels per rung, one large flat-art image resampled
the way a user's exports would be. `bench-raster.ts blur` is the harness for it.

What is not in doubt, from the earlier corpus run: the constant is wrong for some artwork. It
quadruples region count on `cartoon` at the size the app ships it, and across five vector sources at
a fixed working size it helps exactly one and hurts or no-ops the rest.

**Closing it** still means deciding what the compensation should be a function of, and the ratio is
the untested candidate rather than a rejected one. Whatever the test, it needs raster inputs
resampled to several sizes on disk, since no mode here can produce them, and the traces need looking
at rather than counting: region count cannot tell a cleaner trace from a coarser one.

## An empty trace says the wrong thing, and its pill never leaves

`parseRasterImage` throws when nothing survives the despeckle floor, and the printable floor
(2026-08-20) made that reachable from a placement rather than only from a noisy image: a
transparent-background image of small marks on a 32mm hubcap can come back with nothing. The
sliders no longer die on it (`artworkListPanel`'s catch puts them back), but everything the user
then reads is off:

- **The message is "try raising Detail, or use a less noisy image".** Detail cannot help when the
  printable floor is what emptied the trace, since Detail deliberately does not scale that half.
  Measured on a 256px confetti image at 0.05mm per pixel: it throws identically at Detail 0, 50 and 100. The remedy that works, make the part or the design bigger, is not offered.
- **The pill it raises is a `warn()` that nothing retracts**, so it outlives the setting that
  caused it. The capped notice next to it shows the pattern (`dismissNotice` on the next clean
  trace), but that needs a per-source identity the message does not have: it carries no image name,
  and adding one collides for two files of the same name.
- **The load path and the slider path disagree**: a fresh load reports through `reportLoadFailure`,
  which names the file in a dialog, while the slider raises an unnamed pill.

Closing it means one message with the right remedies for both causes, and one identity scheme for
retracting it. Three review rounds on this branch each produced a new defect in it, which is why it
was cut rather than patched again.

## A restore assigns state as it goes, so a throw leaves it half applied

What is left of the restore-confirm item, after the wrong-part export it caused
was fixed. Kept because the underlying shape is unchanged.

`applyRestoredSession` writes about twenty fields into `state` before the source
loop where a failure is most likely, and its caller's catch skips every DOM
refresher. So a restore that throws part-way can leave the printer set to one
value while `#p-printer` shows another, which is the same desync class as the
unknown-printer bug fixed alongside it.

Two things reduced the blast radius rather than closing it: the containers the
restore dereferences are now repaired at load (seven single-field corruptions
used to throw here, three of them wedging the app until F5), and the failure now
says so on screen and tells the user to reload. Neither makes the application
atomic.

Closing it means building the restored state into a local object and committing
it to `state` only once nothing further can throw, the way `applyRasterFile` and
the source loop inside this same function already do.

**A related notice is lost the same way.** When one source of several fails to
restore, the per-image "could not be restored from the saved session" warning is
wiped by the next SVG source in the list: `parseSVGDocument`
([src/svg/parse.ts](../src/svg/parse.ts)) opens with `clearWarnings()`. So a
partial failure, the case that warning exists for, is the case least likely to
show it. Pre-existing, and the fix is in that `clearWarnings()` contract rather
than in the restore.

Related, from the section this replaced: the 2026-08-08 cycle's **A2** (switching
part shape carries artwork across with no confirmation) is the opposite failure in
the same control. It is graded FIXED in
[review-cycles/2026-08-24-beta.md](review-cycles/2026-08-24-beta.md), and that
cycle's **C1** records why the confirm's wording is still wrong.

## `export-chair-examples.mjs` cannot reach Fill any more

Broken since #137, not by the beta narrowing, though that branch touched the
file to fix a different break in it (it selected an option the Part dropdown no
longer offers).

The script sets `.artwork-mode` to `fill`, and asserts it took. `chair-body`
carries `withholdFill: true`, so `artworkListPanel` never renders that select
at all: the step times out, and the explicit `bound.mode !== 'fill'` guard below
it would throw regardless.

What the script exists for is a Fill design across every zone, sized so each
plate's prime tower sees the swaps it really will. Sticker on one zone is not
that. So this is not a selector to update: either the chair's Fill defects close
and `withholdFill` comes off (see above), or the script needs a different way to
put several colours on every part.

## The flat-plate modes ship compiled and unrendered

`disc`, `rect`, `round` and `stl` are all still `ShapeKind`s, with their param
panels, their input bindings, [flat.ts](../src/geometry/flat.ts), the per-color
STL-set export and their branches in `store.ts` and `rebuild.ts`. None is
reachable: `renderShapeKindOptions`
([src/ui/partPanel.ts](../src/ui/partPanel.ts)) writes assembly kinds into the
Part dropdown and nothing else.

`rect`/`round`/`stl` have been unrendered since before 2026-08-02 and were
re-confirmed deliberate by review then. `disc` joined them for the beta, closing
the 2026-08-08 cycle's **A3**: it produced a plain flat cylinder related to no
TMT part, sitting in the primary picker at the same weight as four real ones.

Three consequences worth knowing:

- `#btn-export-stl` and the per-color STL-set export go with it. `setShapeKind`
  hides that button in assembly mode, so no offered part reaches it, and the
  README no longer offers it as a fallback for slicers that can't read a
  pre-mapped 3MF.
- Two `'disc'` fallbacks had to move, since a select value with no matching
  option renders blank and the next switch away is one-way: the option-list
  default in `renderShapeKindOptions`, and the retired-kind branch of session
  restore ([src/state/persist.ts](../src/state/persist.ts)). Both now take
  `firstOfferedKind()`.
- A session saved in a flat mode before this release restores onto the wheel.

Everything here still compiles and is still covered by `tests/flat.test.ts` and
`tests/depth.test.ts`. It is a maintenance question (why keep four dead panels
building) rather than a bug. The option list is what to touch if a future part
wants a flat mode again.

**"Recess bg too" is a live control that now does nothing.** `state.recessBg`
is read in exactly one place, inside
[flat.ts](../src/geometry/flat.ts), which produces the `isBackground` row the
checkbox exists to add. With no flat mode reachable, ticking it on any offered
part changes nothing and adds no row. Unlike the Margin slider, which
`updateOffsetSliderRanges` hides in assembly mode, the checkbox has no such
gate, so it is the one flat-only control still on screen. Not fixed here on
purpose: it blocks nothing, and this release's rule was to fix only what stops
a part working end to end. The fix is one line in
[depthPanel.ts](../src/ui/depthPanel.ts), mirroring Margin's.

**Worse than first recorded**: the help dialog still teaches it as working
("Check 'Recess bg too' to cut the background as well"), so the app documents a
control that does nothing. Found by the `not-ready` lens, 2026-08-24; it is
**T1-6** in [review-cycles/2026-08-24-beta.md](review-cycles/2026-08-24-beta.md).

**What `npm run smoke` no longer covers.** Four of its steps drove the disc:
switch to flat mode, override the background recess depth, export a flat 3MF,
export the per-color STL zip. They came out, since they drove UI that no longer
exists. So the flat 3MF writer and the STL-zip writer now have unit coverage
only, with nothing exercising either through a browser. The PNG-raster step was
not flat-specific and was kept, now running against the assembly part.

## Flat plate modes have no printable despeckle floor

**Unreachable as of the beta** (see "The flat-plate modes ship compiled and
unrendered"), so nothing can hit this today. Kept because reopening any flat
mode reopens it, unfixed.

The floor that stops the trace keeping detail under one nozzle width
([2026-08-20 printable floor](findings/2026-08-20-printable-floor.md)) applies on assembly kinds
only. `rasterMmPerPixel` returns nothing in disc/rect/round/STL-plate mode, so those keep the
fraction-of-the-image floor alone, which is what every mode had before.

- **Why**: a plate fits the design's drawn content (`fitTransform` over `parsed.bbox`), and that
  bbox does not exist until the trace has run. The pre-trace stand-in, the bounds of the opaque
  pixels, is wrong in the damaging direction: a stray opaque speck in a corner inflates the extent,
  shrinks mm per pixel and raises the floor over detail that would print. It was built that way and
  cut on review rather than shipped.
- **What it costs**: an 80mm disc at the 5% margin is a 72mm design, where the flat-art fraction is
  already a 0.88mm floor, so the printable one is inert at Detail 50 and would bite below about
  65mm placed at Detail 100. Small plates and scaled-down designs are the gap.
- Closing it means an extent the trace agrees with: either trace once at the fractional floor and
  re-trace when the printable one turns out to bind (two passes, ~830ms each on a photograph), or
  a cheap despeckle-equivalent pass over the alpha channel before measuring.
- Closing it now buys more than when this was written: assembly kinds also size the floor _down_ in
  mm ([2026-08-24](findings/2026-08-24-despeckle-floor-recalibration.md)), so a flat plate keeps a
  fractional floor that over-prunes detailed flat art (mario: 55mm² of print on a wheel-sized
  plate), not just the missing nozzle floor.

## The printable despeckle floor is fixed at the moment of the trace

`rasterMmPerPixel` ([src/state/artwork.ts](../src/state/artwork.ts)) reads the placement when an
image is traced, which is at load and again whenever Colors or Detail re-runs it. Nothing else
re-traces, because a trace measured ~830ms on a photograph and a slider drag would fire it per
step.

**Every input to the floor can move afterwards, and Scale is the smallest of them**: hubcap
diameter (32mm to the plate's short side, up to 270mm), the wheel's Design radius, switching
assembly kind, and the one-click Sticker/Fill switch, which changes the scale _rule_ rather than a
number. Scale itself only spans 25-400%. "+ add to another zone" is the quickest of all: it places
a second instance at 100% against a trace made for a smaller one, so the largest-instance rule the
floor was chosen by is stale the moment it lands. A hubcap cut to artwork shape adds one more: the
floor is read before the new source is registered, so it sees the _previous_ design's silhouette
face. And within the Scale field's 550ms typed debounce, `ArtworkInstance.scalePct` still holds the
old value (only a rebuild syncs it), so a Detail nudge inside that window sizes the floor from the
scale before the one just typed.

- **Getting smaller after loading** leaves the older, more permissive floor: features under a
  nozzle width survive that a fresh trace would remove. That is the pre-2026-08-20 behaviour, so it
  is a missed improvement rather than a regression.
- **Getting larger is the one that loses something**: detail removed at the size it was traced for
  would print at the new size. Load onto a 32mm hubcap and raise it to 220mm and it is gone, with
  nothing said. Only a nudge of Colors or Detail brings it back.
- The help panel now says to nudge Colors or Detail after a big resize, which is a note in a
  dialog, not the app noticing. Nothing in the panel that did the resizing says anything.
- Closing it means re-tracing when the placed size moves far enough to matter, which needs the
  debounce and the cancel path the Colors and Detail sliders already have, or a notice that says
  the design was traced for a different size.

## Restoring a session re-traces every loaded image

Session restore used to do no image work at all, because images were not saved. They are now, as
the working copy re-encoded to PNG, so restore has to run quantize and trace over each one before
the app is usable. On a 512px photograph that stage measured ~830ms
([bench-raster.ts](../scripts/bench-raster.ts)); the round trip on a 96px test image is
imperceptible. Several photographs in one session would add up.

It happens inside the overlay the restore already shows, so it reads as a slower restore rather
than a hang. Closing it means caching the traced result alongside the pixels, which is a much
larger payload (the parsed regions, not a PNG) and would put the 4MB `MAX_BYTES` ceiling back in
play, so this is a deliberate trade rather than an oversight.

Sizes behind the choice, measured 2026-08-17 in this app: raw RGBA at 1024x1024 is 4.0MB, which is
the whole session budget. The same pixels as PNG are **24KB** for flat art and **703KB** for a
photograph; as WebP q92, 4KB and 108KB. PNG ships because it is lossless: a lossy copy would shift
colours before the quantizer sees them, and the design could come back with a palette, and so a
filament list, the user never chose.

## The chair's zone sidecar is 1.7 MB raw / 638 KB gzipped

(`public/stl/chair-body-zones.json`), up from 125 KB gzipped when each zone
stopped at one part. Zones that span the whole chair simply carry more
triangles. Measured composition: 41% `chartTris`, 30% `uv`, 16% `tris`, 9%
`verts` — so it is mostly index arrays, and rounding the UVs buys little.
The real fix is delta-encoding the index arrays and/or a binary format;
brotli alone would take it to 349 KB if the host serves it. Not urgent (it
loads async, after first paint, and only for the chair) but it is the
largest asset in the app. Don't quantise UVs below ~0.01 mm to chase this:
two chart vertices closer than the quantum would collapse into a
degenerate UV triangle and the warp's barycentric lookup divides by its
area.

## `CHART_SNAP_MM` tracks a bake artifact instead of guarding placement

A
part's baked claim on a zone (`subRegions`) is slightly more generous than the
triangulation inside it, so the claim outline pokes narrow tendrils past the
end of the chart. Cutter vertices landing in one are legitimate artwork with
no triangle under them, so the snap tolerance has to be wide enough to absorb
the deepest one — 2.150 mm on the shipped bake — which is why it is 3 mm
rather than the sub-millimetre value a pure misplacement guard would want.
Fix: re-bake so each claim matches its triangulation, then tighten the
constant. Deferred because it invalidates every downloaded template and the
sidecar. Until then `tests/chair-zones.test.ts` pins the measured worst case;
**measure it by hill-climbing, not by rastering** — the depth is a distance
function, so a step-_h_ grid under-reports the peak by up to _h_/√2, and a
1 mm raster put the worst at 1.915 mm against a true 2.150 mm.

## A seam sliver warns as if artwork were lost

Where two parts' claims on
a zone overlap, clipping a color to one part's `subRegions` can leave a
remnant a fraction of a millimetre wide. It survives the turf clip, then
yields no cutter, and
[src/geometry/assembly.ts](../src/geometry/assembly.ts) reports "Couldn't cut
color … into …. It won't print there." — alarming, and indistinguishable from
the real failure it shares a message with. The overlaps are inherent to per-part
clipping and small — measured across the shipped bake, 23 overlapping part
pairs, all seam-sharing, worst 29.85 mm² on a 124,500 mm² zone (a ~0.15 mm
ribbon), and `tests/chair-zones.test.ts` holds them under 0.05% of zone area.
Fix: drop a clip remnant under an area floor _before_ `buildCutter` rather
than attempting it and warning. Pick the floor above the measured ribbon and
well under anything printable.

This bullet used to cite the 2026-07-28 "Seat back (bottom)" warnings as a
confirmed sighting. Instrumenting the running app on 2026-07-31 showed that
those had a different cause — cutter vertices landing outside the snap
tolerance, since fixed — and that they looked permanent only because warnings
were never cleared per rebuild, also since fixed. So the seam remnant is still
real geometry and still reaches `buildCutter`, but **no warning has actually
been traced to it**. Confirm one before spending the fix on it.

A deliberate hunt on 2026-08-08 failed to produce a sighting —
[docs/findings/seam-sliver-sighting.md](findings/seam-sliver-sighting.md), 18
checkerboard configurations across three cell densities, two scales and
sub-millimetre offsets, then a finer rotated pass recording triangle and color
counts so "no warnings" is a statement about a build that demonstrably ran. Zero
cut-solid warnings throughout. That is not proof the remnant can't warn, but it
is the cheap attempts already spent — read it before repeating them.

## Artwork can't wrap unbroken from one flank around the back to the other, and three ways of fixing it are measured dead ends

The chair carries `left`, `right` and `back` as three zones, so a design
placed on one stops at the zone boundary. Two approaches were prototyped and
measured against the shipped bake; both lose, for different reasons, and the
numbers are recorded here so nobody re-derives them.

**A cylindrical band** (unwrap left→back→right about the chair's vertical
axis, like a label on a bottle). The geometry cooperates in one respect: a θ
histogram over the three zones' 35,320 triangles shows a **64°-wide empty
sector centred on +Z**, the chair's front opening, so the wrap seam lands
where there is no surface. The best-fit axis is x −0.26 (on the centreline,
as symmetry demands), z −297.27, with an area-weighted mean radius R₀ of
231.29 mm. But the chair is not a cylinder: only **39.8%** of the band lies
within ±10% of R₀ and per-part radii run 0.73–1.62 × R₀. Real per-edge
stretch, measured with the same metric `orientChart` reports, at a 45°
outward limit: **max 2.113, mean 1.0800, 27% of edges past the
`DISTORTION_WARN = 1.1` the bake already flags** — and that buys only
**69.6%** of the surface the three zones carry today. A radius-profile
variant (u = r̄(y)·θ) is far worse (max 11–16): r̄ changes too fast where the
wheel mounts give way to the storage boxes.

**One merged LSCM zone.** The standing objection to this — "the exterior
wraps into a U and `lscm` needs disk topology" — is **wrong**: the same 64°
gap means the band never closes, so it is a strip, and a strip is a disk. It
does unwrap, cleanly by every metric the bake reports: one island, **0
flipped triangles**, max stretch **1.540** / mean **1.0242** over 100% of the
surface (p99 is 1.152; only 2.14% of edges exceed 1.1), sidecar _smaller_ at
1675 KB. It still fails, on something the bake does not measure — **UV
injectivity**. LSCM is only locally conformal, so `flipped == 0` rules out
local inversion but not the chart folding onto itself globally. Chart area
covered by more than one triangle:

| zone                                  | self-overlap           |
| ------------------------------------- | ---------------------- |
| shipped `left` / `right` / `back`     | 0.11% / 0.04% / 0.03%  |
| `front` / `seat` (untouched controls) | 0.01% / 0.01%          |
| merged band                           | **4.85%** (15,976 mm²) |

On that 4.85%, `ConformalZoneMapper.lookup` finds two triangles and takes
whichever its grid search reaches first, so artwork cuts onto the wrong sheet
of surface — worse than the seam it removes. 91% of the overlap is _self_
overlap within four parts (the two handles and two storage boxes), not
part-against-part.

**There is no angle window between the two failures.** At the shipped
45/35/45 the band is connected and overlaps 4.85%; at 40/32/40 it is still
connected and still overlaps 4.58%, for 12% less surface; at 32/28/32
`assertSingleIsland` fails with 10,891 of 25,515 triangles reachable. Loose
enough to stay one island means it folds; tight enough not to fold means it
severs. The link between each flank and the back runs through the handle's
curved corner, which is both what forces the fold and what only survives at
loose angles.

**Cross-chart registration** — keep the three charts, but let one placement
span them by giving each chart a rigid offset into a shared band coordinate,
so continuity is carried across the boundary instead of by a single injective
unwrap. This is the option the two failures above leave open, and the one
that does not need the band to be a single chart at all.
The transform is real: the best-fit rigid UV motion from `left` to
`back` comes out at **−0.1° rotation, scale 1.0074, 1.26 mm rms** (`right`
0.0°, 1.0062, 1.26 mm), all comfortably inside `CHART_SNAP_MM` and plausibly
inside what the printed assembly delivers anyway.

It fails on the boundary, not the maths. `left` and `back` share **10
vertices** — two ~11 mm fillet arcs at y≈346 and y≈454 on one handle, about
22 mm of contact on zones spanning 500 mm of height. They share **zero**
vertices on the storage boxes, the largest flank surface, because that corner
turns **89.6°** (86.3° on the handle) while the two zones' limits sum to 80°:
there is a wedge of surface orientation neither zone accepts, ~28 cm² on the
storage box and ~92 cm² on the handle, and that unclaimed wedge is what keeps
them apart. Widening `back` 35°→45° so the limits sum past the corner
densifies the contact to 55–64 shared vertices and tightens the fit to
**0.97–1.03 mm rms**, but does not lengthen it by a millimetre: it stays
inside y 337–462 with **17 gaps over 8 mm** in it. A design registered across
that would flow through the handle posts and stop everywhere else — which
reads as broken, where today's clean stop reads as deliberate.

**Correction to the paragraph above: for a single zone, stretch binds long
before injectivity does.** Injectivity is the constraint on _merging_ zones,
not on widening one. Widening the flanks 45°→50°, measured against the
shipped bake:

| zone        | max stretch | mean stretch | UV self-overlap |
| ----------- | ----------- | ------------ | --------------- |
| `left` 45°  | 1.224       | 1.0142       | 0.11%           |
| `left` 50°  | **2.543**   | **1.2342**   | 0.06%           |
| `right` 45° | 1.226       | 1.0159       | 0.04%           |
| `right` 50° | **3.470**   | 1.1170       | 0.05%           |

Overlap stays clean at every setting; stretch doubles for 5°. So the config's
own coverage-against-stretch framing is right for the per-zone angles after
all — it is only the _three-way split_ that injectivity explains. Widening
`back` alone is likewise not the free win it looks like: 35°→45° adds 30% more
triangles but only **+5.4% area** (960 → 1012 cm², the extra triangles being
fillet detail) while max stretch goes 1.134 → 1.581.

What is left is a different parameterization family — cone-singularity methods
(BFF, OptCuts) rather than plain LSCM, aimed at low stretch under wide normal
spread. That is a substantially bigger change than any of the three
prototypes, and nothing today needs it: `left`/`right`/`back` at the shipped
angles are close to the best plain LSCM does on this geometry.

One latent bug found and deliberately **not** fixed: `classifyRegions` in
[scripts/lib/zonebake.mjs](../scripts/lib/zonebake.mjs) decides outer-vs-hole
by containment depth parity, which is right for nested SVG subpaths but wrong
for triangulation boundary loops — a concave part slice has solid lobes
sitting inside another loop's ring, and parity calls them holes. It cost the
merged zone 26% and 60% of the two handles' claims. Every shipped claim
matches its triangulation within 0.3%, so it does not affect the current
bake; classifying by winding sign instead is the fix if a future zone ever
trips it.

## A part seam is a hairline the zone pick can't be aimed into

Introduced by the occlusion test in [src/scene/zonePick.ts](../src/scene/zonePick.ts), and the
price of it. Each part's zone chart stops at that part's own edge, and the chair's parts meet
across a printed clearance whose widest measured value is 0.530mm — the chair's real seat-centre to
seat-back gap, recorded in the `_note` of
[scripts/zone-configs/chair-body.json](../scripts/zone-configs/chair-body.json). Not
`seamWeldTolMm`, which is **0.6**: that is the tolerance picked to clear the gap, and anyone sizing
a bound against the wrong one of the two gets it wrong by 70 microns. A ray aimed
exactly down a seam therefore passes _between_ the two charts, lands on the far part's chart, and
finds the near part's edge wall in front of it — so the pick is correctly rejected, on a surface
that renders as continuous. The result is a thin dead line along every seam.

Measured 2026-08-08 by `npm run check:zone-occlusion` on the chair, `MOSAIC_GPU=1`, ANGLE D3D12
(RTX 2060), 1748-sample grid at four viewpoints: **one** sample, at the centreline seam of the
back panel, **3 px** of unpickable width. Nothing at the other three viewpoints. That check
excuses a run up to `CLICK_MOVE_TOLERANCE_PX` (5px, the pointer slop the click model already
treats as the same place) and fails anything wider, reporting the measured width either way — so
this getting worse is a failing check, not a silent drift.

Not worth fixing at 3px, and the two ways to would both cost more than they buy: widening
`OCCLUSION_TOL_MM` past the seam clearance would also stop a genuinely adjacent part from
occluding anything, and closing the gap in the pick surface means welding the charts across seams
at runtime, which is the bake's job and would re-open the injectivity questions the zone split
exists to avoid. Revisit if a future part's clearance is large enough to make the line visible.

## A Fill under a sticker overlaps just like two stickers do, and isn't checked

The overlap check in
[src/geometry/designOverlap.ts](../src/geometry/designOverlap.ts) compares
two stickers by their placed footprints and then by how much of each one's
ink reaches the footprint they share, and treats two Fills on one zone as
always overlapping. It deliberately says nothing about a Fill paired with a
sticker, because a pattern background with a design on top is a real
workflow and flagging it would fire on the intended use.

But the geometry doesn't care about intent: the sticker's pockets and the
fill's pockets are separate cutters, so wherever the sticker's colors differ
from the pattern's underneath it, the export carries two inlay solids in the
same volume — exactly what the sticker-vs-sticker warning exists for. It is
unmeasured: no export of that combination has been opened in a slicer to see
what actually prints, and the app ships no example using it.

Two ways to close it, neither cheap enough to bundle with the check that
prompted this note. (1) Make it correct rather than warned: subtract the
sticker's pockets from the fill's before the inlay intersection, so the
background yields to what sits on it. That is the behavior a user expects,
and it makes the pairing supported instead of merely tolerated — but it is a
per-color boolean on the fill's full tiled region, on the path already
measured at 405s for one chair zone (see the rebuild-performance section).
(2) Warn only where the fill's ink actually lies under the sticker. The
plumbing for that now exists: `placedInk` in
[src/geometry/assembly.ts](../src/geometry/assembly.ts) hands the sticker
comparison each design's placed cut regions. A fill's are the tiled ones, so
this still needs the grid, and the check would have to stop skipping the
mixed pair. Start by measuring (1) on the wheel, where the fill region is
small enough to time honestly.

## The instance cascade still seeds a silent overlap in two measured cases

`cascadedOffset` ([src/state/artwork.ts](../src/state/artwork.ts)) steps a new
design diagonally off one already at that spot. The step used to be a flat 8mm;
it now scales to the largest design on the surface, capped at
`CASCADE_CLEAR_MAX_MM` (11.7mm, derived from `INSTANCE_CASCADE_MM` and
`OVERLAP_WARN_FRACTION`). Where that applies, every pair on the surface lands
clear. Two cases it does not reach, both measured:

| Case                                    | What happens                                                                                                                                                                                                                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anything over 11.7mm shares the surface | The step falls back to 8mm for everything on it. Two 10mm designs beside the wheel's 276mm default land 8mm apart, 4% covered, under the warn threshold                                                                                                                                  |
| Two designs of opposite proportions     | Both measure the same across their narrow axis, so no clearance derived from that parts them. It does not take extreme shapes: an 8x11.5mm design and an 11.5x8mm one both read 8mm, step 8mm, and cross in 3.06mm², 3.3% of either. A 5x200mm bar against a 200x5mm bar crosses in 2.5% |

Neither is a regression: both behave exactly as the flat 8mm step did.

**Why a bigger or smarter constant does not close it.** Any single step `s`
leaves a silent band from `s` to `1.4625s`, since two `w`-wide designs only
reach `OVERLAP_WARN_FRACTION` at `w >= s/(1-sqrt(fraction))`. One step per
surface is forced: a step chosen per design puts a later small one between an
earlier big one's lattice spots and wholly inside it (measured, and pinned by
"does not park a small design inside one already cascaded past it" in
`tests/artwork.test.ts`). So the band can be moved but not removed.

Reading the clearance off the wider axis instead of the narrower one parts the
opposite-proportions pair, at the cost of moving every shaped-alike pair further
than it needs to go. It is a defensible swap, not a fix: the band above stays
either way.

**What closing it takes.** Drop the lattice. Search for the nearest free
placement given the two designs' actual placed footprints, rather than stepping
a fixed distance and testing for an exact-spot collision. That is a real
placement search and wants its own change, not a wider constant.

## A traced image can lose a color with nothing said

`parseRasterImage` narrows the palette to the colors that actually paint something, and since
2026-08-20 the despeckle floor removes far more than it used to
([2026-08-20 despeckle floor](findings/2026-08-20-despeckle-floor.md)). Five of nineteen corpus
sources come back with fewer colors than the Colors slider asked for: gravel 8 to 5, foliage 8 to
7, dalmatian and zebra 4 to 2 and 3, the cartoon 6 to 5.

- **Correct, and silent.** Those colors were only ever painted in pieces under the printable floor,
  so the narrower list is the honest one. Nothing says so: the readout shows the number it found,
  and the user has to notice it differs from the number they asked for.
- The `capped` notice ("Some detail was too fine to print and was merged") covers the
  `MAX_COMPONENTS` case only, which now fires much less often, and its remedy (lower Colors, lower
  Detail) is backwards for this one.
- Closing it means deciding whether a dropped color is worth a notice at all, and if it is, saying
  it in a way that does not fire on every photograph. Raising Detail is the remedy that fits.

## `MAX_COMPONENTS` is a target, not the bound its name implies

`traceLabelMap` ([src/raster/trace.ts](../src/raster/trace.ts)) raises the despeckle floor when the
component count exceeds `MAX_COMPONENTS` (800), then never rechecks. The raise now reliably cuts
the count, which it did not before 2026-08-20
([2026-08-20 despeckle floor](findings/2026-08-20-despeckle-floor.md)), but it still does not bound
it. Two ways past the cap, both after the count was taken:

- **Absorbing specks merges them into each other**, minting components above the new floor. So
  putting the floor above all but the largest 799 does not leave 799. Reproduces on a speck field
  handed straight to `traceLabelMap` with a high floor. **Not reproduced through the real decode
  path since the despeckle fix**: the pixel art that looked like it did reads as photographic at
  the measurement size (0.3045), so the app traces it at 512px, where the raise fires and 78
  components come back. Whether a decodable image can still get past the cap is open.
- **`deChecker` breaks 2x2 checkerboards by rewriting one cell**, which can shave a pinch point and
  split a surviving component in two. Off-corpus it is common: about 8% of random label grids come
  back with a component under the floor the trace reports, against 0% straight out of `despeckle`.
  No corpus source does it, so what it costs a real image is unmeasured. Swapping the order is not
  the fix, since `despeckle` relabels whole components and can create the checkerboard `deChecker`
  exists to remove, and a self-touching ring is the worse failure.

- The cap is a performance guard on `shapeToFeature`, so being over by a few hundred on a
  pathological source costs time rather than correctness.
- Closing it: loop the raise until `realCount()` is actually under (and decide what a second raise
  does when a `deChecker` split is what pushed it over), or rename the constant and the flag to say
  what they do. `capped` today means "a raise happened", not "the count is under".
- The bench's `despeckle` mode checks the floor and the cap on every row, but only over CORPUS, so
  its cap line has never had a source that could trip it. Both columns also read the components the
  trace _returns_, which is fewer than the count it capped on: background components and any whose
  ring collapsed are already gone. A transparent speck left under the floor would be a real defect,
  and this guard would miss it.

## The extrude repair never runs on a conformal zone

`ConformalZoneMapper.buildCutter` absorbs an invalid prism inside `tryWarp` and returns `null`, so
`soup` is falsy and the whole repair block in
[assembly.ts](../src/geometry/assembly.ts) is skipped. The escalating erode ladder that fixed a
lost color on the wheel therefore buys the chair body nothing: a flat zone gets two attempts at
repairing a self-touching region, a conformal one gets none and goes straight to the warning.

- Surfaced by the fix for "Couldn't cut color … into …" on the wheel, which is a
  `FlatZoneMapper`. Measurements and wrong turns:
  [2026-08-20 extrude repair erode](findings/2026-08-20-extrude-repair-erode.md).
- The asymmetry is pre-existing and is acknowledged by the comment beside the warning, which
  describes the conformal case as "the warp found no surface under part of the region".
- Whether the chair body actually hits self-touching regions is **unmeasured**. The pattern library
  and chair body are both hidden from the UI, so nobody has driven dense artwork through a
  conformal zone to find out.
- Closing it means either giving the conformal mapper the same retry, or establishing that its
  null return means something different enough that a retry would be wrong.

## Keep `@turf/turf` pinned to 6.5.0 — v7 is a measured perf regression here

A 7.3.5 upgrade was fully implemented and benchmarked (2026-07):
correct output, but its new polygon-clipping engine ran **5–10x slower**
on this app's union-accumulation hot path (40ms → 215ms at 20 shapes,
76ms → 726ms at 120), turning slow rebuilds into multi-minute ones. Don't
re-attempt without benchmarking that path first. The 6.5 quirks remain:
the boolean-failure workarounds in
[src/geometry/regions.ts](../src/geometry/regions.ts) (degenerate-ring
scrubbing, precision-truncation retries) target 6.5's exact
polygon-clipping bugs, and 6.5's package typings don't resolve under
modern TypeScript, hence the shim in [src/turf.d.ts](../src/turf.d.ts).

**Nothing re-measures this on demand.** The 5–10x figure came from a one-off harness built for
that attempt and not kept, so the pin is enforced by prose and an exact `package.json` version. A
standing `bench-geometry` script is deliberately not built: it would only ever be exercised by an
active turf upgrade, and writing it now costs about what re-deriving it later costs. When an
upgrade becomes live work it is step one rather than an afterthought, over the
union-accumulation path at a few shape counts, with the numbers above as the baseline to beat.

## The export-placement seal proves a mesh hasn't changed, not that anyone re-verified it

`PART_FINGERPRINTS` is generated
([scripts/bake-part-fingerprints.mjs](../scripts/bake-part-fingerprints.mjs)),
and re-packing a part without resealing is caught loudly — the seal test
in [tests/placement.test.ts](../tests/placement.test.ts) fails. The gap is the
step after: resealing is a single command that will happily re-bless a mesh
whose print pose nobody re-checked in the slicer, which is exactly the
motion someone takes to make the failing test go away. It is deliberately
_not_ wired into `pack-part.mjs` for that reason (auto-resealing would
delete the tripwire), so the guarantee rests on the reminder that script
prints and on the add-part skill. Closing this properly means recording
_what_ was verified — the reference file and its hash — alongside the mesh
fingerprint, so a reseal against an unchanged reference is distinguishable
from one that silently redefines the verified pose.

## Per-part export placement is a lookup table in [src/export/placement.ts](../src/export/placement.ts), not part of the part definition

It used to be an `if (roleId === …) else if …` chain; the
chair's fifteen pieces turned that into a `PLACEMENT` record keyed by
library part id, so adding a part is now a data change rather than a code
one. It still lives apart from the role it describes, though, which looks
like it belongs as data on the `AssemblyKind` / role definition instead,
matching the "one array entry" goal in
[src/assembly/kinds.ts](../src/assembly/kinds.ts).

**That move fights a deliberate choice, so it is a decision, not a refactor.**
The table's own provenance comment
([src/export/placement.ts:33](../src/export/placement.ts#L33)) explains why it
is keyed by library part id rather than role: the chair's two caster roles
resolve to a different mesh per hardware variant, and Standard/Kit sit on
different plates, so a role-keyed table would collapse two verified
placements into one slot. Moving placement onto the role either has to solve
that collision or accept losing the per-variant distinction. Re-scope with
that in mind, or close this as won't-do and let the comment stand as the
answer.

## Real malformed input never reaches the CSG failure branches

Every branch is now driven against the real Manifold engine:
[src/geometry/csgFault.ts](../src/geometry/csgFault.ts) arms a forced failure from the URL
(`?csgfault=difference`, `?csgfault=color-union:1`) at the five points where a real one
originates, and [scripts/check-csg-failure.mjs](../scripts/check-csg-failure.mjs) drives the app
through each, exports a real 3MF, and asserts the degradation that reaches the file against an
undamaged baseline. Run it with `npm run build && node scripts/check-csg-failure.mjs`; the
`debug-csg-failure` skill is the walkthrough, and that script carries the first run's measured
numbers.

What that does not prove: the fault points force the _handler_ to run, so they establish the
degradation and the cleanup, not that Manifold fails on any particular real mesh. Genuinely
malformed input is still untested, and there is no fixture for it.

## Zebra + Fill still loses one color on "Handle (left)"

**Not currently reachable:** the chair body carries `withholdFill`, so Fill and
the pattern strip are both withheld there — this needs fixing before that flag
comes off, not before the next release. The defect below is unchanged.

Left over after the vertex-count fix below, measured on `MOSAIC_GPU=1`
production build, 2026-08-03: zebra in Fill mode on the chair's Left side
settles clean apart from a single
`Couldn't cut color #0a0a0a into "Handle (left)"` (the wording at the time named
the cut solid) — so that part prints without the black, per the handling described in
[troubleshooting.md](troubleshooting.md).

This is not a regression from the thinning, but the thinning is what exposed
it. On the old asset the same part failed _earlier_, at the 2D union
(now `Couldn't merge the shapes for color #0a0a0a on Handle (left)`), and fell back to
the unmerged shape — a coarser input that the 3D boolean then swallowed
without complaint. With the union succeeding, the full-detail pattern reaches
Manifold and that is where it now fails. Net it is 8 union failures across 4
parts down to 1 CSG failure on 1 part, but "one part quietly loses a color"
is still the outcome.

Different layer from the union problem — this one is Manifold, not turf 6.5 —
so the fix is likely different too. Worth trying first: whether the handle's
own mesh density or a near-tangent cut at its curvature is what trips it, by
re-running with the pattern scaled up (fewer, larger stripes on that part).
Closing it means reproducing against `?csgfault` (see "The CSG failure
branches" above) and narrowing to the specific solid Manifold rejects.

## Turf's tile union has a vertex ceiling, and nothing enforces it at runtime

Measured 2026-08-03 while fixing the bundled zebra pattern. Fill mode unions
one copy of the pattern per tile, and `@turf/turf` 6.5's polygon clipping
starts failing somewhere around **800k vertices in a single operation**. It
does not throw at that point — it drops tiles, and the only surface signal is
`Couldn't merge the shapes …`. That message used to assert a cause it could not
know ("likely a self-intersecting path in the source SVG"), which was wrong here:
the paths were fine, there were simply too many of them. It is now cause-neutral
and [troubleshooting.md](troubleshooting.md) carries both causes, so what is left
open is that nothing tells the user _which_ one they hit.

The numbers that made it concrete, zebra in Fill mode on one chair zone
(`MOSAIC_GPU=1` production build):

|                                      | 13.6k verts/tile  | 1.3k verts/tile |
| ------------------------------------ | ----------------- | --------------- |
| vertices across the zone's 143 tiles | 1.95M             | 187k            |
| union failures                       | 8, across 4 parts | 0               |
| triangles produced                   | 853k              | 2.07M           |
| rebuild                              | 468.7s            | 93.6s           |

The doubled triangle count is the tell that this was silent data loss rather
than slowness: the failing run produced _less_ geometry because four parts
fell back to unmerged shapes.

What is fixed: the asset. `scripts/gen-patterns.mjs` thins zebra's contours
(`simplifyEps`), and `tests/patterns-assets.test.ts` fails any bundled pattern
whose vertex count times a chair zone's tile count would approach the ceiling.
That test's `TILES_PER_CHAIR_ZONE = 143` is this measurement frozen into a
constant, not derived from live zone geometry (`tileCoverage()` in
`src/geometry/patterns.ts` needs a real placer + extent, which only exists
mid-build) — deliberately: pulling the full chair build into what is
otherwise a fast, dependency-light asset test isn't worth it while the
budget (300k) already sits well under the failure point (~800k), a 2.6x
margin a moderately larger future zone would not eat through. If a real
zone's tile count ever grows enough to close that gap, this constant needs
re-measuring by hand — nothing will flag it automatically.

What is not fixed: **user-supplied** SVGs get no such check. A volunteer's
detailed drawing in Fill mode on a chair can cross the same line, and will get
the same misleading self-intersection warning and the same partly-blank
surface. Closing that means either counting vertices before the tile union and
warning honestly ("this design is too detailed to repeat across this surface —
N tiles × M vertices"), or chunking the union into batches small enough to
stay under the ceiling and merging the results. The batching option also
removes the ceiling for the bundled patterns, which would make the asset
budget above a performance concern rather than a correctness one. Upgrading
turf past 6.5 may move the ceiling but is separately blocked — see the
`@turf/turf` pin section.

## A round part is scored by its bounding box when placing the prime tower

`suggestTowerPos` measures each corner's overlap against a part's bounding box,
which over-reports a disc by the corners the circle never reaches. On the default
220mm hubcap on the H2D that reads every corner as blocked, so the export writes
no `wipe_tower_x/y` at all and leaves the slicer to place the tower, when the disc
in fact clears the back-right corner by **14mm**.

Measured by review on 2026-08-25, while checking the T0-4 message fix. That fix
made the app tell the truth about which case happened; it did not make the case
correct. The 2026-08-24 cycle's **T0-4** is closed on the copy and open here on
the geometry.

Its own code comment already owns the approximation ("a part's footprint here is
its bounding box, which over-reports a round part"), and the fallback is
deliberately conservative: a tower parked through a part is worse than one the
slicer places. So this is a precision item, not a correctness one, and it costs
the user a verified position they could have had.

Closing it means scoring the overlap against the part's real footprint rather
than its bbox, for the parts that have one, most cheaply via the outline
`hubcapOutline.ts` already computes for the silhouette path.

## The hubcap's plate is verified on two beds and up to one diameter

`HUBCAP_PLATE` ([src/export/threemf.ts](../src/export/threemf.ts)) carries
hand-verified arrangements for the 256×256 and 270×270 beds, both checked at
220mm. `hubcapPlacement` ([src/geometry/hubcap.ts](../src/geometry/hubcap.ts))
applies them only within that, and everything outside falls back to centring the
part with `suggestTowerPos` picking a corner — correct, and it says so, but it
is the outcome that needs a slicer pass every time.

What that leaves open, in the order it is likely to bite:

- **The H2D (350×320) has no verified plate at any size.** It is also the bed
  with the most room — a 220mm disc leaves a ~90mm corner, so the computed
  fallback is very likely fine. Nobody has confirmed it.
- **Nothing above 220mm is verified on any bed.** The control goes to the plate
  size, so a 250mm hubcap on a 270mm bed is reachable and unverified. On the
  256mm bed the verified clearance is only 7mm, so this is not a case where the
  existing numbers could be stretched a little.
- **A hubcap cut to its artwork's shape never gets the verified plate, at any
  size.** `hubcapPlacement` is withheld outright once "Cut to artwork shape"
  is on ([src/assembly/kinds.ts](../src/assembly/kinds.ts)), because
  `HUBCAP_PLATE` was checked against a round disc and a silhouette can reach
  further off-axis than a circle of the same longest-side reading. There is no
  obvious way to close this the way the two items above close — a verified
  arrangement would need to be re-checked per silhouette shape, which isn't a
  fixed set the way bed sizes are, so it likely stays computed-and-flagged
  rather than becoming baked.

Closing either is the same job and needs no code: export at the size and
printer in question (`scripts/export-hubcap-examples.mjs` produces the files),
position the part and the prime tower in the slicer, save, and add the numbers
as another `HUBCAP_PLATE` entry — plus raising `HUBCAP_VERIFIED_DIAMETER_MM` if
the new check is at a larger diameter. Read the provenance comment on
`HUBCAP_PLATE` first: the part position and the tower position are one claim,
because on both verified beds the disc had to move off centre to free a corner
at all, and transferring one without the other puts the tower through the part.

Worth knowing why this can't be solved once and for all the way the fixed parts
were: a generated part has no stable mesh to seal a pose against, so every
arrangement is only ever verified for the parameters it was checked at. More
entries narrow the gap; they don't close the category.

## A patch boundary that meets itself at a point traces as an open chain

`extractPatchBoundary` ([src/geometry/meshparts.ts](../src/geometry/meshparts.ts)) keys its edge
map by **vertex**. Where two boundary loops of one patch touch at a single point, one loses its
outgoing edge, the walk runs off the end, and the truncated chain is returned as if it were a ring.

**What it costs.** `applyAsmPatchChoice` now keeps every loop and
[zones.ts](../src/geometry/zones.ts) nests them by containment depth, so a truncated chain that
encloses area can be read as a hole where the face is solid, or as solid face inside a real hole.
The artwork is then clipped to the wrong shape, and on a hubcap cut to a silhouette the edge rule
reads the wrong rims as the part's outer wall.

**Measured.** Over every packed part's first six patches, 18 of 114 contain a chain that does not
close. All 18 are chair pieces, which take artwork through baked zones instead, plus `wheel-half`
patch 2 (its -Y back: 7 closed chains and 99 open ones). **None of the four kinds' actual design
faces is affected**: wheel-half patch 0, wheel-hub-cap patch 0 and footrest patch 1 are 1, 1 and 3
loops with no open chain at all, and the exported wheel and chair are byte-identical across the
loop-set change. So this is reachable by choosing a non-default design face, or by dropping a
pinched mesh on a role, and not by the shipped workflow.

**Why it isn't fixed here.** Two attempts were made while closing the loop-set item and both
introduced worse bugs than the one they closed, which is what argued for splitting it out:

- Discarding chains that do not close, marking vertices consumed as the walk goes: a chain running
  off the end ate a genuine loop it had entered, and both were lost. Six patches returned no loops
  at all, and `chair-seat-center` patch 0 dropped its 2101.5 mm² outline and kept a 1097.1 mm²
  sub-loop as the face.
- Consuming vertices only on close: a chain entering a cycle it did not start on then runs to the
  100000-iteration guard. `chair-seat-center` patch 0 is the **default** patch, hit on every chair
  load, and went from under 2 ms to 317 ms, emitting 1.6 M points of garbage; `wheel-half` patch 2
  went to 2162 ms.

**What closing it takes.** Key the walk by directed edge rather than by vertex, so a pinch vertex
keeps one outgoing edge per loop, and pair incoming with outgoing by angle around that vertex so
the loops are separated the way the geometry actually runs. A per-walk visited set merged into the
global one only on close, so a failed walk consumes nothing and cannot spin. Then decide what a
patch with no closed ring should do: today it yields a boundary that is wrong rather than absent,
and callers only ask whether a face was detected at all.

## Boundary fringe threads survive the trace

A hair-thin thread of a third color can hug a high-contrast boundary in a traced image
(mario's mustache top edge, a button accent): the anti-aliased band quantizes to its own
label, and it is as long as the boundary, so no area floor catches it. Prints under one
nozzle wide, so slicers drop it; a preview blemish, not a bad print.

Three width-rule formulations (absorb components under a mean-width threshold) were built
and cut on this branch after three consecutive review rounds each found real defects.
The full history is in
[2026-08-24](findings/2026-08-24-despeckle-floor-recalibration.md), defect 3.

Closing this again means clearing, at minimum:

- Placed photographs: quantized gradients are long 1-3px iso-color bands; a probe showed
  a width rule cascade-collapsing sixteen bands into one component. Photos need an exemption
  or a measurement.
- Sub-fringe line art: a drawing whose every stroke is under the threshold must not trace
  to nothing, and the "raise Detail" advice in the empty-trace error cannot be the remedy,
  since Detail does not scale a width rule.
- Perimeter bookkeeping through union-find merges: the despeckle adjacency maps only tally
  pairs with a speck side, so a union's internal big-big runs are not subtractable from a
  perimeter without a fuller tally. Two of the three attempts got this wrong.
- The no-op regime: mean width is never under 0.5 (a lone pixel is 2*1/4), so any threshold
  at or under 0.5 must skip the O(w*h) perimeter scan entirely.

## An open feedback panel covers a warning pill's dismiss button

The trigger and the warnings column were made to share the viewport's bottom
edge (`#right.has-feedback #warnings` lifts the column to `bottom: 44px`). The
**open popover** was not, and it re-creates the same overlap the lift fixed.

Measured at the app's 900px minimum width, so `#right` is 560px:

| Element             | Horizontal span                       |
| ------------------- | ------------------------------------- |
| `#feedback-popover` | 248–548px (300px wide, `right: 12px`) |
| `.warn-pill`        | 12–532px (`max-width: 520px`)         |
| `.warn-dismiss`     | ~520px, inside the popover's span     |

Both sit at `bottom: 44px`; the popover is `z-index: 4` against `#warnings`'
`auto`, so it paints over the pill's right edge. A warning arriving while the
panel is open cannot be dismissed until the panel is closed.

**Why it was deferred, not patched.** Unlike the trigger, the popover is
transient and the user opened it: closing it restores the ×, and it is one
Escape away. The obvious patch (shrinking `#warnings` to `right: 324px` while
the panel is open) leaves pills 224px wide at 900px, which is worse for reading
the warning than the overlap is for dismissing it.

**Closing it means deciding where a bottom-right panel and a bottom-left
warnings column both live**, probably by moving warnings out of the viewport's
bottom edge entirely. That is a layout question for the whole viewport, not a
rule on this widget.

## Numeric coercion has no lint rule

Numeric input guards are enforced by lint and CI in part, not in full. What
holds and what does not:

**Enforced.** `strict: true`, plus the five type-aware
`@typescript-eslint/no-unsafe-*` rules on `src/**/*.ts`. Those caught 12 real
cases of untrusted input reaching typed state, all fixed. ESLint's built-in
`radix` rule also catches a `parseInt` with no base. The one site it found reads
an app-generated `<select>` value, so it was latent, not live.

**Not enforced.** `parseFloat` / `Number` / unary `+` coercion. No lint rule in
the current plugin ecosystem covers the pattern, and a custom parser rule was
ruled out as too much machinery for one check. Nothing catches a `parseFloat`
whose `NaN` is never guarded.

Counted 2026-08-26: of 9 `parseFloat` sites in `src/`, **2** parse an external number with no finite check,
[svg/path.ts:138](../src/svg/path.ts) and
[svg/parse.ts:284](../src/svg/parse.ts). The rest guard, most on the next line, so the exposure is narrower
than the call count suggests. Count the guards, not the calls. One of them,
`ui/partPanel.ts:206`, guards against a value it parses from an authored `min=`
attribute rather than from anything a user types, and a non-numeric one there
would reject every input; that is a latent bug in the markup, not in the guard.

**Also not enforced.** `noUncheckedIndexedAccess`, measured at **2240 errors**
on `main` @ 04c2c81. Enabling it is a real project, not a flag flip.

**Closing it** would take either a custom ESLint rule for the coercion pattern,
or a convention that all external numbers land through one parsing helper that
the type system can then police.

## The copy gate's scope and known gaps

`npm run check:copy` covers string literals in
`src/**/*.ts`, visible `index.html` markup, and `<text>` in
`public/templates/*.svg`. Code, comments, `docs/`, `design-system/` and
formatting glyphs are all deliberately out of scope.

It checks five things, all one rule: a warning is short sentences that each do
one job. Em dash, sentence over 20 words, more than one joining mark in a
sentence, a comma splice, and a lowercase word after a full stop. Thresholds
were measured, not picked: the gate admits 220 strings from `src/`. Joins are
counted per sentence: per string flagged 11, of which 10 were correct
multi-sentence copy, because splitting a run-on raises the per-string count
while improving the writing.

A markup string is not skipped. It is split on tags into text runs, and each
run, plus each `title`, `aria-label` and `placeholder`, is measured as its own
unit. Stripping the tags out of the whole string instead was tried and
rejected: it joins unrelated elements, so a `</div><label>` boundary reads as a
lowercase word after a full stop. That invented two defects and found none.

**Known gaps**, all measured 2026-08-26 against the 220 prose strings `src/`
admits.

| Gap                                    | Size                                                                                                                                                                                                                                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Markup element text is unchecked       | 78 of the 220 are markup. Only their attributes are read, giving 23 units, and **62 yield nothing at all**. The case that matters is [svg/parse.ts](../src/svg/parse.ts), a plain warning that counts as markup only because it names an SVG element. Reopening this means a real HTML parser, not another regex |
| Prose filter is a heuristic            | A whole string of 25 characters or fewer is unchecked. Admitting 21 to 25 takes the gate from 220 strings to 239, so 19 more, none of them defects. Measure on flattened strings: counting raw literals gives 14, a different universe                                                                           |
| `index.html` shape checks are off      | Em dash only, see the section below                                                                                                                                                                                                                                                                              |
| Imperative list is closed              | An instruction using a verb outside it reads as clean                                                                                                                                                                                                                                                            |
| An interpolation counts as one word    | The 20-word limit undercounts a message built from a joined list. The stacked-parts warning measures 11 and runs 15 or more with four parts                                                                                                                                                                      |
| Constants resolve within one file only | A suffix imported from another module is still one token. A name bound twice, or bound with `let`, is skipped rather than guessed: a wrong substitution invents defects that are not there                                                                                                                       |

The last one is the shape of a gap that already cost something. `flatten()` used
to collapse **every** non-literal operand, so a message finished by a shared
suffix was only ever measured in halves. Two defects shipped through it, a
two-join sentence in [placement.ts](../src/export/placement.ts) and a dangling
clause in [exportPanel.ts](../src/ui/exportPanel.ts), and seven review rounds
did not catch either. A reviewer reading the composed string by hand did.

## The help dialog is exempt from the copy shape checks

`npm run check:copy` runs all five checks on warning strings and on template
`<text>`. On `index.html` it runs the em dash check only, for every block, not
just the help dialog.

Measured 2026-08-26 by flipping the flag: **26 problems across 10 blocks**, at
these lines in `index.html`.

| Line | Block                | Worst finding                  |
| ---- | -------------------- | ------------------------------ |
| 109  | Sticker against Fill | joins                          |
| 119  | Design face reuse    | long sentence                  |
| 169  | Detail slider        | joins                          |
| 192  | Cut to artwork shape | long sentence                  |
| 204  | Direct manipulation  | long sentence                  |
| 223  | Verified plate sizes | long sentence                  |
| 235  | Depth explainer      | 2 joins in one sentence        |
| 277  | Slot budget          | 35-word sentence, comma splice |
| 300  | Cancel semantics     | 25-word sentence               |
| 307  | Export summary box   | 33-word sentence, 2 joins      |

Deferred rather than swept, on purpose. The four warning strings this branch
damaged were all damaged by exactly this: substituting punctuation into copy
without re-reading the sentence. The help dialog is long-form explanation, not
an interruption, and it is denser than anything the sweep touched.

**Closing it** is one copy pass over those 10 blocks, then flipping
`INDEX_HTML_EM_DASH_ONLY` to `false` in `scripts/check-copy.mjs`, which runs
`problems()` on `index.html` the way it already does on warnings. Check
convention 36 after: the rewrite must not be longer than what it replaced.
