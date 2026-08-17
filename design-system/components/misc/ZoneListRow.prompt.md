# ZoneListRow — PROPOSED, not built

**Status: a proposal, not a spec of anything that exists.** The proposed tier is defined in
`design-system/README.md`'s Fidelity section, which excludes these files from its live-counterpart
claim; convention 31 of `docs/ui-conventions.md` is what requires filing one instead of inventing
markup inline, and it names `zone list row` as a known gap. Filed in `misc/` alongside `ColorRow`,
which is the same kind of thing; `layout/` holds the Panel section shell, and a review of the first
draft rightly said a row is not one.

Written against the throwaway prototype in `spike/zone-first-selection`
(`src/ui/zoneListPanel.spike.ts`) and the design note in `docs/spikes/zone-first-selection.md`.
**Do not build from this until that work is accepted.** If it is rejected, delete this file.

## Purpose

One design zone of the current part, listed whether or not anything is on it. The row is how a
user answers "where does this go?" before choosing a file — convention 9, "order follows the task,
and the task starts with _where_, not _what_."

It is a **list row that is also a drop target**, which is the pairing convention 15 asks for:
"files are dropped onto the thing they apply to. Where a target is identifiable under the cursor,
dropping there assigns there, with no rebinding step afterwards."

## Structure

A single row, full panel width, in zone order as the part declares it:

```
[ Left side                                     badge.svg ]
[ Back                                              empty ]
```

- **Name**, left, sans, `--text-body`, `--text`. The zone's own name from the bake
  (`DesignZone.name`) — "Left side", "Back", "Front", "Right side", "Seat". Never an id.
- **Slot**, right, mono, `--text-meta`, `--text-dim`. The bound design's filename, or the word
  `empty`. Mono because it is a filename, per the README's mono/sans split.

Nothing else. In particular **no thumbnail and no per-row controls**: a row that carries a mode
select, a zone select and a remove button is `ColorRow`, and the reason this component is being
proposed at all is that the zone list should be the thing you scan, not the thing you operate.

## States

| State        | Treatment                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------- |
| resting      | `--panel-2` fill, 1px `--line` border, `--radius-lg` (2px)                                      |
| hover        | border to `--accent` — matches every other row and input in the app (README → States)           |
| **selected** | 1px `--text` border **plus** a 1px `--text` outline, i.e. weight, not fill                      |
| empty        | slot text italic at 0.7 opacity; the row is otherwise identical — empty is normal, not an error |
| drag-over    | border, text and a faint wash to `--accent`, exactly as `Dropzone` does                         |

**Selected is deliberately not an accent tint**, and this is the one place this spec argues with
the app as it stands. `.artwork-row.active` uses `border-color: var(--accent)` with
`--accent-wash`; convention 19 says selection is never an accent hue laid over the thing selected,
and a zone row's whole subject is which colour goes on that zone. `--text` weight against
`--panel-2` reads as selection without spending a hue. The placement frame in the viewport was
moved off accent for the same reason in this run — the two should match, since convention 11 says
selection is visible in both the viewport and its list row.

## Behaviour

- **Click selects; clicking the selected row deselects it** (convention 11).
- **Selection is two-way with the viewport** (convention 11): picking the zone in the 3D view
  selects this row, and selecting this row highlights that zone and puts the placement frame on
  it.
- **Hover highlights the zone in the viewport** before any click commits (convention 10).
- **Dropping a file on the row binds it to that zone**, with no rebinding step (convention 15).

## Tokens

Nothing new. `--panel-2`, `--line`, `--text`, `--text-dim`, `--accent`, `--radius-lg`,
`--text-body`, `--text-meta`, `--space-tight`.

**Rows are separated by `--space-row` (8px).** Stated because the prototype left them 1px apart and
a review measured it: `--space-hair`'s own comment says "Never rhythm between rows — that is
`--space-row` up."

**The list goes above the Artwork dropzone, not below it.** Also from that review, and it is the
whole point rather than a layout preference: in the prototype the rows sat under the file picker and
the fifth was clipped by the panel edge, which puts the _where_ step below the _what_ step and
inverts convention 9 while the component itself satisfies it.

**Use `var(--mono)` for the slot text.** The spike prototype's own CSS referenced a `--font-mono`
that is declared nowhere and silently fell back to the UA monospace. That was the prototype's bug
and never the app's: `src/styles.css` has no `--font-mono` reference in any revision, and all 13 of
its mono sites use `var(--mono)` and resolve to IBM Plex Mono. Don't copy the prototype's spelling
when building this.
