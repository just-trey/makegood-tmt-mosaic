# Analytics

Umami (cloud, cookieless) is injected at build time only when
`UMAMI_WEBSITE_ID` is set — see the "Analytics" section in
[README.md](../README.md). It always captures pageviews. This doc catalogs the
custom events layered on top via [src/analytics/track.ts](../src/analytics/track.ts).

## Rules

- **No PII, ever.** No file names, file sizes, or artwork/geometry contents in
  event props. Only low-cardinality categorical/numeric dimensions.
- **snake_case** event names; flat `{ key: string | number | boolean }` props.
- Fire from the DOM handler that represents real user intent — not from
  shared functions that also run during app init or on every rebuild.
- `track()` is a no-op when `window.umami` isn't present (dev, forks) — no
  guards needed at call sites.

## Events

### `artwork_load`

Fired when artwork is loaded into the scene.

- **Where:** [src/ui/artworkPanel.ts](../src/ui/artworkPanel.ts) — `loadSVGFile` (upload via click-browse or drag-drop) and the `#btn-sample` handler.
- **Props:** `{ source: 'upload' | 'sample' }`

### `artwork_removed`

Fired when the user removes the loaded artwork from the Artwork panel's list
row.

- **Where:** [src/ui/artworkListPanel.ts](../src/ui/artworkListPanel.ts) — `.artwork-remove` click handler in `renderArtworkList`.
- **Props:** none.

### `artwork_instance_added`

Fired when the user places an already-loaded design onto a second zone via a
row's "+zone" button.

- **Where:** [src/ui/artworkListPanel.ts](../src/ui/artworkListPanel.ts) — `.artwork-add-zone` click handler in `renderArtworkList`.
- **Props:** none.

### `artwork_instance_zone_changed`

Fired when the user retargets an artwork instance's zone binding from its row
dropdown.

- **Where:** [src/ui/artworkListPanel.ts](../src/ui/artworkListPanel.ts) — `.artwork-zone` change handler in `renderArtworkList`.
- **Props:** `{ zone: string }` (the zone id, or `'all'` for the unbound/"every zone" option)

### `mode_switch`

Fired when the user changes the part-shape mode.

- **Where:** [src/ui/partPanel.ts](../src/ui/partPanel.ts) — `#shape-kind` change handler in `initPartPanel`.
- **Props:** `{ kind: 'assembly' | 'disc' | 'rect' | 'round' | 'stl' }`

### `template_download`

Fired when the user downloads an assembly kind's design template from the Part
panel.

- **Where:** [src/ui/assemblyPanel.ts](../src/ui/assemblyPanel.ts) — `#asm-template-link` click handler in `initAssemblyPanel`.
- **Props:** `{ kind: string }` (`state.assembly.kindId`, e.g. `wheel` / `footrest`)

### `export`

Fired on a successful export, just before the file download starts.

- **Where:** [src/ui/exportPanel.ts](../src/ui/exportPanel.ts) — `exportPrintReady3MF` and `exportSTLSet`.
- **Props:**
  - `format: '3mf' | 'stl_zip'`
  - `mode: 'assembly' | 'flat'`
  - `printer: string` (`state.printerId`)
  - `colors: number` (material/color count)
  - `warnings: number` (3MF only — placement warnings emitted)

### `export_failed`

Fired when an export throws, in the same handlers as `export`.

- **Props:** `{ format: '3mf' | 'stl_zip' }`

### `fit_adjust`

Fired when the user commits a move/scale/rotate change to the artwork
placement — on slider release (`change`) or on pointer-up from an on-face
gizmo drag in the 3D viewport. Not fired on every intermediate `input` tick,
only once per gesture.

- **Where:** [src/ui/fitPanel.ts](../src/ui/fitPanel.ts) — `syncPair`'s
  slider `change` handler (Scale/Offset X/Offset Y/Rotation).
  [src/scene/designGizmo.ts](../src/scene/designGizmo.ts) — `onPointerUp`.
- **Props:**
  - `via: 'drag' | 'slider'`
  - `field: 'move' | 'scale' | 'rotate'`

## Future / not yet wired

Candidates for a later pass, roughly in order of likely value. Follow the same
pattern: wire at the DOM handler, add the entry here, keep props PII-free.

- `assembly_kind_select` — `src/ui/partPanel.ts`, `#shape-kind` change handler (the `asm:` branch). Prop: `kindId`. `mode_switch` already fires here but only records `kind: 'assembly'`, not which one — `wheel`, `footrest`, and `wheel-mount-left` all exist today, worth wiring as more parts ship.
- `base_color_change` — `src/ui/partPanel.ts`, `renderBaseColorSwatches` swatch click. Prop: `default` vs `filament`.
- `automerge_change` — `src/ui/colorList.ts`, `#p-automerge` slider. Prop: `level` (0-3).
- `color_merge` / `color_to_base` — `src/ui/colorList.ts` drag-merge and "→ base" actions. Prop: resulting group size.
- `fit_reset` — `src/ui/fitPanel.ts`, `#btn-reset-fit`.
- `fit_flip` — `src/ui/fitPanel.ts`, flip checkboxes.

## Adding a new event

1. Add a `track('event_name', { ...props })` call at the DOM handler for the
   action (see the pattern in the three modules above).
2. Add an entry to this catalog (event, where, props).
3. If the change also adds/removes/renames a left-panel control, remember
   the [index.html](../index.html) `#help-dialog` also needs updating (see
   CLAUDE.md) — the two often go together.
