A row of mutually-exclusive buttons — used for the base-part shape picker (Disc / Rect / Round rect / STL ref / Assembly).

```jsx
<SegmentedControl
  options={[
    { value: 'disc', label: 'Disc' },
    { value: 'rect', label: 'Rect' },
  ]}
  value={shape}
  onChange={setShape}
/>
```
