# Analytics

Umami (cloud, cookieless) is injected at build time only when
`UMAMI_WEBSITE_ID` is set — see "Analytics" in [README.md](../README.md). It
always captures pageviews. This doc catalogs the custom events layered on top
via [src/analytics/track.ts](../src/analytics/track.ts).

## Rules

- **No PII, ever.** No file names, file sizes, or artwork/geometry contents in
  props. Only low-cardinality categorical/numeric dimensions.
- **snake_case** event names; flat `{ key: string | number | boolean }` props.
- Fire from the DOM handler that represents real user intent, not from shared
  functions that also run during app init or on every rebuild.
- `track()` is a no-op when `window.umami` isn't present (dev, forks), so call
  sites need no guards.

## Events

### `artwork_load`

Fired when artwork is loaded into the scene.

- **Where:** [src/ui/artworkPanel.ts](../src/ui/artworkPanel.ts) — `loadArtworkFile` (SVG upload via click-browse or drag-drop), `applyRasterFile` (a PNG/JPG/WebP through the same dropzone), the `#btn-sample` handler, and `applyPattern` (built-in pattern picker strip).
- **Props:** `{ source: 'upload' | 'sample' | 'pattern' | 'raster' }`, plus `pattern: string` (the pattern id, e.g. `cow`) when `source` is `'pattern'`. `'raster'` covers any decoded image; the format is not recorded.
- **Dormant:** `source: 'pattern'` cannot fire while `PATTERN_LIBRARY_ENABLED` is `false` — the picker strip renders nothing to click.

### `raster_adjust`

Fired when the user commits a change to a loaded image's Colors or Detail
slider — on `change` (drag release), not each `input` tick, matching
`fit_adjust`. Not fired when the re-trace threw and the slider was put back.

