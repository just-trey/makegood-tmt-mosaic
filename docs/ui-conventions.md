# UI conventions

**Behavioural rules only.** Visual language is owned by the MakeGood design system
(`design-system/`) — colors, type, spacing, radius, states, and the component set are settled
there and this file does not restate or override them. Where this file needs a visual outcome
it names the outcome and leaves the values to the tokens.

Read together:

| Question                                                           | Authority                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------- |
| What color, what size, what radius, what hover state               | `design-system/tokens/*.css`, `design-system/README.md` |
| Which component, what props, what states                           | `design-system/components/<cat>/<Name>.prompt.md`       |
| What this screen contains and in what order                        | `design-system/ui_kits/mosaic/preview.html`             |
| **How it behaves, and what the user should never have to be told** | **this file**                                           |

**Why a behaviour layer exists.** The design system was reverse-engineered from the current app
and is deliberately high-fidelity to it. That makes it authoritative on _look_ and silent on
_model_ — it faithfully describes an interface whose standing complaint is that it is confusing.
Nothing here contradicts it. These are the rules the visual system cannot express.

**Who we are designing for.** Makers who already run Bambu Studio or Orca. The goal is
**familiarity, not resemblance.** They should find things without being taught and never meet a
gesture that works differently here.

Written as numbered assertions so a reviewer can cite them.

---

## Vocabulary

Cheapest familiarity there is. The design system's voice rules (precise, technical, units over
adjectives, second person for UI copy) still apply; this is the term list.

| Say             | Not                                                     |
| --------------- | ------------------------------------------------------- |
| filament        | color channel, color slot, palette entry                |
| slot (numbered) | index, channel number                                   |
| body color      | blank color                                             |
| part            | mesh (except where a raw uploaded STL genuinely is one) |
| zone            | surface, region, area                                   |
| design face     | surface, face                                           |
| design          | artwork, image, graphic                                 |
| Export 3MF      | Generate, Build, Create output                          |

1. One term per concept across UI labels, help text, warnings, errors, README. Three concepts
   that used to blur together, now settled: a **color** is what the artwork has, a **filament** is
   what prints it, and a **slot** is the numbered position it sits in. Likewise a **zone** is one
   of several named design areas on a part that has them, and a **design face** is the single area
   on a part with one. `surface` names none of these and appears in no user-facing string.
   **Vendor names are not category names**: `AMS` is Bambu's, and the Snapmaker U1 feeds from a
   built-in toolchanger, so any string naming the hardware reads it off the selected printer
   (`Printer.unitLabel`) rather than hardcoding one.
2. A warning names something the user can act on, in the user's words. "Couldn't build the cut
   solid for color #0a0a0a on Handle (left)" names an internal step. Its user-facing form is
   about a filament and a part.
3. A warning states one problem and one primary remedy. Alternatives belong in help, not in the
   pill. The capacity pill was the worked violation, carrying three remedies across three lines
   of prose; it now names hand-merging alone and the rest live in the help dialog.

## Explaining itself

4. **No control's explanation may reference a control in another panel.** If it must, the model
   is wrong and the layout should change rather than the copy grow. Worked example: "Body /
   blank color … To print an artwork color as the body instead, use '→ base' (or drag it onto
   the Base row) in Colors detected further down."
5. Prose in a panel is a symptom. A panel needing multiple sentences to explain what its
   controls do to each other is describing a relationship that should be visible instead.
6. Help that explains a _concept_ (SVG traces sharper than PNG) belongs at the point of use.
   Help that explains a _mechanism_ (how zones and designs relate) belongs in the help dialog,
   and needing it in-panel means the mechanism isn't legible.

4–6 decide _where_ an explanation goes and _whether_ it should exist. **Plain language (33–37
below) decides how it is written**, and applies wherever it lands.

## Layout and disclosure

7. The left sidebar holds the current context, not every context. A section that cannot act on
   the current selection is collapsed or absent, not open and inert.
8. Nothing that acts on a selection appears when there is no selection. Disabled with a reason,
   or gone.
9. Order follows the task, and the task starts with _where_, not _what_. Choosing a zone
   precedes choosing a file.

## Selection and direct manipulation

10. Hover highlights what is under the cursor before any click commits to it.
11. Click selects; clicking a selected thing deselects it. Selection is visible in both the
    viewport and its list row, and clicking either selects both.
12. Picking hits what is visible. A click on a part in front never selects something behind it.
13. A gizmo is aligned to the frame of the thing it acts on. A gizmo at an arbitrary angle is a
    bug, not a preference.
14. One manipulation affordance at a time. Corner handles and an axis handle competing for the
    same drag is two tools drawn at once.
15. Files are dropped onto the thing they apply to. Where a target is identifiable under the
    cursor, dropping there assigns there, with no rebinding step afterwards.

## Filaments

