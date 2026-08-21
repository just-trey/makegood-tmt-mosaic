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

- **Where:** [src/ui/artworkPanel.ts](../src/ui/artworkPanel.ts) — `loadArtworkFile` (SVG upload via click-browse or drag-drop), `applyRasterFile` (a PNG/JPG/WebP through the same dropzone), the `#btn-sample` handler, and `applyPattern` (built-in pattern picker strip).
- **Props:** `{ source: 'upload' | 'sample' | 'pattern' | 'raster' }`, plus `pattern: string` (the pattern id, e.g. `cow`) when `source` is `'pattern'`. `'raster'` covers any decoded image; the format is not recorded.

### `raster_adjust`

Fired when the user commits a change to a loaded image's Colors or Detail
slider — on `change` (drag release), not on every intermediate `input` tick,
matching `fit_adjust`. Not fired when the re-trace threw and the slider was put
back, since nothing was committed.

- **Where:** [src/ui/artworkListPanel.ts](../src/ui/artworkListPanel.ts) — the `.raster-colors` and `.raster-detail` change handlers in `rasterControls`.
- **Props:** `{ field: 'colors' | 'detail' }`. Deliberately not the value: it would be a per-image fingerprint of the artwork, and the rules above rule that out.

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

### `artwork_mode_changed`

Fired when the user switches an artwork row between placing one copy and
repeating the design across the whole design face.

- **Where:** [src/ui/artworkListPanel.ts](../src/ui/artworkListPanel.ts) — `.artwork-mode` change handler in `renderArtworkList`.
- **Props:** `{ mode: string }` (`'sticker'` or `'fill'`)

### `chair_variant_selected`

Fired when the user switches the chair's hardware variant (Standard/Kit),
after any confirm() dialog is accepted.

- **Where:** [src/assembly/parts.ts](../src/assembly/parts.ts) — `switchChairVariant`.
- **Props:** `{ variant: string }` (the variant id, e.g. `standard` / `kit`)

### `zone_selected`

Fired when the user clicks a zone directly in the 3D viewport, binding the
active artwork instance to it.

- **Where:** [src/scene/zonePick.ts](../src/scene/zonePick.ts) — `onPointerUp`.
- **Props:** `{ zone: string }` (the zone id)

### `mode_switch`

Fired when the user changes the part-shape mode.

- **Where:** [src/ui/partPanel.ts](../src/ui/partPanel.ts) — `#shape-kind` change handler in `initPartPanel`.
- **Props:** `{ kind: 'assembly' | 'disc' | 'rect' | 'round' | 'stl' }`

### `template_download`

Fired when the user downloads an assembly kind's design template from the Part
panel — either the single per-kind template, or (for a part with more than
one design zone, like the chair body) one of the per-zone templates.

- **Where:** [src/ui/assemblyPanel.ts](../src/ui/assemblyPanel.ts) — `#asm-template-link` click handler in `initAssemblyPanel`, and the per-zone link handlers in `renderZoneTemplateLinks`.
- **Props:** `{ kind: string }` (`state.assembly.kindId`, e.g. `wheel` / `footrest`), plus `zone: string` (the zone id) on a per-zone download

### `build_param_changed`

Fired when the user commits a change to an assembly kind's numeric build
parameter — today the hubcap's disc diameter. On the input's `change` (blur or
Enter), not per keystroke, and only when the value actually moved: the same
handler is what regenerates the part's mesh.

Deliberately **not** fired when the app re-clamps the value itself, which
happens when switching to a printer whose plate is smaller than the current
diameter — that is the app correcting state, not user intent (see the `Rules`
below). The diameter is rounded to a whole millimetre, so the prop is a size
band rather than a fingerprintable exact value.

- **Where:** [src/ui/assemblyPanel.ts](../src/ui/assemblyPanel.ts) — `applyBuildParam`, called from the `#p-asm-buildparam` change handler in `initPartPanel`.
- **Props:** `{ kind: string }` (`state.assembly.kindId`, e.g. `hubcap`), `param: string` (the state key, e.g. `hubcapDiameterMm`), `value: number` (millimetres, rounded)

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

### `session_restored`

Fired when the user accepts the restore-session banner offered on load after
a previous visit left loaded artwork behind.

- **Where:** [src/ui/restoreBanner.ts](../src/ui/restoreBanner.ts) — `#btn-restore-session` click handler.
- **Props:** none.

### `session_restore_dismissed`

Fired when the user declines the restore-session banner ("Start fresh").

- **Where:** [src/ui/restoreBanner.ts](../src/ui/restoreBanner.ts) — `#btn-restore-dismiss` click handler.
- **Props:** none.

### `hubcap_silhouette_toggled`

Fired when the user flips the hubcap's **Cut to artwork shape** checkbox,
either direction.

- **Where:** [src/ui/assemblyPanel.ts](../src/ui/assemblyPanel.ts) — `applyHubcapSilhouette`, called from the `#p-asm-silhouette` change handler in `initPartPanel`.
- **Props:** `{ kind: string }` (`state.assembly.kindId`, always `hubcap` today but kept consistent with `build_param_changed`), `on: boolean`.

## Future / not yet wired

Candidates for a later pass, roughly in order of likely value. Follow the same
pattern: wire at the DOM handler, add the entry here, keep props PII-free.

- `assembly_kind_select` — `src/ui/partPanel.ts`, `#shape-kind` change handler (the `asm:` branch). Prop: `kindId`. `mode_switch` already fires here but only records `kind: 'assembly'`, not which one — `wheel`, `footrest`, and `chair-body` all exist today, worth wiring as more parts ship.
- `base_color_change` — `src/ui/partPanel.ts`, `renderBaseColorSwatches` swatch click. Prop: `default` vs `filament`.
- `automerge_change` — `src/ui/colorList.ts`, `#p-automerge` slider. Prop: `level` (0-3).
- `color_merge` / `color_to_base` — `src/ui/colorList.ts` drag-merge and "→ base" actions. Prop: resulting group size.
- `depth_override` / `depth_reset` — `src/ui/colorList.ts`, a row's depth field committing a value and its "↺" clearing one. Prop: whether the value was deeper or shallower than the global. Worth knowing together: how often per-row depths get set at all is what says whether the affordance marking them earns its space.
- `fit_reset` — `src/ui/fitPanel.ts`, `#btn-reset-fit`.
- `fit_flip` — `src/ui/fitPanel.ts`, flip checkboxes.

## Adding a new event

1. Add a `track('event_name', { ...props })` call at the DOM handler for the
   action (see the pattern in the three modules above).
2. Add an entry to this catalog (event, where, props).
3. If the change also adds/removes/renames a left-panel control, remember
   the [index.html](../index.html) `#help-dialog` also needs updating (see
   CLAUDE.md) — the two often go together.
