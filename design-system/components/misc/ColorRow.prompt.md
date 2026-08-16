One row per detected SVG color: a drag grip, swatch, hex label, area share, and a per-color depth override.

Rendered by [src/ui/colorList.ts](../../../src/ui/colorList.ts) as plain DOM, not a component.

## Structure

```html
<div class="color-row" data-hexes="#e8a13a">
  <div class="top">
    <span class="drag-grip" aria-hidden="true" title="Drag to merge with another color">⠿</span>
    <div class="swatch" style="background:#e8a13a"></div>
    <div class="hex">#e8a13a</div>
    <div class="area">34.0%</div>
    <button class="btn small" data-add-base="#e8a13a">→ base</button>
  </div>
  <div class="depth-row">
    <label>depth</label>
    <input type="number" class="depth-input" value="1.20" />
    <span class="hint">mm</span>
    <span class="preset">≈ Bambu PLA Matte Ivory</span>
  </div>
  <div class="merge-row">
    <select class="merge-with">
      …
    </select>
  </div>
</div>
```

The outer class is `color-row`, not `row`. `.row` is a different, unrelated pattern: the flex
label-plus-field row used throughout the Panel forms (`src/styles.css`).

Three parts of that markup are conditional:

- `.merge-row` appears only when another mergeable target exists, and never on the background row.
- `.depth-row` gains a `↺` reset button (`button.depth-reset`) only while that row carries its own
  depth. The input also takes `.overridden` in that state.
- A merged group inserts `<div class="merge-members">` between `.top` and `.depth-row`.

The background row drops the drag grip and the `→ base` button, and its `.preset` reads `—`.

## Merging

**There is no selection checkbox and no bulk-merge button.** Merging is per-row, and there are
two equivalent affordances for it:

- **Drag** — the `.drag-grip` handle makes the row's top strip draggable onto another row. The
  grip is the handle, not the whole row, so the depth field below stays freely editable.
- **`select.merge-with`** — a "Merge with…" dropdown listing every other mergeable target. Its
  own tooltip states the equivalence: "same as dragging one onto the other." It is the
  keyboard-reachable path to the same operation, and it is omitted when no other target exists.

A merged row shows the group's dominant color as its swatch plus one `.member-swatch` per
member, each a button that pulls that color back out of the group. A swatch the user has pulled
out renders `.swatch.pinned` and is excluded from auto-merge until clicked again.

The background row is the exception: no drag grip, no merge dropdown.

## Notes

- Hex label is mono; the area percentage is fixed to one decimal.
- Depth is a per-color override of the global default, in mm.
- `→ base` (`button.btn.small[data-add-base]`) prints that color in the body instead of cutting
  it, replacing the current base. Dragging the row onto the Base row adds alongside instead. The
  two gestures on the same target have opposite meanings, which is deliberate and is the part of
  this component help text still has to carry.
- `.preset` closes the row with the nearest owned filament by name, or `—` on the background row.
