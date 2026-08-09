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
| zone            | surface, region, face, area                             |
| design          | artwork, image, graphic                                 |
| Export 3MF      | Generate, Build, Create output                          |

1. One term per concept across UI labels, help text, warnings, errors, README. Today "color",
   "filament" and "AMS slot" all name the same thing in different places.
2. A warning names something the user can act on, in the user's words. "Couldn't build the cut
   solid for color #0a0a0a on Handle (left)" names an internal step. Its user-facing form is
   about a filament and a part.
3. A warning states one problem and one primary remedy. Alternatives belong in help, not in the
   pill. The current AMS-capacity pill offers three remedies in three lines of prose.

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

## Layout and disclosure

7. The left sidebar holds the current context, not every context. A section that cannot act on
   the current selection is collapsed or absent, not open and inert.
8. Nothing that acts on a selection appears when there is no selection. Disabled with a reason,
   or gone.
9. Order follows the task, and the task starts with _where_, not _what_. Choosing a surface
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

16. Filaments are presented as numbered slots with swatches, the way an AMS is — not as an
    unlabelled paint-picker grid.
17. The slot count currently being spent is visible **while designing**, against the selected
    printer's capacity. Today the AMS concept appears only inside a failure message.
18. The owned-filament palette is editable in the app. Editing `public/filaments.json` is not a
    UI.

## Legibility of color

The app decides which colors go where, so its chrome must never compete with the colors it is
showing. This is the one place where the behaviour layer constrains a visual choice, and the
constraint is structural rather than a token value.

19. **Selection is never communicated by tinting the selected thing an accent hue.** Selection
    reads as outline, contrast against dimmed surroundings, or a neutral-luminance treatment.
    `--accent-primary` is blue; blue is a filament a user owns. The worked example used to be the
    placement frame, which was accent blue drawn over artwork that is frequently also blue; it is
    a `--text` outline now. Note which of the three mechanisms that used — an outline alone is
    only as good as its luminance against what it crosses, and over a light part it measures
    1.50:1. Dimming the surroundings is the mechanism that does not depend on the artwork.
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

31. A change needing a component the system does not have proposes it as an addition —
    `Name.jsx`, `Name.d.ts`, `Name.prompt.md` — rather than inventing markup inline. Known gaps:
    zone list row, filament slot strip, viewport selection state, gizmo treatment.
32. Icons follow the system's existing rule: no hand-drawn SVG icon set. Where a part needs to
    be identified visually, a thumbnail rendered from the part is in-system; a hand-authored
    glyph is not.

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
