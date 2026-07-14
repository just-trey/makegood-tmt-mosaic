A single-line text or numeric field, monospaced — used throughout Mosaic for mm dimensions, offsets and depths.

```jsx
<TextInput type="number" value={diameter} onChange={setDiameter} min={1} step={1} />
```

Pair with a plain text label to its left (see the Panel row pattern) and a unit hint (e.g. "mm") to its right.
