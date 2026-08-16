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

## The assembly-part dropzone's radius matches no token

[src/ui/assemblyPanel.ts:428](../src/ui/assemblyPanel.ts#L428)'s inline STL/3MF drop target
hardcodes `border-radius:6px`. The radius scale (`tokens/spacing.css`) tops out at
`--radius-2xl`, 3px — 6px matches no step on it, doubled or otherwise. Found while converting
this same line's `padding` and font-size to tokens (`chore/type-and-spacing-tokens`); left alone
because radius was explicitly out of that branch's scope.

**It no longer renders in any shipped kind, and the census row it used to be blamed for is gone.**
PR #166 put the drop target behind `canSwapMesh`, which is true only where the parts library is
unreachable. Every shipped kind (Wheel, Footrest, Hubcap, Chair body) auto-loads from the library,
so the `/review-gauntlet system` run at `3288f6a` found **0** elements at 6px, against 2–6 on
earlier runs. Don't read that zero as a fix: the literal is unchanged, and the fallback path still
renders it wherever the library is missing.

What closing it would take: decide whether 6px is a deliberate one-off (in which case it needs
its own token or a documented exception, the way the five icon glyphs got one) or a mistake that
should be `--radius-2xl`, then fix the one line.

## What the header stripe is allowed to borrow from the makegood.design brand

A maintainer decision, not a bug, and deliberately kept open. Nothing renders wrong today.

`.accent-stripe` ([src/styles.css:71](../src/styles.css#L71)) is the 3px rule across the top of the
window: `linear-gradient(90deg, #7c3aed, #4c5fd7, #0d9488)`, purple to indigo to teal.

**It is a near-copy of makegood.design's banner gradient, off by about one shade step.**

| Stop | Brand (`--mg-banner-*`) | App stripe |
| ---- | ----------------------- | ---------- |
| from | `#7e22ce` (purple-700)  | `#7c3aed`  |
| via  | `#4338ca` (indigo-700)  | `#4c5fd7`  |
| to   | `#0f766e` (teal-700)    | `#0d9488`  |

Same three hues, same order. The middle stop matches no standard step in either palette.

**The framing that makes this decidable: the tool already borrows the brand's whole palette.**
`tokens/colors-makegood-dark.css` and the app's own `tokens/colors.css` agree on nine hexes exactly
(table in `design-system/README.md`'s "Not in scope" section). So the question is not whether the
tool may borrow from the marketing brand. It does, completely. The stripe is the one borrow that is
visible and unreconciled.

**The one input needed to close it**, which only the maintainer can supply: is the lightening a
deliberate adjustment for the dark navy UI, or drift from a copy-paste? Each answer picks its own
fix, and all three cost about the same:

| If the intent was      | Closing it means                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------- |
| Match the brand banner | adopt the `--mg-banner-*` values                                                    |
| Mosaic's own variant   | declare `--stripe-from`/`via`/`to` in `tokens/colors.css`, saying why it sits light |
| Stop borrowing         | restyle in `--accent` / `--accent-2` and drop the brand reference                   |

Scope is four sites in every case: the two declarations ([src/styles.css:71](../src/styles.css#L71),
`design-system/guidelines/brand-mark.html`'s own `.accent-stripe`) and the two places the hexes are
quoted in prose (`design-system/README.md`'s Colors section, and `brand-mark.html`'s closing note).

Leave the three colors as literals until this is settled. Tokenising them now would make the
current values look decided.

**Three dead ends, checked so they are not re-checked.** The stripe is not the MakeGood rainbow:
that is a separate seven-stop warm ramp (`--mg-rainbow-1..7`) used only by
`guidelines/brand-makegood-site.html`. `design-system/README.md` does not forbid this stripe; it
sanctions it by name and hex, and its "app mark" phrase belongs to a clause about there being no
conic gradient. And [ui-conventions.md](ui-conventions.md) holds no record of this question: it has
nothing on the header, stripe, brand, or rainbow.

## Selection in the panels is still an accent tint, and two of convention 19's neighbours are open

The viewport half of this is closed **for the accent-hue problem specifically**: the placement
frame no longer draws in accent blue, it is a `--text` outline, and the before/after against a blue
design is what settled it. Two things it does not settle, both measured off the rendered frames
rather than argued:

- **`--text` over the default body `#b9c0c6` is 1.50:1.** The frame is faint wherever it crosses a
  light part or a light design. Convention 19 names three mechanisms — outline, contrast against
  dimmed surroundings, neutral luminance — and the fix used the first alone, which is only ever as
  good as its luminance against whatever it happens to cross. **Dimming the unselected surroundings
  is the one that does not depend on the artwork**, and it is also what convention 20 asks for on
  its own account, so the two close together. It was not attempted here because it is a change to
  the model's materials in an app whose subject is showing true colour, and that is a decision, not
  a tweak: how much dim, and only while something is selected?
- A dark/light pair (`--text` line, `--bg` handles) was tried first on the reasoning that one half
  would always have contrast, and **measured worse**: the handles sit at the design's corners,
  which are usually off the part and over the `#05070d` stage, where `--bg` is **1.06:1** — less
  visible than the system's own disabled state, on a live drag target. Recorded so it isn't
  re-derived. The handles are `--text` now.

What the fix explicitly did **not** cover is the rest of the sentence the section used to carry — "apply it wherever selection is drawn, the placement frame is the known instance, not
necessarily the only one." Three places in `src/styles.css` still say "selected" with the accent:

- `.artwork-row.active` — `border-color: var(--accent)` plus `--accent-wash`.
- `.base-swatch.selected` — `outline: 2px solid var(--accent)`, and this is the sharp one: the
  thing being outlined **is a filament swatch**, so a blue ring around a blue filament is exactly
  the collision convention 19 names, in the one list where it matters most.
- `.auto-merge-labels span.active` — `color: var(--accent-2)`.

Not measured; these are read off the stylesheet, not off a screenshot. Closing it means the same
decision applied in a DOM context, where the tools differ from the viewport's (an outline offset,
a weight change, a checkmark) and where the accent may well be fine for a row that carries no
color of its own. Settle the swatch first.

**Two neighbours of the same rule, both still open**, and the second now has a second instance. Convention 20: greyed-back excluded geometry
must not look like geometry printing in grey — untested either way, and the body renders `#b9c0c6`,
which is a grey somebody prints in. Convention 21: a meaning-carrying overlay has to be
distinguishable from artwork by pattern or motion rather than hue alone, and the placement frame's
off-surface warning state is still hue alone (amber `0xe0a33a`, which matches no token). That one
was deliberately left as it was — it is a warning rather than a selection, the comment on it
defends the choice against a desaturated alternative, and changing a warning colour was outside
the change that closed the selection half. A conventions review of the shipped screenshots called
it independently, and added the sharper version of the point: with the resting frame now `--text`
and the off-surface frame still amber, **the app has two different frame treatments in the same
widget**, one on-token and one not.

One instance is already closed: the part thumbnail's silhouette (`src/ui/shapeThumb.ts`) was
painted in `--accent` and is now `--text-dim`. Worth knowing for the rest of this section, because
the two considerations pointed the same way rather than trading off — measured off the rendered
pixels, the neutral is also the more legible fill (7.3:1 nearest against the accent's 5.3:1), and
the accent's farthest shaded surface was 2.9:1 on the hubcap, under WCAG's 3:1 non-text minimum.
Don't assume the remaining instances cost legibility to fix.

## Filaments are presented as an unlabelled swatch grid, and the slot count only appears in a failure

Conventions 16–18 of [ui-conventions.md](ui-conventions.md). "Body / blank color" is a 14-swatch
grid with no numbering; an AMS presents filaments as numbered slots, which is the vocabulary the
audience already has. Separately, the number of slots a design is currently spending is visible
only inside the AMS-capacity warning — the user learns the cost at the moment it has already
become a problem, rather than while there is still a cheap decision to make.

This is the presentation half of a mismatch whose other half is already tracked under "Auto-merge
is a similarity control; the user's actual constraint is a slot count" — that section covers what
the control _does_, this one covers whether the cost is legible while designing. Closing it means
a persistent slot count against the selected printer's capacity, shown during design rather than
on failure, and numbering the swatches. The count is already computed for the capacity check, so
this is presentation over data the app has in hand. A third convention in the same group — that
the owned-filament palette be editable in the app rather than by hand-editing
`public/filaments.json` — is already carried as a roadmap item.

## The body-color help text tells the user to act in a different panel

Convention 4 of [ui-conventions.md](ui-conventions.md), which states that no control's
explanation may reference a control in another panel: if it must, the model is wrong and the
layout should change rather than the copy grow. The live instance: "Body / blank color … To print
an artwork color as the body instead, use '→ base' (or drag it onto the Base row) in Colors
detected further down."

Not measured; carried from the rubric's conflicts table. The copy is a symptom, so the fix is not
a rewrite — closing it means putting base assignment where the body color is chosen, or accepting
that these are one decision presented in two places. Worth settling alongside the swatch-grid item
above, since both are about the same panel.

**The quoted sentence is gone** as of the copy-tightening pass; the hint is now "The body color
used when no artwork color is grouped into the base." That removed the pointer, not the split. The
item stays open, and the live instance is now the layout rather than a sentence to grep for.

## Depth's default is overridden from a different panel

Convention 4 again, one panel down. The Depth panel sets a default; the per-color overrides that
beat it live in Colors detected, and a color carrying one is highlighted only there. The hint used
to say "override per-color below", which is the same cross-panel pointer as the body-color item
above; it now says "Individual colors can override it" and names nothing.

Smaller than the body-color case, and the same shape: the help dialog still has to explain that
changing the Depth field can appear to do nothing because some rows opted out. Closing it means
showing the override state where the default is set, not adding the sentence back.

## Colors detected needs a paragraph of prose because none of its mechanisms are visible

Convention 5 of [ui-conventions.md](ui-conventions.md): prose in a panel is a symptom, and a panel
needing several sentences to explain what its controls do to each other is describing a
relationship that should be visible instead. This is the rubric's own worked example.

Measured before the copy-tightening pass: the hint ran 96 words and carried six mechanisms.

| Mechanism                                                     | Why copy was carrying it                           |
| ------------------------------------------------------------- | -------------------------------------------------- |
| Drag one row onto another to merge                            | Drag targets are not indicated                     |
| The ⠿ grip marks what is draggable                            | A glyph that has to be named in prose              |
| The "Merge with…" dropdown does the same thing                | Two paths to one result, neither obviously primary |
| A merged group shares one depth                               | Not shown on the group                             |
| A merged group prints in its dominant member's color          | Not shown on the group                             |
| "→ base" replaces the base, dragging onto Base row adds to it | Two gestures, opposite semantics, same target      |

The hint is now two sentences and the detail lives in the help dialog, which is where mechanism
belongs (convention 6). That is the copy fix and it is done. What remains is the reason the copy
existed: closing this means making the affordances legible, in particular the last row — an
asymmetry between two gestures on the same target is not something help text can rescue.

## The CSG warnings still name an internal step, and three items depend on the wording

Convention 2 of [ui-conventions.md](ui-conventions.md), and its worked example verbatim:
`Couldn't build the cut solid for color #0a0a0a on Handle (left)`. Conventions 33–37 say the same
thing for every string. `cut solid` and `Boolean union/subtraction failed` are ours, not a slicer's.

**Nothing else is left of the copy problem.** The help dialog and panel hints were reworked against
33–37 and are done. The other warnings were already plain: convention 2 did that work when they
were rewritten to name a filament and a part. These two strings are the exception because they were
never reworded.

Rewording them is not a copy edit, which is why it is its own item:

| Depends on the current wording                                           | What it needs                                                      |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| [troubleshooting.md](troubleshooting.md), one section per warning string | Two section headings move in lockstep                              |
| "A seam sliver warns as if artwork were lost"                            | Cites the string as indistinguishable from a real failure          |
| "Zebra + Fill still loses one color on Handle (left)"                    | Quotes it as the observed symptom                                  |
| "Turf's tile union has a vertex ceiling"                                 | Quotes `Boolean union failed …` and notes it names the wrong cause |

The last row is the reason to do these together rather than as wording alone: that item already
records the message naming a cause that isn't true. A rewrite that fixes the register and leaves
the wrong cause in place spends the change and keeps the defect.

**Method, established on the help-dialog pass: rewrite by sentence purpose, not by word.**
Conventions 33–37 verify one string. They do not say how to rework a document, and word-for-word
substitution is how a copy pass makes things worse: it keeps the sentence that was built around the
jargon and pads it. Ask what the reader needs to _do_, then write that fresh. Measured on the help
dialog: 2362 words to 2327, longest sentence unchanged at 21, no paragraph or section lost.

Two traps the help-dialog pass hit, both worth not repeating. Five rows of convention 33's jargon
table were written by substitution and had to be fixed before they merged. And two rewrites there
merged sentences while removing a term, pushing the longest from 21 words to 28, which is
convention 36 failing in the exact place it was written to guard. **Count after rewriting, don't
judge by eye.**

`tileable` and `bounding box` were counted as violations in the first draft of this item and are
not. Both pass the slicer test, and both plain replacements ran longer. Closing this must not
"fix" them.

## The AMS-capacity pill states three remedies at once

Convention 3 of [ui-conventions.md](ui-conventions.md): a warning states one problem and one
primary remedy, with alternatives in help rather than in the pill. The capacity warning currently
carries three remedies across three lines of prose.

Not measured; carried from the rubric's conflicts table. Smallest item in this group — closing it
is choosing which remedy is primary and moving the rest into the help dialog. Note that
[troubleshooting.md](troubleshooting.md) keeps one section per user-visible warning string, so
changing this pill's text means updating that section too.

## The placement frame's angle is unrelated to the face it acts on, and it shares the viewport with a second affordance

Conventions 13–14 of [ui-conventions.md](ui-conventions.md): a gizmo is aligned to the frame of
the thing it acts on, and only one manipulation affordance is offered at a time. Both are
reported broken — the placement frame renders at an angle with no relation to the part face, and
corner handles compete with an axis handle for the same drag.

Not measured, and the one item in this group where that matters most: an arbitrary gizmo angle is
either a genuine frame bug in the placement math or a rendering choice, and those close very
differently. Establishing which comes before any fix — it touches placement, so treat it as
geometry work rather than UI. The competing-affordances half is separable and is a UI decision.
This is the last of the group that made the viewport not behave like the direct-manipulation
surface it looks like; the other one, "Zone picking has no occlusion test," is closed
(`npm run check:zone-occlusion` re-measures it — by hand, it is not in CI).

## The browser-driven checks are only fast if Chromium finds a real GPU, and on WSL2 it does not find one by itself

Falling back to SwiftShader costs
roughly 300ms per frame, which also caps `requestAnimationFrame` near 2.5fps
and so stretches anything frame-paced. Driving the chair end-to-end takes
**~104s** software versus **~12s** with hardware acceleration, on the same
machine. The hardware is reachable — `/dev/dxg` plus Mesa's d3d12 gallium
driver in `/usr/lib/wsl/lib` — but selecting it needs
`GALLIUM_DRIVER=d3d12` in the environment _and_ `--use-gl=angle
--use-angle=gl-egl` on the command line;
`MESA_LOADER_DRIVER_OVERRIDE` alone silently leaves you on llvmpipe, which is
also software. [scripts/lib/harness.mjs](../scripts/lib/harness.mjs) does this
behind `MOSAIC_GPU=1`, opt-in rather than automatic because CI's Playwright
container has no GPU at all. Asking for it and not getting it is an error,
not a slow run: with the flag set, the harness reads the GL renderer string
once per browser, prints it, and refuses to continue if it names SwiftShader
or llvmpipe — a silent fall back to software is exactly what made this hard
to diagnose the first time.
What's left: nothing required, but the flags are Chromium/WSL-specific and
will need revisiting if either the container image or the WSL graphics stack
changes.

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
touching the tolerance, because it is the tolerance the existing five zones'
measured coverage was tuned against; changing it re-bakes all of them.

## Rebuild performance needs ongoing work — this is a heavy application

A dense 135-path SVG still takes ~13s to rebuild in flat mode, ~9s of
which is the paint-order boolean pass in
[src/geometry/regions.ts](../src/geometry/regions.ts)
(`computeNetRegionsByColor`). The rebuild is already cooperative (yields to
the browser, live progress %) and the flat union phases use balanced tree
merging (~3x faster than the old left-fold), so the tab never freezes —
but the compute floor is still high. Measured leads for a follow-up, best
first: (1) call the `polygon-clipping` engine directly with n-ary
union/difference (one sweep instead of dozens of pairwise ops — but it
bypasses Turf's wrappers, so the safeUnion/safeDiff fallback machinery
needs care); (2) move the boolean pass into a Web Worker (doesn't reduce
compute, makes the wait invisible). Dead end, already measured: bbox
pre-filtered per-shape diffs benchmarked ~2x SLOWER than the accumulator
on real artwork (full-canvas backgrounds overlap everything) — see the
comment on `computeNetRegionsByColor`.

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

## The long assembly-mode rebuild has no cancel, and until session persistence lands the only escape destroys the work

`#loading-overlay` (the "Rebuilding geometry…" curtain, `src/ui/overlay.ts`)
has no cancel or back control at any point in the 405.6s / >900s runs
measured above (the 405.6s figure is itself superseded — see the note just
above this section — but the argument holds at the re-measured 93.6s too:
a rebuild that long with no cancel is still the problem) — a user who starts
the wrong rebuild (wrong pattern, wrong zone scope) has to wait it out. Today the only way to interrupt it is a
reload, which — until the session-durability fix lands (tracked as work,
not tech debt; see the plan that added this section) — erases every setting
in the session. That combination is what turns "this is slow" into "this
tool lost my afternoon" for the vision-lens review that measured it.
Persistence removes the second half (a reload becomes recoverable instead of
catastrophic) but not the first: there is still no way to abort a running
rebuild and get the UI back without waiting or losing the in-flight state.
Closing this needs either an `AbortController` threaded through the
CSG/triangulation pipeline (`src/geometry/assembly.ts`,
`src/app/rebuild.ts`) or moving the pipeline off the main thread so a cancel
can just discard the worker — the same Web Worker move already listed above
as a lead for the flat-mode case would likely serve both.

## Auto-merge is a similarity control; the user's actual constraint is a slot count

The slider (`None`/`Slight`/`Medium`/`Strong` — `src/ui/colorList.ts`,
`initColorListPanel`) walks a ΔE similarity threshold, merging colors that
look alike. Measured against a real 7-color volunteer SVG on the chair,
2026-08-02: `None` → 7 AMS slots, `Slight` (the default) → 7, `Medium` → 7,
`Strong` → 6. The audience's actual question — per
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

## The export button doesn't say what it's about to produce

Confirmed on the chair, 2026-08-02: "Export print-ready 3MF" produced a
35.8 MB, 11-plate, 13-object, 5-filament file with zero on-screen summary
before or after — the app's state is byte-for-byte identical pre- and
post-export. That's a multi-day, multi-kilogram print represented as a
single unlabeled button. The zone-coverage warning and AMS-capacity check
landing now (see the plan that added this section) surface two of the
numbers that matter at export time, but not the full picture — plate count,
per-plate part list, filament colors. Closing this means a pre-export
summary card reading the same `getLastAssemblyBuild()` /
`built.partOutputs` data `exportPrintReady3MF` (`src/ui/exportPanel.ts`)
already has in hand; it's a presentation layer on data that already exists,
not a new computation.

## Three open defects in the chair / pattern-library workflow

Named by the maintainer on 2026-08-05 as the reasons both features were briefly
withheld from the UI (PR #133, since undone — both are offered again). Four were
named; the viewport one ("jagged edges, and they cut off") turned out to be two
unrelated one-file bugs and is fixed and gone from this list — camera fit in
#139, flat shading in #140. **The remaining three are not fixed**; only the
hiding was undone. They are graded against the shipped data below: the report is
the maintainer's, the diagnosis is not, and where the cause is confirmed it says
so.

1. **The front of the fender gets no coverage — confirmed.** The wings (the
   "fenders") are reached only by `left` and `right`, which seed on the flank
   at `maxAngleDeg: 45`
   ([scripts/zone-configs/chair-body.json](../scripts/zone-configs/chair-body.json)).
   The `front` zone's charts cover `storage-*`, `handle-*` and `seat-back-*`
   and **no wing at all**, so the forward-facing fender face falls outside
   every zone and takes no artwork. Note that the chair body plan (deleted once
   the chair shipped; in git history) dropped the planned separate
   `wing-left`/`wing-right` zones as unnecessary, on the finding that
   seeding on the fender reaches the same triangles as seeding on the storage
   side — true for the flank, but that reasoning never covered the front face.
   Closing it is either a wider `front`, a raised `left`/`right`
   `maxAngleDeg`, or reinstating the dropped wing zones; all three re-bake and
   re-tune every zone against the coverage-vs-stretch knee the `_note` warns
   about.

2. **Dead zones still need defining — open.** It is written up in
   [roadmap.md](roadmap.md) ("Dead zones: mark the parts of a design zone that
   are hidden by an adjacent part"). Without it a design placed across a joint
   spends filament changes on surface nobody sees.

3. **The SVG templates have odd/wrong edges — confirmed, same root as the cut
   outline.** Every shipped template in `public/templates/` is a pure `L`
   polyline with no curve commands: the zone boundary is traced along mesh
   triangle edges and emitted vertex-for-vertex. So a template's outline is as
   faceted as the tessellation under it. Two of them are also very ragged
   rather than merely faceted — `back` carries a 355-point boundary with **18
   holes**, `front` 146 points with 3 — which is what a grown-region boundary
   looks like when it stops mid-surface, and is the same boundary the cut
   clips to. Note the repo already has curve fitting for the raster tracer
   (`src/raster/curve.ts`); nothing equivalent runs on a zone boundary.

Longer-standing defects against the same two features, each with its own
section below: "Artwork can't wrap unbroken from one flank around the back to
the other" (three measured dead ends), "The chair's zone sidecar is 1.7 MB
raw", "The caster mounts have no design zone", "Zebra + Fill still loses one
color on Handle (left)", and "Turf's tile union has a vertex ceiling, and
nothing enforces it at runtime".

**Infrastructure left behind by the hide, deliberately kept.** `AssemblyKind.hidden`
still works, `renderShapeKindOptions()` still lists a hidden kind while it is
the selected one (so `?kind=` can reach one without the select rendering
blank), and `savedSessionIsOnHiddenKind()` in
[src/state/persist.ts](../src/state/persist.ts) still stops the empty-snapshot
clear from silently deleting a saved session on a hidden part. Nothing is
hidden today, so `tests/persist-hidden-kind.test.ts` marks a kind hidden for
the duration of a test rather than looking for one — driving it off whatever
happens to carry `hidden` is what made it go quiet the moment the chair was
unhidden.

## The display meshes re-derive a vertex weld the build already did

`bufferGeometryFromTris()` in [src/app/rebuild.ts](../src/app/rebuild.ts)
shades via `toCreasedNormals`, which buckets vertices by position to find the
faces sharing each one — for the chair that is a string hash per vertex across
368k triangles, on **every rebuild**, not just on load.

Manifold already welded those vertices during the boolean, and the result is
sitting on the same object the display path destructures: `bodyIndexed` /
`inlayIndexed` on `AssemblyPartOutput` ([src/types.ts](../src/types.ts)), which
3MF export consumes rather than re-welding. The display path ignores them.
Recorded here because the PR that added the creased shading (#140) claimed the
opposite — that no vertex-count saving was available — which was wrong, and
wrong in the direction that hides work.

**Not a drop-in.** Handing the indexed geometry to `toCreasedNormals` is
strictly _worse_: it opens with
`geometry.index ? geometry.toNonIndexed() : geometry`, so an indexed input is
expanded and then hashed anyway. Capturing the saving means a crease-aware
normal pass that consumes an index directly — real work, not a swap. Measure
first: the shading swap cost 3.0s → 4.1s on a chair load, and the weld is the
plausible cause but was never isolated, so confirm the attribution before
building anything.

Two more things worth knowing before touching this:

- `toCreasedNormals` matches vertices by **truncating to 0.01mm**
  (`hashMultiplier = (1 + 1e-10) * 1e2`, then `~~`), which is bucketing, not an
  exact or epsilon match. Cut bodies are safe — Manifold emits exactly
  coincident vertices, which always land in one bucket. A **user-uploaded STL**
  has no such guarantee (`renderRawAssemblyParts`): a shared corner whose
  coordinates straddle a bucket boundary stays unwelded and renders as an
  isolated flat facet. Cosmetic, source-dependent, unmeasured.
- Whatever replaces it has to keep the crease behaviour rather than drop it.
  A blanket weld plus `computeVertexNormals()` was measured and rejected — it
  melted the embossed logo on the storage box; see `CREASE_ANGLE_RAD`.

## Region computation is O(n²·len) per path

([regions.ts:357](../src/geometry/regions.ts#L357), `shapes.map(shapeToFeature)`,
before the first yield) — `shapeToFeature`'s containment-depth resolution
tests every subpath ring against every other ring with a point-in-polygon
scan. Benchmarked against production/sample SVGs
([scripts/bench-shape-to-feature.ts](../scripts/bench-shape-to-feature.ts)):
worst real-world case measured 5.88 ms (`public/patterns/zebra.svg`, a
single 69-subpath path), an order of magnitude under the 30 ms yield
budget — not a live issue on any file currently in use. Risk case is a
dense Illustrator export (hundreds of subpaths in one `<path>`, e.g.
fur/stipple line art) that no current sample exercises. Revisit if/when
such a file is actually encountered, rather than guessing a threshold now.
A separate, far more extreme case — thousands of nested rings or `<g>`
elements deep enough to overflow the JS call stack — fails with a named
"unusually deeply nested" error instead of a raw stack-overflow message,
but still isn't depth-limited; see `shapeToFeature` and `walk` in
[regions.ts](../src/geometry/regions.ts) and [parse.ts](../src/svg/parse.ts).

**Raster tracing is the first producer that could plausibly hit this**, and is
held off it by the despeckle floor rather than by luck. Measured with
[scripts/bench-raster.ts](../scripts/bench-raster.ts) at 512px, 8 colors: the
worst single shape carries ~23 rings and costs ~5 ms, against zebra's 69/5.88 ms
— so grouping shapes per color, which piles every ring of one color into one
shape, stays comfortably inside the budget. `MAX_COMPONENTS` (800,
[trace.ts](../src/raster/trace.ts)) is what guarantees it: exceed it and the
floor is raised to exactly the area that fits and the image re-traced. If that
cap is ever raised or the floor lowered, re-run the bench — this is the number
that keeps the quadratic term small, and the failure mode is a frozen tab, since
`shapes.map(shapeToFeature)` runs before the first yield.

## Raster shape granularity was settled by measurement, and the losing option is still reachable

Traced components can be grouped one shape per color or one per connected
component ([`ShapeGranularity`](../src/raster/parse.ts)), and the two costs pull
opposite ways: per-color risks `shapeToFeature`'s O(rings²·len) _within_ a shape,
per-component multiplies the paint-order boolean pass by shape count. Measured
(`scripts/bench-raster.ts`, 512px photographic source): per-color ~830 ms total
against per-component ~1590 ms, the difference almost entirely in the boolean
pass (136 ms vs 1055 ms). Per-color ships.

Worth knowing for anyone revisiting it: traced regions are **disjoint by
construction**, so every `safeDiff` in that pass is provably a no-op. A
`disjoint` fast path on `computeNetRegionsByColor` would collapse it to array
concatenation and make per-component viable — and would also cut the per-color
path's 136 ms. It was left unbuilt because the measurement above says nothing
needs it: at 8 shapes the pass is not where the time goes. Build it only if the
component cap is ever raised enough to change that.

## The raster photo-vs-flat-art thresholds are shaped right but calibrated against synthetic images

`FLAT_EDGE_DENSITY` / `PHOTO_EDGE_DENSITY` in
[src/raster/stats.ts](../src/raster/stats.ts) (0.12 and 0.45) decide how much
blur and despeckling an image gets, interpolating between so nothing falls off a
cliff. The statistic is sound — flat art puts its transitions on thin outlines
around large constant fields, a photograph has one nearly everywhere, and
`tests/raster-parse.test.ts` pins that separation — but the two endpoints were
placed from procedurally generated sources, not from a corpus of real files.

Closing it: record `measureImage().edgeDensity` for a real set — the shipped
`public/patterns/*.svg` and `public/assets/makegood-logo.png` rasterized, several
phone photos, one quality-40 JPEG (block artifacts must not read as flat), and
the genuinely hard middle: a UI screenshot, a scanned crayon drawing, a
gradient-heavy illustration. Confirm the flat and photo clusters are separated by
a gap and put the endpoints inside it. A screenshot landing on the photo side
would be the bug to watch for. If the clusters overlap, the statistic itself is
wrong and wants replacing rather than retuning.

## Curve fitting rounds small corners, and two components can overlap by up to a working pixel

Fitting rounds a corner it doesn't judge sharp, and "sharp" is scale-dependent: Potrace's corner
measure works out to about `side/2` for a square, which has to clear 4 at the default `alphaMax`,
so corners survive from roughly nine pixels a side upward and round below that. A feature a few
pixels across therefore comes back a few percent smaller. That part is cosmetic and unchanged.

**A more serious failure existed and is fixed, 2026-08-04.** The straightness cone carries half a
pixel of slack at each bound, and for a feature thin enough — a one-pixel-wide stroke turning a
corner, a shallow diagonal, a zigzag, a single-pixel checkerboard cell — the whole boundary can stay
inside that slack and read as one straight run. The fitted polygon then collapses under three
points, and the ring was dropped outright: a 2:1 diagonal stroke lost 93 of its 95 segments, a
zigzag lost half its length, and the 4x4 checkerboard fixture lost about a third of its area. This
was not shrinkage, it was deletion, and the closed-chain-only guard in
[curve.ts](../src/raster/curve.ts) (`MIN_AREA_RATIO`, 0.85 — restores a 30x1 bar to exactly its pixel
area) never saw it, since none of these are closed chains.

`unfitCollapsedChains` in [trace.ts](../src/raster/trace.ts) closes it at the right grain: it checks
area per **component**, which is the smallest thing that has one, then drops back to lattice points
per **chain**, which is the thing shared between two components — unfitting only the starved side
would desync a boundary from its neighbour and open exactly the sliver the shared-chain design
exists to prevent. Re-measured after the fix: the diagonal, the zigzag, and the checkerboard all
recover their exact pixel area (`tests/raster-trace.test.ts` pins the checkerboard case at 16.000,
not the ~third-short figure this entry used to cite).

**What is not fixed, and can't be from this angle:** two components can still overlap by up to one
working pixel. Chains are byte-identical on the two sides of the boundary they're shared between,
but nothing bounds how far a fitted chain strays from the lattice path it replaces, so it can sweep
across a third region it shares no chain with. Re-measured over 3000 random label grids after the
above fix: worst overlap is still 1.000000 unit², unchanged — `unfitCollapsedChains` catches area
loss, not this. Downstream it's absorbed: paint order in `computeNetRegionsByColor` subtracts
cross-colour overlap outright, and two components of one colour land in the same shape and get
unioned. `tests/raster-trace.test.ts` pins the bound rather than asserting zero.

A bound on chain deviation was tried and rejected: it cannot be set. A 45° staircase's lattice
corners sit 0.707px off their own chord and a 3:1 staircase's sit 0.949px off, both legitimate, while
the chains that misbehave measure about 0.97 — there is no threshold separating them.

How much the remaining overlap matters in practice: on the 512px photograph path a one-pixel overlap
is 0.54mm, at or under the nozzle width. Flat art now works at 1024px, which _halves_ that to
0.27mm, comfortably under a 0.4mm nozzle — the point at which this stops being a fidelity question at
all. Closing it properly means a fit that never strays from the lattice path by more than the
adjacent regions can tolerate, most likely by recognising digital straight segments (the arithmetic
characterisation) instead of Potrace's cone, which does not have the half-pixel slack that causes
this. Worth doing only if it shows up as a visible artifact in practice; measure before building.

## Colors is the one trace control still fixed, and no single value suits real artwork

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

The region count is a usable signal for choosing it automatically. Across the corpus, each step up
in palette size multiplies regions by 1.2x-2x, except where the surplus starts landing on fringe:
the logo's 4 -> 6 step multiplies them by 6.5x. A knee detector over that curve would pick the
palette size the way the other three parameters are already picked, and would suit both a
three-colour logo and a nine-colour cartoon without the user touching a slider.

What closing it needs: a decision on where to run the search (re-quantizing at several k costs one
quantize pass each, which the bench puts at tens of milliseconds), and a check that the knee is
stable on photographs, where region growth is smoother and the signal weakest.

## The trace parameters are calibrated against a downscale that is no longer constant

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
1588px one that was halved, and neither is the case the endpoints were tuned for. Closing it means
deriving blur from the realised downscale ratio — the decoder knows both sizes — and re-tuning the
flat endpoint against sources at several scales rather than the one that prompted this.

## The curve-fit constants are reasoned, not measured against a corpus

`alphaMax` and `flatness` in [src/raster/stats.ts](../src/raster/stats.ts) replaced the old RDP
`simplifyTol` when tracing moved to sub-pixel curve fitting. The flat-art endpoints (`alphaMax`
1.0, `flatness` 0.25px) and photo endpoints (1.2, 0.4px) were picked from what each parameter
means — 1.0 is the long-standing Potrace default, `4/3` is where the corner test stops rejecting
anything, and a quarter-pixel flattening tolerance is well inside what the 0.4mm nozzle can
express — and then checked on the synthetic bench sources plus a single real one (a 1588x1176
flat-art cartoon, kept in the gitignored `stubs/`, so not reproducible from a clean checkout).
That is the same weakness the edge-density thresholds have, one section down: the shape is right,
the numbers have not been swept.

Closing it: sweep `alphaMax` across 0.8–1.334 and `flatness` across 0.1–0.6 on a corpus with
known-correct answers — a logo whose corners are genuinely square, a scanned drawing, a photo —
and record where corners start rounding off and where point counts start climbing without a
visible improvement. The two failure directions are asymmetric and worth naming: too low an
`alphaMax` gives a faceted arc, too high rounds a square logo's corners, and only the second is
obvious in a preview. `FLATNESS_MIN` is a performance guard rather than a taste one — it stops a
full-right Detail slider turning a sub-pixel tolerance into a ring-length explosion, which
`shapeToFeature` is quadratic in.

## The raster despeckle floor is a fraction of image area, not a printable size

[src/raster/stats.ts](../src/raster/stats.ts) expresses it as a fraction of the
working image so it means the same thing at any input resolution — but the raster
stage never learns how large the part is, so it cannot express the floor as the
thing that actually matters: a feature smaller than roughly one nozzle width will
not print however the image was scaled. At the current numbers a 512px image
auto-fit to an 80mm face puts the photo-strength floor near 0.6mm, which is about
right, but that is a coincidence of two independent constants rather than a
derivation. Closing it means threading the resolved mm-per-unit
(`designMmPerUnit`, [assembly.ts](../src/geometry/assembly.ts)) back into the
raster stage, which today runs strictly before placement is known.

## A loaded image is not part of the saved session

Session restore rebuilds each source by re-parsing its saved SVG text
([persist.ts](../src/state/persist.ts)), and an image has none — it came from
pixels. Persisting the pixels instead was measured and rejected: one decoded
512px image is ~1 MB before JSON encoding, against a `MAX_BYTES` ceiling of 4 MB
for the whole session, so two or three images would blow it and take the SVG
half of the session down with them. Flat art now decodes at 1024px, four times
the pixels, so a single one would fill that ceiling on its own — the case
against persisting them got stronger, not weaker.

So a raster source and its placements are skipped on save. Consequences worth
knowing before changing this:

- A session whose _only_ design is an image saves nothing at all and offers no
  restore banner. It must not save an empty-but-valid session instead: the
  banner shows for anything that parses, and would offer to restore "the Disc"
  with no designs. `saveSession()` decides this from the snapshot, not from
  `hasLoadedWork()` — the two deliberately disagree here.
- That same session reports a _failed_ save to the beforeunload guard, which is
  what makes leaving the tab prompt. This is the one case where the guard fires
  without a storage error, and it is correct: the work really is unrecoverable.
- A mixed SVG + image session saves and restores the SVG half silently, losing
  the image with no prompt. Warning on it would mean nagging on every mixed
  session, so it is documented in the README instead.

Closing it means storing the encoded source file (the original PNG bytes, not
the decoded pixels) plus the Colors/Detail settings, and re-running decode +
quantize + trace on restore — cheaper to store, but it moves a multi-second
raster stage into the restore path, which today does no image work at all.

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
[src/geometry/assembly.ts](../src/geometry/assembly.ts) reports "Couldn't build
the cut solid for color … on …" — alarming, and indistinguishable from the
real failure it shares a message with. The overlaps are inherent to per-part
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
two stickers by their placed footprints, and treats two Fills on one zone as
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
(2) Warn only where the fill's ink actually lies under the sticker, which
needs the placed regions rather than the bounding boxes this check uses.
Start by measuring (1) on the wheel, where the fill region is small enough
to time honestly.

## The design-overlap check compares rectangles, and the cascade step is a constant

Two limits of [src/geometry/designOverlap.ts](../src/geometry/designOverlap.ts)
that were traded away deliberately when it landed, both worth knowing before
trusting or extending it.

**It compares placed bounding boxes, not artwork.** So it answers "could these
cut into each other", not "do they". A design whose ink sits inside another's
hollow — a logo centered in a frame, a caption inside a border — reads as
fully covered and warns, while the recesses never touch and the export is
fine. The warning is worded to admit the approximation rather than assert the
failure, but there is no way for the user to clear that pill short of breaking
the composition. Making it exact means intersecting the two designs' real
per-color regions, which is the boolean cost the check was written to stay off
(see the rebuild-performance section); the cheap half-measure is to compare
each design's total ink area against its bounding box and skip the pair when
one is mostly hollow.

**The cascade step is a constant and the warn threshold is a fraction, so they
only meet above a certain design size.** Stepping a second design diagonally by
`INSTANCE_CASCADE_MM` (8mm) leaves two w×w designs covering ((w−d)/w)² of each
other, which crosses `OVERLAP_WARN_FRACTION` only for w ≥ d/(1−√fraction). At
the 0.25 this shipped with that was 16mm, so the app could cascade two 12mm
stickers into an 11% overlap and say nothing about geometry it had positioned
itself; the threshold is 0.10 now, which moves the line to ~11.7mm. It does not
remove it — a small enough design still gets cascaded into a silent
sub-threshold overlap. Closing it properly needs the step to scale with the
design's placed size rather than being a constant, which means knowing that
size at load time: `cascadedOffset` runs in `state/artwork.ts` with only the
seed offset in hand, while the placed quad is computed later in the assembly
build. Either thread the zone's placer back to load time, or move the cascade
into the build and let it adjust a placement it can actually measure.

## The app says "surface" where its own vocabulary says "zone"

Convention 1 of [ui-conventions.md](ui-conventions.md) is one term per concept, and its table is
explicit: say `zone`, not `surface, region, face, area`. The app says `surface` in at least four
user-visible places — the zone-coverage notice ("N of M surfaces have artwork", `src/app/rebuild.ts`),
the per-zone template links in the Part panel ("Design templates (one per surface)"), the help
dialog ("Some parts have more than one design surface…"), and until this run the fill-refusal
warning ("Raise Scale to fill the surface"). The Artwork panel hint that used to be the fourth site
lost its zone sentence in the copy-tightening pass, which removes one instance without changing the
count of places the word appears.

Caught by a conventions review of the shipped screenshots, which cited the table. Not fixed
piecemeal on purpose: correcting one message while the other three say `surface` makes convention 1
_worse_, since the user then meets both words for one thing rather than one wrong word
consistently. Closing it is a single pass over every user-visible string plus the help dialog,
deciding once — and worth checking which way round: `zone` is the term the vocabulary table picks,
but `surface` is the one the app has actually been teaching users, and the table is the newer
document.

## "AMS slot", "filament slot", "filament" and "color" all name one thing

Convention 1 again, the sibling of the `surface`/`zone` item above and deferred for the same
reason. The rubric calls this out by name: "Today 'color', 'filament' and 'AMS slot' all name the
same thing in different places." The vocabulary table picks `filament`, and `slot (numbered)` for
the position it sits in.

Counted during the copy-tightening pass, across the sites that are user-visible:

| Says            | Where                                                                 |
| --------------- | --------------------------------------------------------------------- |
| "AMS slot"      | help dialog, the slot-count line, the capacity pill (`slotBudget.ts`) |
| "filament slot" | the Export hints, `partPanel.ts`                                      |
| "filament"      | the Auto-merge help ("collapse shading ramps toward fewer filaments") |
| "color"         | the panel heading "Colors detected", every row label                  |

Left alone deliberately. That pass covered explainer copy only, so the pill and the slot-count line
were out of scope; changing the help dialog alone would have made the user meet two words for one
thing instead of one inconsistent set. Same conclusion as the `surface`/`zone` item: closing it is
one pass over labels, help and warning strings together, deciding once. Note the same caveat too —
`AMS slot` is the term the printer's own UI uses and the one the app has been teaching, while
`filament` is what the newer table picks.

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

## Nothing benchmarks the geometry hot path on demand

The 5–10x figure above came from a one-off harness built for that upgrade
attempt and not kept. So the pin that decision produced is enforced by prose
and a `package.json` exact version — re-measuring it, or measuring anything
else on the union-accumulation path, means rebuilding the harness first.

Deliberately not built: a standing `bench-geometry` script would only be
exercised by an active turf upgrade, and there isn't one. The cost of writing
it now is real and the cost of re-deriving it later is roughly the same, so
this waits until a turf upgrade becomes live work — at which point it is step
one, not an afterthought. Closing it means a repeatable script over that hot
path at a few shape counts, with the 6.5.0 numbers above as the baseline to
beat.

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

## The things that check the code get audited less than the code they check

Five instances of one shape are now on record, four of them found on
2026-08-03:

- **`vite preview` served a `dist/` older than its own sources** (#123). Not a
  leftover process — a correctly started, freshly spawned server serving a
  build that predated the change under test. Every driven run read as passing
  while describing code no longer on disk.
- **`gh pr checks --watch` reported green on a run that had not started**
  (#125, hit on #124). Directly after `gh pr create` the checks are not yet
  registered, so gh prints "no checks reported" and exits 0 — the same exit
  code as a real pass.
- **`gh run watch` on the release deploy watched the _previous_ release's run.**
  The `release` skill resolved the run with `gh run list --limit 1` immediately
  after the tag push; until GitHub registers the new run, the newest one is the
  last release's — completed and successful — so the watch returned green in
  under a second. Found by auditing this section's own class after #125 landed,
  and confirmed against the live repo (watching v0.6.0's finished run exited 0
  instantly). The run is now pinned to the tag's commit and `headBranch`.
- **`#btn-export` staying enabled read as "the rebuild finished"** when it was
  still enabled from the _previous_ build, exporting stale geometry. Fixed
  earlier; the reasoning survives in `settledAfterRebuild()` in
  [scripts/lib/harness.mjs](../scripts/lib/harness.mjs).
- **The export-placement seal** — the section directly above — proves a mesh
  is unchanged, not that the pose was re-verified.
- **`newPage()`'s confirm-dialog auto-accept had stopped covering the app's
  confirms** — `page.on('dialog')` fires only for native `window.confirm`, and
  `src/ui/dialogs.ts` replaced those with a themed `<dialog>`. Selecting an
  assembly kind left the modal open and the old kind selected, so a script
  drove the wheel while its log said "chair". Fixed in `newPage()`; the doc
  comment that claimed the coverage is what made it invisible.

The common shape is a success signal derived from something adjacent to the
property being asserted, where the ambiguous case is indistinguishable from a
real pass at the point of use: same exit code, same enabled button, same green.

Worth being precise about the cause, because "be more careful" does not close
it. The same two files carry a thorough leftover-port guard and a hard error
when `MOSAIC_GPU=1` silently falls back to SwiftShader — both written to catch
exactly this kind of quiet wrong answer. The gap is not rigor. It is that code
gets reviewed and the things that check the code get trusted, so a checker that
under-verifies is the last place anyone looks.

The first deliberate look paid: four of
the five were found by tripping over them, and the fifth came from grepping the
repo for every other `gh run`/`gh pr checks` invocation right after #125 landed.
That took minutes and turned up a worse instance than the one that prompted it —
a false green from the wrong commit, on the go-live action.

**The systematic audit was walked on 2026-08-08** —
[docs/findings/indirect-success-signals.md](findings/indirect-success-signals.md),
covering `scripts/`, `scripts/lib/`, `.github/workflows/`, `.husky/`, the five
gates, the coverage floors and the `gh` waits in `.claude/skills/`. It found ten
more instances (two confirmed by measurement, the rest by reading) and four
things that looked like instances and held. The three starting points named
here are all in it: `waitForServer()` and `startPreview({ reuse: true })` stand
as written, and smoke's opening wait is finding 5. **Nothing in that report is
fixed** — it is a survey, so this section stays open and its list of instances
now lives there rather than growing here.

Closing this still means walking every place a success signal is derived
indirectly and either asserting the property itself or making the ambiguous case
fail loudly. The report ranks its findings by how much rests on them, which is
the order to take them in.

## Per-part export placement is a lookup table in [src/export/placement.ts](../src/export/placement.ts), not part of the part definition

It used to be an `if (roleId === …) else if …` chain; the
chair's fifteen pieces turned that into a `PLACEMENT` record keyed by
library part id, so adding a part is now a data change rather than a code
one. It still lives apart from the role it describes, though — these are
per-part constants and belong as data on the `AssemblyKind` / role
definition, matching the "one array entry" goal in
[src/assembly/kinds.ts](../src/assembly/kinds.ts).

## The footrest's baked `FOOTREST_PLATE_R` is redundant

It's redundant with the general
`rotXthenZ(-90 * nsign, angleDeg)` path for `nsign: 0` + `rotZdeg: -45`
(see [src/export/threemf.ts](../src/export/threemf.ts)). It's kept as an
explicit full 3×3 for now because it generalizes to a future part with a
genuinely tilted reference pose that the axis-aligned path can't express —
revisit if that part never materializes.

## Rect placement derives one artwork scale from the largest face across all parts

([src/geometry/assembly.ts](../src/geometry/assembly.ts),
`buildAssemblyGeometry`) while `placeOnPart` honors each part's _own_ face
center. Harmless today — the only rect kind (footrest) has a single face —
but a future rect assembly mixing face sizes would scale artwork for the
biggest face and then center that same oversized artwork on the smaller
ones, where the face clip would crop it. Fix when such a part ships: either
scale per-part, or make the reference face an explicit choice on the
`AssemblyKind` rather than "whichever is largest". Note the resolver
(`designMmPerUnit`) now has two callers — the build and the on-face gizmo,
which shares it precisely so the selection frame matches the cut — so a fix
has to keep them agreeing rather than change one.

## The CSG failure branches are proven against forced faults, not against a real malformed mesh

**Kept although the forced-fault half is closed**, for two reasons the
delete-on-close rule at the top allows: the untested half below is real open
work, and the baseline table is what
[scripts/check-csg-failure.mjs](../scripts/check-csg-failure.mjs) and the
`debug-csg-failure` skill assert against — those numbers are the reference, not
a record of a finished job.

The forced-fault half was open because the `CSG failure handling` tests in
[tests/assembly.test.ts](../tests/assembly.test.ts) drive every branch with a
mocked `Manifold.union` / `.difference` / `.intersection` — they pin what the
handler emits, but nobody had watched a branch fire against the real engine in
the running app.

[src/geometry/csgFault.ts](../src/geometry/csgFault.ts) now arms a forced
failure from the URL (`?csgfault=difference`, `?csgfault=color-union:1`) at the
five points where a real one originates, and
[scripts/check-csg-failure.mjs](../scripts/check-csg-failure.mjs) drives the
app through each, exports a real 3MF, and asserts the degradation that reaches
the file against an undamaged baseline. Run it with
`npm run build && node scripts/check-csg-failure.mjs`; the `debug-csg-failure`
skill is the walkthrough.

First full run (wheel, two-color SVG) — all five branches confirmed degrading as
documented. The body triangle counts are the measurement worth keeping, because
they are what distinguishes the two outcomes that otherwise look identical in
the file (one body, no inlays):

| Fault                       | Total inlays | Body triangles         |
| --------------------------- | ------------ | ---------------------- |
| none (baseline, 1 artwork)  | 4            | 45,214                 |
| `color-union:1` (2 artwork) | 3 (of 4)     | —                      |
| `part-union`                | 2 (of 4)     | 45,166 — **Cap** uncut |
| `difference`                | 0            | 44,930 — **uncut**     |
| `body-mesh`                 | 0            | 44,930 — **uncut**     |
| `intersection`              | 0            | 45,214 — **still cut** |

`intersection` matching the baseline exactly is the point: its pocket really is
cut and only the fill failed, which is the "prints as an empty recess" outcome
in [troubleshooting.md](troubleshooting.md). A change that collapsed it into the
export-uncut path would show up here as 44,930 and nowhere else.

`part-union` damaging one part rather than all three is also the point, and the
reason its check is per-part: the part-wide merge only runs on a part carrying
two or more colors, and on this artwork that is the Cap alone. Top and Bottom
come out identical to the baseline, which is the property worth asserting —
the failure stayed inside the part it happened on.

Not covered: the fault points force the _handler_ to run, so they prove the
degradation and the cleanup, not that Manifold fails on any particular real
mesh. Genuinely malformed input is still the untested half.

## Zebra + Fill still loses one color on "Handle (left)"

**Not currently reachable:** the chair body carries `withholdFill`, so Fill and
the pattern strip are both withheld there — this needs fixing before that flag
comes off, not before the next release. The defect below is unchanged.

Left over after the vertex-count fix below, measured on `MOSAIC_GPU=1`
production build, 2026-08-03: zebra in Fill mode on the chair's Left side
settles clean apart from a single
`Couldn't build the cut solid for color #0a0a0a on "Handle (left)"` — so that
part prints without the black, per the handling described in
[troubleshooting.md](troubleshooting.md).

This is not a regression from the thinning, but the thinning is what exposed
it. On the old asset the same part failed _earlier_, at the 2D union
(`Boolean union failed for color #0a0a0a on Handle (left)`), and fell back to
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
`Boolean union failed … (likely a self-intersecting path in the source SVG)`,
which names the wrong cause: the paths were fine, there were simply too many
of them.

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

## A design face keeps only one boundary loop, so a silhouette's inner rim is not an edge

`applyAsmPatchChoice` ([src/assembly/parts.ts:503](../src/assembly/parts.ts)) sorts the
loops `extractPatchBoundary` found and keeps exactly one:

```ts
loops.sort((a, b) => b.length - a.length);
part.boundaryLoop = loops[0] || null;
```

That was harmless while `boundaryLoop` only had to clip artwork to roughly the right
patch. The edge-cut-through rule gave it a second job — deciding which regions stand on
the part's outer wall — and a single loop can't answer it for a face with holes.

**What it costs.** A hubcap cut to a holed silhouette (a letter "O", a doughnut, a
character with an enclosed gap) has an inner rim that is just as much an outer wall as
the outside is, and artwork touching it is cut as a recess instead of through. The result
is a base-colour band around the hole while the outside rim prints correctly — the exact
defect the rule exists to remove, on part of the same part. Nothing warns, because from
the rule's point of view those regions genuinely don't reach the boundary it was given.

**A second, older hazard now load-bearing.** The sort key is _vertex count_, not area or
containment. An intricate cut-out can carry more vertices than the outline enclosing it,
in which case `loops[0]` is a hole and the clip runs against it — artwork clipped to the
inside of the gap rather than to the face. That has been reachable since the flat mapper
shipped; the edge rule now reads the same field, so it would also invert which regions
are called edges.

**Why it wasn't fixed with the rule.** Making `boundaryLoop` a loop _set_ with proper
outer/hole nesting is not a local change: `boundary()`, `faceXZBBox`, `fillExtent`,
zone-picking and the on-face gizmo all read it, and all of them currently assume one ring
— so the change lands on every shipped part's clip and fill behaviour, not just the
hubcap's. That is a bigger and riskier diff than the feature it would be riding along
with, and it wants its own live verification on the wheel and footrest.

**What closing it takes.** Give the patch a `boundaryLoops: number[][][]` resolved by
containment depth (the same rule `shapeToFeature` already uses for SVG rings — see
[src/geometry/regions.ts](../src/geometry/regions.ts)), build `boundary()` as a polygon
with holes, and keep `boundaryLoop` as the outer ring for the callers that only want a
bbox. Then erode the whole thing, which makes every hole's rim an edge for free —
`erodeBoundary` and `splitAtBoundary` already take multi-ring features and need no
change. Verify on a doughnut-shaped silhouette (inner rim prints in the artwork's colour)
and on the wheel and footrest (clip and fill unchanged).

## Convention 31 prescribes React files the design system deleted on purpose

[ui-conventions.md](ui-conventions.md)'s convention 31 says a change needing a
component the system lacks "proposes it as an addition — `Name.jsx`,
`Name.d.ts`, `Name.prompt.md`". `design-system/README.md`'s Fidelity section
says the `.jsx` and `.d.ts` files were deleted from the bundle permanently,
because the app is vanilla TypeScript on Vite and can never import a React
component. So the convention asks for an artifact set the design system
forbids.

The same Fidelity section also says, unconditionally, "Every component
documented here has a live counterpart in the app" — which filing any proposal
at all makes false. `docs/spikes/zone-first-selection.md` hit both halves at
once when it proposed `ZoneListRow` and `FilamentSlotStrip`; titling those
PROPOSED is a patch over the contradiction, not a resolution.

**What closing it takes.** Decide where proposals live — a
`components/proposed/` directory, or a Fidelity paragraph defining the tier as
distinct from documented components — and then drop convention 31's
`Name.jsx, Name.d.ts` clause, which is prescribing files this repo removed
deliberately. Both documents are authoritative in their own domain, so this
needs one edit to each rather than a reading that reconciles them.