16. Filaments are presented as swatches carrying their filament name, not as an anonymous
    paint-picker grid. **Slot numbers are the exception, and settled against**: the colour list is
    ordered by area so people can find a row, while the file assigns slots in palette order, and a
    row numbered by its position would name a slot the export does not use. A number a maker loads
    their AMS from has to be the file's or not exist. The reasoning is on the sort in
    `src/ui/colorList.ts`; the slot _count_ is on the line below the list, which is the number a
    decision actually turns on.
17. The slot count currently being spent is visible **while designing**, against the selected
    printer's capacity, and the Export panel says what the file will contain before the button is
    pressed (24). Both are live.
18. The owned-filament palette is editable in the app. Editing `public/filaments.json` is not a
    UI.

## Legibility of color

The app decides which colors go where, so its chrome must never compete with the colors it is
showing. This is the one place where the behaviour layer constrains a visual choice, and the
constraint is structural rather than a token value.

19. **Selection is never communicated by tinting the selected thing an accent hue.** Selection
    reads as outline, contrast against dimmed surroundings, or a neutral-luminance treatment.
    `--accent-primary` is blue; blue is a filament a user owns. The placement frame used to be the
    worked violation and is now a neutral outline. Note which of the three mechanisms that picks:
    an outline is only as good as its luminance against whatever it crosses, so it can satisfy this
    convention and still be hard to see. Dimming the surroundings is the one mechanism that does
    not depend on the artwork underneath.
20. Excluded or unselected geometry greys back — and grey must not simultaneously be a
    selectable filament presentation, or "not printing here" and "printing in grey" look alike.
21. Any overlay carrying meaning (hidden-surface hatching, warning highlight) is distinguishable
    from artwork by pattern or motion, not by hue alone.

## Reversibility and honesty about cost

22. Undo covers anything done deliberately: merges, base assignment, placement, depth.
23. Any operation that can exceed a few seconds is cancellable and names what it is working on.
24. An action that produces something large or slow says what it is about to produce first. An
    unlabelled button that emits a multi-day print is not acceptable.
25. Losing work is never silent. If something will not survive a save, say so when it matters,
    not in the README.

## What we do not take from Orca

The failure mode here is adding. The standing complaint is features nobody needs.

26. No parameter tree, no print/filament/printer profile dropdowns, no per-object process
    overrides.
27. No slice button, no layer scrubber, no toolpath preview. We do not slice.
28. No support painting, no seam painting, no auto-arrange, no auto-orient. The part library is
    fixed and its orientation is a solved input.
29. No device or send-to-printer surface.
30. Borrowing the _shape_ of a slicer idea is fine where it earns its place. The Prepare/Preview
    split is the candidate: a view showing the actual per-color recesses about to print, per
    filament slot, is the trust step slicer users expect and we have no equivalent.

## Extending the design system

31. A change needing a component the system does not have proposes it as an addition, a
    `Name.prompt.md` titled `PROPOSED, not built`, rather than inventing markup inline. A spec is
    the whole proposal: `design-system/README.md` deleted the `.jsx` and `.d.ts` files
    permanently, so asking for them here would prescribe files that bundle forbids. The proposed
    tier is defined in that README's Fidelity section and sits outside its live-counterpart
    claim. Known gaps: zone list row (filed), viewport selection state, gizmo treatment. The
    filament slot strip is also filed, but its numbering half is settled against by 16, so read
    that file's own header before building from it.
32. Icons follow the system's existing rule: no hand-drawn SVG icon set. Where a part needs to
    be identified visually, a thumbnail rendered from the part is in-system; a hand-authored
    glyph is not.

## Plain language

Applies to every user-facing string: help dialog, panel copy, labels, warnings, notices, errors.
Not to `docs/`, which are working notes, or to code comments.

**This is not a reading-age rule.** The reader is a maker who runs a slicer daily. Writing down to
them is its own failure, and the usual symptom is length: a sentence that stops to explain a word
they have used a hundred times. The audience is technical. It is technical in _printing_, not in
CAD ([audience.md](audience.md)).

So the line is not simple versus technical. It is **their vocabulary versus ours**.

**The test**: would this word appear in Bambu Studio's or Orca's UI, or in a Printables comment
thread? If yes, it is free, use it. If no, it is ours and it has to go.

| Free, they own it                                                          | Ours, replace it                                            |
| -------------------------------------------------------------------------- | ----------------------------------------------------------- |
| filament, slot, layer height, bed, plate, prime tower, seam, infill, purge | quantize, boolean, cut solid, mesh operation, build stage   |
| 3MF, STL, SVG, mm, gradient, trace, tile, bounding box                     | viewBox, normal, plane offset, chart, LSCM, patch, manifold |

**A word they own can still be the wrong word.** `AMS` passes the test above for a Bambu owner and
fails it for a Snapmaker one, whose U1 feeds from a built-in toolchanger and has no AMS to speak
of. That is why it left the free column: a vendor's name for its hardware is read off the selected
printer (`Printer.unitLabel`, convention 1), never written into a string.

