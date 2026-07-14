A dropdown selector where each option shows a small thumbnail + label (+ optional meta line), for picking among visual items — e.g. a library part (STL/3MF) or an assembly role's linked file. Extends the plain Select pattern for cases where a bare label isn't enough to tell options apart at a glance.

```jsx
<ThumbnailSelect
  value={partId}
  onChange={setPartId}
  options={[
    { value: 'wheel-top', label: 'Wheel — Top', thumbnail: 'thumbs/wheel-top.png', meta: 'stl/wheel-top.stl' },
    { value: 'wheel-cap', label: 'Wheel — Cap', thumbnail: 'thumbs/wheel-cap.png', meta: 'stl/wheel-cap.stl' },
  ]}
/>
```

Closes on selection; click the trigger again to reopen. Options without a `thumbnail` fall back to an empty placeholder square rather than an icon.
