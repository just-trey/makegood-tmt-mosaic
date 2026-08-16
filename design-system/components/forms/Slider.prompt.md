A range input paired with an **editable** number input, two-way synced. Used for every Artwork fit
control: Margin, Scale, Offset X/Y, Rotation.

The number is a real input, not a readout. Typing in it moves the slider, and dragging the slider
rewrites it.

Rendered by [src/ui/fitPanel.ts](../../../src/ui/fitPanel.ts) (`syncPair`) as plain DOM, not a
component.

## Structure

```html
<div class="row">
  <label for="p-scale">Scale</label>
  <div class="field pair">
    <input type="range" id="p-scale" min="25" max="400" step="1" value="100" /><input
      type="number"
      id="p-scale-num"
      min="25"
      max="400"
      step="1"
      value="100"
      aria-label="Scale, exact value"
    />
  </div>
  <span class="hint">%</span>
</div>
```

- The two inputs sit inside `.field.pair` with no whitespace between them, so they read as one
  control.
- The unit (`%`, `mm`, `°`) is a trailing `.hint` outside the pair, never inside the number input.
- The visible `<label>` points at the **range** input, so the number input needs its own
  `aria-label`. The convention is `"<Name>, exact value"`.

## Which input wins

Two behaviours, chosen per control. The difference is what happens to a typed value outside the
slider's range.

| Kind                              | Source of truth | Typing out of range                   |
| --------------------------------- | --------------- | ------------------------------------- |
| Clamped (Margin, Scale, Rotation) | slider          | snaps back into range on blur         |
| Free (Offset X, Offset Y)         | number          | kept; the slider just pegs at its end |

Offsets are free because their slider travel is derived from the part's own footprint, and a user
may legitimately want the artwork further off it than the slider can express.

## Notes

- Dragging the slider rebuilds live, except on a model heavy enough that rebuilds are slow, where
  it rebuilds once on release instead. Typing in the number always schedules a rebuild.
- A control that does not apply is hidden by its `.row`, not disabled. Margin only feeds flat-mode
  auto-fit, so `#p-margin-row` is hidden entirely in assembly mode.