This does not contradict the design system's voice rule (precise, technical, units and specifics
over adjectives). The two govern different things:

33. **Their words, real numbers.** This governs vocabulary and sentence shape. The design system
    governs the specifics inside them, and it still wins there. Dropping `0.2mm` to sound
    friendlier violates this convention. So does keeping `clamped to the layer floor` to sound
    precise. Say what happened in words the reader already owns, then give the number.
34. **Name the thing on screen, not the step inside.** A user has a part, a color, a recess, a
    file. They do not have a solid, a boolean, a mesh operation or a build stage. Convention 2
    says this for warnings; 34 is the same rule over every string.
35. **Never explain a word they already own.** Defining `filament` or `layer height` reads as
    condescension, and it is where the rambling starts. The counterpart holds for the other
    column: a term of ours that cannot be avoided is defined at first use, in a few plain words,
    once. If it cannot be defined in a few plain words, it is the wrong term.
36. **Removing jargon must not make the sentence longer.** A one-word replacement, or fewer words
    than before. If the plain version runs longer, the sentence was carrying an explanation it
    did not need, and the fix is to cut the explanation rather than to pad the word. This is the
    rule that keeps 33 from turning help text into a lecture.

The vocabulary table at the top settles which of two ordinary words to use. This one settles terms
that are not ordinary at all. Both columns are quoted from shipped copy, not invented pairs, and
every row obeys 36: the replacement is shorter than or the same length as what it replaces.

| Say                                  | Not                                | Shipping today in           |
| ------------------------------------ | ---------------------------------- | --------------------------- |
| reduced to flat colors               | quantized                          | Artwork hint, help dialog   |
| near-identical copies                | near-identical export artifacts    | help dialog                 |
| gradients                            | shading ramps                      | help dialog                 |
| the group's main color               | the dominant member                | help dialog, `colorList.ts` |
| angled edge                          | chamfered edge                     | help dialog                 |
| traces the edges                     | traces the result back to outlines | help dialog                 |
| Rebuilding the part…                 | Rebuilding geometry…               | `scheduler.ts` overlay      |
| Couldn't cut color <hex> into <part> | Couldn't build the cut solid       | assembly CSG warnings       |

Two terms were on this table and came off it. `tileable` and `bounding box` are both free by the
test above, and both replacements ran longer, which is 36. Leave them alone.

37. Numbers a user cannot act on are diagnostics, not copy, and live behind a disclosure that says
    so. `face detected: normal (0.00, 1.00, 0.00), plane offset 24.25mm, 104-pt boundary` is
    correctly placed (it sits under "Advanced: per-part face & alignment") and correctly worded
    for what it is. Reading it as a convention-33 violation is a misread; moving it out from
    behind that disclosure would be the violation.

### How to run a copy pass against 33-37

The conventions above verify one string. They do not say how to rework a set of them, and
word-for-word substitution is how a copy pass makes things worse: it keeps the sentence that was
built around the jargon and pads it.

- **Rewrite by sentence purpose, not by word.** Ask what the reader needs to _do_, then write that
  fresh. Measured on the help-dialog pass: 2362 words to 2327, longest sentence unchanged at 21,
  no paragraph or section lost.
- **Count after rewriting, don't judge by eye.** Two rewrites on that pass merged sentences while
  removing a term and pushed the longest from 21 words to 28, which is convention 36 failing in
  the exact place it was written to guard. Count words excluding standalone punctuation: an em
  dash is not a word, and the CSG-warning pass initially read three strings as over-length because
  of it.
- **Watch for the substitution reflex in the table itself.** Five rows of the jargon table above
  were written by substitution on that pass and had to be fixed before they merged.
- **Some of ours are theirs.** `tileable` and `bounding box` were both counted as violations in a
  draft and are not: both pass the slicer test, and both plain replacements ran longer. A copy
  pass must not "fix" them.

---

## Conflicts between this file and the current app

The conflicts this file was written against are **not listed here**. Open known-wrong behavior
lives in [tech-debt.md](tech-debt.md), one section per item, and unbuilt work lives in
[roadmap.md](roadmap.md) — a rubric that also carries its own findings list drifts from those two
the first time one of them is fixed.

Those sections cite convention numbers, so `grep -rn 'ui-conventions' docs/` is the index. When
this file landed, conventions 3, 4, 13–14, 16–18 and 19–21 had open conflicts, 9/15 described a
data-model change already tracked as a roadmap item, and 32 constrained an unbuilt one. None were
fixed. None were measured by an audit either — they were asserted against a screenshot, which is
why the tech-debt sections say so rather than presenting them as measurements.

## Using this as a review rubric

Give a reviewer this file, the design system README and tokens, the relevant `*.prompt.md`, and
a screenshot of the change. **No diff, no statement of intent.** Two questions: which numbered
conventions does this violate, and which does it newly satisfy. Every finding cites a number. A
review that says "looks good," or that reasons about code rather than the image, has not used
the rubric — run it again.
