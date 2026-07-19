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

### `mode_switch`

Fired when the user changes the part-shape mode.

- **Where:** [src/ui/partPanel.ts](../src/ui/partPanel.ts) — `#shape-kind` change handler in `initPartPanel`.
- **Props:** `{ kind: 'assembly' | 'disc' | 'rect' | 'round' | 'stl' }`

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

## Future / not yet wired

Candidates for a later pass, roughly in order of likely value. Follow the same
pattern: wire at the DOM handler, add the entry here, keep props PII-free.

- `assembly_kind_select` — `src/ui/assemblyPanel.ts`, `#p-asm-kind` change. Prop: `kindId`. Only `wheel` exists today; gains value as more TMT parts ship.
- `base_color_change` — `src/ui/partPanel.ts`, `renderBaseColorSwatches` swatch click. Prop: `default` vs `filament`.
- `automerge_change` — `src/ui/colorList.ts`, `#p-automerge` slider. Prop: `level` (0-3).
- `color_merge` / `color_to_base` — `src/ui/colorList.ts` drag-merge and "→ base" actions. Prop: resulting group size.
- `fit_reset` / `fit_flip` — `src/ui/fitPanel.ts`, `#btn-reset-fit` and flip checkboxes.

## Adding a new event

1. Add a `track('event_name', { ...props })` call at the DOM handler for the
   action (see the pattern in the three modules above).
2. Add an entry to this catalog (event, where, props).
3. If the change also adds/removes/renames a left-panel control, remember
   the [index.html](../index.html) `#help-dialog` also needs updating (see
   CLAUDE.md) — the two often go together.
