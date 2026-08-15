# FilamentSlotStrip — PROPOSED, not built

**Status: a proposal, not a spec of anything that exists.** Same standing as `ZoneListRow.prompt.md`
— see the note at the top of that file. Named as a known gap by convention 31 of
`docs/ui-conventions.md`.

## Purpose

What the design is spending, in the vocabulary the audience already has: **numbered AMS slots**.

Conventions 16 and 17. Today the owned-filament palette is a 14-swatch grid with no numbering, and
the number of slots a design is using appears only inside the capacity warning — so the user learns
the cost at the moment it has become a problem, rather than while there is still a cheap decision
to make. `docs/audience.md`: these are people who "know what AMS / AMS Lite is and how a filament
slot works", budgeting a scarce resource.

The strip is proposed alongside the zone-first work rather than on its own because that work makes
the question louder: five surfaces each with their own design is five chances to add a colour, and
the total is the thing nobody is watching.

## Structure

One horizontal strip, full panel width, in slot order:

```
 1    2    3    4    5           5 / 4 slots
[■]  [■]  [■]  [■]  [■]
```

- **Slot number** above each swatch, mono, `--text-meta`, `--text-dim`. Numbered from 1. The
  number is the point — an AMS bay has a number on it.
- **Swatch**, square, 0 radius (README: "swatches square (0px)"), `--space-hair` gaps.
- **Count**, right-aligned, mono, `--text-meta`: `N / M slots`, where M is the selected printer's
  capacity. Present always, not only when over — that is convention 17.

Slots past capacity keep their number and swatch and are marked over the line — so the strip shows
_which_ colours those are, not just that there are too many. **Not with a `--danger` border**: the
thing being outlined is an arbitrary filament colour the user picked, so a pink ring around a pink
filament is the same collision conventions 19 and 21 exist to prevent, moved to a new place. A
conventions review caught that in the first draft of this spec.

Mark them by **position and rule instead**: a 1px `--line` vertical rule between slot M and slot
M+1, and everything past it at 0.6 opacity — over-capacity reads as "these are outside the
machine", which is what it means, and it survives any filament colour. The count text is the one
place `--danger` is right, since it is chrome rather than a swatch. No pill, no sentence: the
capacity warning that already exists says the sentence, and convention 3 wants one problem stated
once.

## States

| State           | Treatment                                                           |
| --------------- | ------------------------------------------------------------------- |
| within capacity | swatch, 1px `--line` border                                         |
| over capacity   | past a 1px `--line` rule, at 0.6 opacity; the count text `--danger` |
| body slot       | slot 1, labelled `body` under the number rather than a filename     |
| hover           | border to `--accent`, as every other swatch                         |

## Behaviour

Read-only in this proposal. Merging, base assignment and depth all live in `Colors detected`
already, and duplicating them here would be the "features nobody needs" failure the subtraction
lens exists for. The strip's job is to make the count visible while designing, which is the half
convention 17 says is missing.

## Tokens

Nothing new. `--line`, `--text-dim`, `--danger`, `--accent`, `--text-meta`, `--space-hair`,
`--space-tight`. `--danger` appears on chrome only (the count), never around a swatch.

## What this does not solve

Convention 18 — "the owned-filament palette is editable in the app; editing
`public/filaments.json` is not a UI" — is a separate, larger thing, already on the roadmap. This
strip shows what is being spent; it does not let anyone change what is available to spend.