- **Where:** [src/ui/artworkListPanel.ts](../src/ui/artworkListPanel.ts) — the `.raster-colors` and `.raster-detail` change handlers in `rasterControls`.
- **Props:** `{ field: 'colors' | 'detail' }`. Not the value: it would fingerprint the artwork.

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
- **Props:** `{ zone: string }` (the zone id; `'all'` for the unbound "every
  zone" option; `'whole'` for "Whole chair", never the reserved zone id itself)

### `artwork_mirror_toggled`

Fired when the user ticks or unticks an artwork row's Mirror checkbox.

- **Where:** [src/ui/artworkListPanel.ts](../src/ui/artworkListPanel.ts) — `.artwork-mirror-check` change handler in `renderArtworkList`.
- **Props:** `{ on: boolean, kind: 'twin' | 'centre' }` (`'twin'`: mirrored onto a paired zone; `'centre'`: mirrored across the zone's own middle)
- **Only the chair:** the one offered kind with mirrored zones, so the checkbox renders nowhere else.

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
- **Props:** `{ kind: 'assembly' }`, the only value the dropdown can send. It doesn't record _which_ kind — see `assembly_kind_select` below.

### `template_download`

Fired when the user downloads an assembly kind's design template from the Part
panel: the single per-kind template, or (for a part with several design zones,
like the chair) a per-zone template.

- **Where:** [src/ui/assemblyPanel.ts](../src/ui/assemblyPanel.ts) — `#asm-template-link` click handler in `initAssemblyPanel`, and the per-zone link handlers in `renderZoneTemplateLinks`.
- **Props:** `{ kind: string }` (`state.assembly.kindId`, e.g. `wheel` / `footrest`), plus `zone: string` (the zone id, or `'whole'` for the whole-part sheet, never the reserved id itself) on a per-zone download

### `build_param_changed`

Fired when the user commits a change to an assembly kind's numeric build
parameter — today the hubcap's disc diameter. On the input's `change` (blur or
Enter), not per keystroke, and only when the value moved: the same handler
regenerates the part's mesh.

Not fired when the app re-clamps the value itself (switching to a printer whose
plate is smaller than the diameter): that is the app correcting state, not user
intent (see `Rules`). The diameter is rounded to a whole millimetre, so the prop
is a size band, not a fingerprintable exact value.

- **Where:** [src/ui/assemblyPanel.ts](../src/ui/assemblyPanel.ts) — `applyBuildParam`, called from the `#p-asm-buildparam` change handler in `initPartPanel`.
- **Props:** `{ kind: string }` (`state.assembly.kindId`, e.g. `hubcap`), `param: string` (the state key, e.g. `hubcapDiameterMm`), `value: number` (millimetres, rounded)

### `export`

Fired on a successful export, just before the file download starts.

- **Where:** [src/ui/exportPanel.ts](../src/ui/exportPanel.ts) — `exportPrintReady3MF`.
- **Props:**
  - `format: '3mf'` — the only value now. Older data also holds `stl_zip`, from the per-color STL-set export of the retired flat plate modes.
  - `mode: 'assembly'` — the only value now. Older data also holds `flat`, from the same retired modes.
  - `printer: string` (`state.printerId`)
  - `colors: number` (material/color count)
  - `warnings: number` (placement warnings emitted)
  - `kind: string` (`state.assembly.kindId`, e.g. `wheel` / `footrest` / `hubcap` / `chair-body`: the part exported. Absent only if a kind hasn't loaded yet, which is unreachable.)

### `export_failed`

Fired when an export throws, in the same handler as `export`.

- **Props:** `{ format: '3mf' }` (older data also holds `stl_zip`)

### `fit_adjust`

Fired when the user commits a move/scale/rotate change to the artwork
placement: on slider release (`change`) or pointer-up from an on-face gizmo drag
in the 3D viewport. Once per gesture, not each `input` tick.

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
- **Props:** `{ kind: string }` (`state.assembly.kindId`, always `hubcap` today, kept consistent with `build_param_changed`), `on: boolean`.

### `feedback_sent`

Fired when the in-app feedback widget finishes a submit, either way. The
message and email never go in props: they go to Formspree only.

- **Where:** [src/ui/feedbackWidget.ts](../src/ui/feedbackWidget.ts) — the `#feedback-form` submit handler.
- **Props:** `{ status: 'ok' | 'error' }`. `'error'` covers a non-2xx from Formspree and a failed connection; which is not recorded.
- **Dormant:** cannot fire unless `FEEDBACK_ENDPOINT` was set at build time — the widget renders nothing without it, so a fork never reaches this.

### `help_opened`

Fired when the user opens the help dialog.

- **Where:** [src/ui/helpPanel.ts](../src/ui/helpPanel.ts) — `#btn-help` click handler.
- **Props:** none.

### `help_topic_selected`

Fired when the user clicks a table-of-contents pill inside the help dialog.

- **Where:** [src/ui/helpPanel.ts](../src/ui/helpPanel.ts) — one delegated click handler on `.help-toc`.
- **Props:** `{ topic: string }` — the section id with its `h-` prefix stripped (`workflow`, `part`, `artwork`, `fit`, `depth`, `colors`, `export`, `about`).

## Future / not yet wired

Candidates for a later pass, roughly by likely value. Wire at the DOM handler,
add the entry here, keep props PII-free.

- `assembly_kind_select` — `src/ui/partPanel.ts`, `#shape-kind` change handler. Prop: `kindId`. `mode_switch` only ever records `kind: 'assembly'`, so which part the user picked isn't recorded. `wheel`, `footrest` and `hubcap` are offered; worth wiring as more parts ship.
- `base_color_change` — `src/ui/partPanel.ts`, `renderBaseColorSwatches` swatch click. Prop: `default` vs `filament`.
- `automerge_change` — `src/ui/colorList.ts`, `#p-automerge` slider. Prop: `level` (0-3).
- `color_merge` / `color_to_base` — `src/ui/colorList.ts` drag-merge and "→ base" actions. Prop: resulting group size.
- `depth_override` / `depth_reset` — `src/ui/colorList.ts`, a row's depth field committing a value and its "↺" clearing one. Prop: deeper or shallower than the global. Together they show whether per-row depths get set often enough to earn the affordance marking them.
- `fit_reset` — `src/ui/fitPanel.ts`, `#btn-reset-fit`.
- `fit_flip` — `src/ui/fitPanel.ts`, flip checkboxes.
- `feedback_opened` — `src/ui/feedbackWidget.ts`, the `#feedback-trigger` click. Props: none. Against `feedback_sent` it shows how many open the form and abandon it, which says whether the form is too long.

## Adding a new event

1. Add a `track('event_name', { ...props })` call at the DOM handler for the
   action.
2. Add an entry to this catalog (event, where, props).
3. If the change also adds/removes/renames a left-panel control, update the
   [index.html](../index.html) `#help-dialog` too (see CLAUDE.md).
