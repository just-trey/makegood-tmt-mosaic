One row per detected SVG color: a drag grip, swatch, hex label, area share, and a per-color depth override.

Rendered by [src/ui/colorList.ts](../../../src/ui/colorList.ts) as plain DOM, not a component.

## Structure

```html
<div class="row">
  <div class="top">
    <span class="drag-grip" title="Drag to merge with another color">⠿</span>
    <div class="swatch" style="background:#e8a13a"></div>
    <div class="hex">#e8a13a</div>
    <div class="area">34.0%</div>
    <select class="merge-with">
      …
    </select>
  </div>
  <div class="depth-row"><label>depth</label>…</div>
</div>
```

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
