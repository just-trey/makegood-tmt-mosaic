import type { ArtworkInstance, DesignSource, ParsedSVG, RasterState } from '../types';
import { clearBaseColor, state } from './store';
import { deltaE, hexToLab } from '../color';
import { parseRasterImage } from '../raster/parse';

let nextSourceId = 1;
let nextArtworkId = 1;

/**
 * How far each additional design is stepped off the one already sitting at that spot, in mm on the
 * face, per step.
 *
 * A new instance seeds its placement from the current fit settings, so on a part with one design
 * zone — the wheel, the footrest, and every flat kind — a second design used to land exactly
 * coplanar with the first: same offset, same scale, same depth, no separation and nothing on screen
 * saying there were two of them. Stepping it makes the second design visible as its own object and
 * draggable without first having to move the one on top of it.
 *
 * Deliberately small rather than "clear of the first design": the app has no say in how big a
 * design is placed (the wheel's default is a 276mm circle) and a step sized to separate that would
 * throw a small design off the face, where the boundary clip would silently eat it. Clearing the
 * rest of the overlap is the user's call — buildAssemblyGeometry warns and names both designs while
 * they still cross (see geometry/designOverlap.ts).
 */
export const INSTANCE_CASCADE_MM = 8;

/** Two placements count as the same spot within this — a float-comparison tolerance, not a gap. */
const SAME_SPOT_MM = 1e-6;

/**
 * Do two zone bindings put their designs on the same surface? `null` is "All zones", which covers
 * every one of them — so it shares a surface with any binding, including another `null`. Comparing
 * the ids directly would treat "All zones" as a zone of its own and let a bound design seed on top
 * of one that is already stamped everywhere.
 */
function sharesSurface(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b;
}

/**
 * The seed offset moved off any instance already placed at that exact spot on the same surface,
 * stepping diagonally until the spot is free (or `steps` runs out, so a pathological pile of
 * designs can't spin here). Returns the seed untouched when nothing is there — which is the
 * first/only design on a part, the common case, so its placement is bit-for-bit what it was.
 *
 * Assembly mode only. Flat plate mode renders `state.parsed` alone, so a second design isn't drawn
 * at all and there is nothing for a new one to sit on top of — stepping there would just walk each
 * freshly loaded SVG further off the plate with no second design on screen to explain why, and no
 * overlap warning either, since that check runs in the assembly build.
 */
function cascadedOffset(
  zoneId: string | null,
  offsetU: number,
  offsetV: number,
): { offsetU: number; offsetV: number } {
  if (state.shapeKind !== 'assembly') return { offsetU, offsetV };
  const taken = (u: number, v: number): boolean =>
    state.artworks.some(
      (a) =>
        sharesSurface(a.zone?.zoneId ?? null, zoneId) &&
        Math.abs(a.offsetU - u) < SAME_SPOT_MM &&
        Math.abs(a.offsetV - v) < SAME_SPOT_MM,
    );
  for (let step = 0; step < state.artworks.length + 1; step++) {
    const u = offsetU + INSTANCE_CASCADE_MM * step,
      v = offsetV + INSTANCE_CASCADE_MM * step;
    if (!taken(u, v)) return { offsetU: u, offsetV: v };
  }
  return { offsetU, offsetV };
}

/**
 * Register a freshly-parsed SVG as a new design source, alongside whatever is already loaded, and
 * auto-create its instance. Placement seeds from the current global offset/scale/rotation/flip so a
 * first-time load (still the common case) behaves exactly as before; a source added later starts
 * from that same snapshot rather than the *previous* active instance's placement, since the two
 * designs aren't related — stepped off it when that snapshot would drop it exactly on a design
 * already there (see INSTANCE_CASCADE_MM). The new instance becomes active, and `state.parsed` —
 * the field flat mode and legacy single-instance code still read — mirrors it.
 *
 * The instance binds to the first offered zone when the assembly has more than one. `zone: null`
 * ("All zones" in the picker) stays available and unchanged, but it is the wrong *default* on a
 * multi-zone kind: it stamps the same design onto every surface at once, which on the chair means
 * 25 conformal charts recut on every slider nudge to produce a result nobody asked for. Kinds with
 * one zone or none (wheel, footrest, flat mode) still start unbound, so their behavior is
 * bit-for-bit what it was.
 */
export function loadArtworkSource(
  parsed: ParsedSVG,
  name: string,
  kind: DesignSource['kind'] = 'upload',
  mode: ArtworkInstance['mode'] = 'sticker',
  // Defaults to '' for the many tests that construct a ParsedSVG directly and don't care about
  // round-tripping it — session persistence (state/persist.ts) is the only real caller that needs
  // this, and it always has real SVG text in hand. A raster source has none by nature.
  svgText: string = '',
  // Rides along rather than being attached afterwards, so a source is never briefly in a
  // half-built state the list panel could render.
  raster?: RasterState,
): ArtworkInstance {
  const source: DesignSource = {
    id: `source-${nextSourceId++}`,
    kind,
    name,
    parsed,
    svgText,
    raster,
  };
  state.sources.push(source);

  const zones = availableZones();
  const zoneId = zones.length > 1 ? zones[0].zoneId : null;
  const instance: ArtworkInstance = {
    id: `artwork-${nextArtworkId++}`,
    sourceId: source.id,
    zone: zoneId ? { partId: partIdForZone(zoneId), zoneId } : null,
    ...cascadedOffset(zoneId, state.offsetX, state.offsetY),
    scalePct: state.scalePct,
    rotationDeg: state.rotationDeg,
    flipX: state.flipX,
    flipY: state.flipY,
    mode,
  };
  state.artworks.push(instance);
  state.parsed = parsed;
  setActiveArtwork(instance.id);
  return instance;
}

/**
 * Repopulate the source/artwork pool from a restored session (see state/persist.ts), preserving
 * the saved string ids rather than minting fresh ones — `artworks[].sourceId` already points at
 * them. Zone bindings come in as `zone: null`; the restore caller re-applies each one via
 * setArtworkZone() once the assembly's parts (and their fresh, session-local numeric partIds) have
 * reloaded, since a saved `partId` can't outlive the session that assigned it. Advances the id
 * counters past the restored ones so a design loaded afterward can't collide with a restored id.
 */
export function restoreArtworkPool(sources: DesignSource[], artworks: ArtworkInstance[]): void {
  state.sources = sources;
  state.artworks = artworks;
  const maxSuffix = (ids: string[], prefix: string) =>
    ids.reduce((max, id) => {
      const n = id.startsWith(prefix) ? parseInt(id.slice(prefix.length), 10) : NaN;
      return Number.isFinite(n) ? Math.max(max, n) : max;
    }, 0);
  nextSourceId = Math.max(
    nextSourceId,
    maxSuffix(
      sources.map((s) => s.id),
      'source-',
    ) + 1,
  );
  nextArtworkId = Math.max(
    nextArtworkId,
    maxSuffix(
      artworks.map((a) => a.id),
      'artwork-',
    ) + 1,
  );
}

/** Every hex any currently-loaded design actually paints with — the live palette. */
function livePalette(): Set<string> {
  const live = new Set<string>();
  for (const s of state.sources) for (const shape of s.parsed.shapes) live.add(shape.fill);
  return live;
}

/**
 * Drop every color-derived setting whose hex no longer exists in any loaded design.
 *
 * Loading a design used to reset these wholesale, which is wrong now that designs pool: a base
 * assignment or merge group made on one artwork should survive loading a second one. But keeping
 * them *all* is wrong the other way — when a design is removed, or replaced by one with a
 * different palette, a hex left in `baseColorMembers` silently excludes it from being cut the
 * moment some later design happens to use that same hex. Pruning to what's actually on screen is
 * the only rule that behaves correctly in both directions.
 */
export function pruneSettingsToPalette(): void {
  const live = livePalette();
  const isLiveKey = (rawKey: string) => {
    // Assembly-mode depth keys are the flat key with an "asm:" prefix (geometry/assembly.ts).
    // Read past it: unprefixed, every one of them fell through to the "not a hex, must be
    // something like __background__" arm and was kept forever, so a per-color depth set in
    // assembly mode outlived the design it was set on and silently re-applied to the next one
    // that happened to use the same hex.
    const key = rawKey.startsWith('asm:') ? rawKey.slice(4) : rawKey;
    return key.startsWith('merge:')
      ? key
          .slice(6)
          .split(',')
          .some((h) => live.has(h))
      : !key.startsWith('#') || live.has(key);
  };

  for (const key of Object.keys(state.colorSettings))
    if (!isLiveKey(key)) delete state.colorSettings[key];
  state.mergeGroups = state.mergeGroups
    .map((g) => g.filter((h) => live.has(h)))
    .filter((g) => g.length > 1);
  state.keptApart = state.keptApart.filter((h) => live.has(h));
  state.baseColorMembers = state.baseColorMembers.filter((h) => live.has(h));
  if (!state.baseColorMembers.length) clearBaseColor();
  else if (!state.baseColorKey || !state.baseColorMembers.includes(state.baseColorKey))
    // the build re-derives the true dominant member on the next rebuild
    state.baseColorKey = state.baseColorMembers[0];
}

/** Narrow a source to one backed by decoded pixels — see the invariant on DesignSource. */
export function isRasterSource(s: DesignSource): s is DesignSource & { raster: RasterState } {
  return s.raster !== undefined;
}

/**
 * How far a color may move across a re-quantize and still be recognised as "the same" color.
 *
 * Re-quantizing moves every cluster centroid, so the palette hexes genuinely change on each nudge
 * of the Colors slider. Without this the prune below would delete the user's per-color depths and
 * base assignment every time they touched it, and the slider would feel destructive. 6 is a
 * deliberately generous CIE76 distance — comfortably past the "Slight" auto-merge cutoff of 3, so a
 * centroid drifting under a slider nudge is carried, while a genuinely different color is not.
 */
const SETTING_REMAP_DE = 6;

/**
 * The two forms a per-color depth key takes: the bare hex in flat-plate mode, and the same hex
 * behind the "asm:" prefix geometry/assembly.ts builds its per-region keys with.
 *
 * Both have to be carried. Assembly mode is the app's primary mode, so remapping only the bare form
 * meant that in the mode nearly every user is in, a nudge of the Colors slider moved no setting and
 * pruneSettingsToPalette — which does read past the prefix — then deleted every custom recess depth:
 * exactly the destructive slider this function exists to prevent.
 */
const DEPTH_KEY_PREFIXES = ['', 'asm:'];

/**
 * Carry per-color settings across a palette change, for colors no longer painted by anything.
 *
 * Depth on a *merged* group is not carried: its settings key is built from the member hexes, so
 * the key itself changes and there is nothing stable to match on. The prune that follows drops it.
 */
function remapSettingsToPalette(oldPalette: string[], newPalette: string[]): void {
  const live = livePalette();
  const newLabs = newPalette.map((hex) => ({ hex, lab: hexToLab(hex) }));
  for (const oldHex of oldPalette) {
    if (live.has(oldHex)) continue; // some other design still paints it — leave its settings put
    const oldLab = hexToLab(oldHex);
    let best: string | null = null;
    let bestD = SETTING_REMAP_DE;
    for (const cand of newLabs) {
      const d = deltaE(oldLab, cand.lab);
      if (d < bestD) {
        bestD = d;
        best = cand.hex;
      }
    }
    if (!best) continue;
    const target = best;
    for (const prefix of DEPTH_KEY_PREFIXES) {
      const from = prefix + oldHex;
      const to = prefix + target;
      if (state.colorSettings[from] && !state.colorSettings[to])
        state.colorSettings[to] = state.colorSettings[from];
    }
    const swap = (list: string[]) => list.map((h) => (h === oldHex ? target : h));
    state.keptApart = swap(state.keptApart);
    state.baseColorMembers = swap(state.baseColorMembers);
    state.mergeGroups = state.mergeGroups.map(swap);
    if (state.baseColorKey === oldHex) state.baseColorKey = target;
  }
}

/**
 * Re-run the quantize/trace stages of a loaded image at new Colors/Detail settings.
 *
 * The decoded pixels are reused, so this never re-reads the file. Synchronous — the caller owns the
 * rebuild it schedules afterwards.
 */
export function requantizeSource(
  sourceId: string,
  patch: { colors?: number; detail?: number },
): { capped: boolean } | null {
  const source = state.sources.find((s) => s.id === sourceId);
  if (!source || !isRasterSource(source)) return null;
  const colors = patch.colors ?? source.raster.colors;
  const detail = patch.detail ?? source.raster.detail;

  const result = parseRasterImage(source.raster.image, { colors, detail });
  const oldPalette = source.raster.palette;
  // A brand-new ParsedSVG with a brand-new `shapes` array, never a mutation of the old one:
  // computeNetRegionsByColor memoizes on that array's identity, so an in-place edit would serve
  // the old regions forever.
  source.parsed = result.parsed;
  source.raster = {
    ...source.raster,
    colors,
    detail,
    palette: result.palette,
    regions: result.componentCount,
  };

  const active = activeArtworkInstance();
  if (active && active.sourceId === source.id) state.parsed = source.parsed;
  remapSettingsToPalette(oldPalette, result.palette);
  pruneSettingsToPalette();
  return { capped: result.capped };
}

/**
 * A second placement of an already-loaded source — the artwork list's "+ add to another zone"
 * action. Starts from neutral placement (not the current globals): it's going on a different zone
 * than wherever the source's other instance(s) sit, so copying that unrelated placement would just
 * be confusing — unless it isn't going elsewhere after all (the same zone, or a part with only one),
 * where neutral means straight on top of what's there and it steps off instead (INSTANCE_CASCADE_MM).
 * Becomes the active instance so the fit sliders/gizmo land on it immediately.
 */
export function addInstanceForSource(sourceId: string, zoneId: string | null): ArtworkInstance {
  const partId = zoneId ? partIdForZone(zoneId) : 0;
  const instance: ArtworkInstance = {
    id: `artwork-${nextArtworkId++}`,
    sourceId,
    zone: zoneId ? { partId, zoneId } : null,
    ...cascadedOffset(zoneId, 0, 0),
    scalePct: 100,
    rotationDeg: 0,
    flipX: false,
    flipY: false,
    // Sticker/fill is a property of the design, not of where it sits: a pattern placed on a second
    // zone is still a pattern, so inherit rather than reset (unlike the placement above).
    mode: state.artworks.find((x) => x.sourceId === sourceId)?.mode ?? 'sticker',
  };
  state.artworks.push(instance);
  setActiveArtwork(instance.id);
  return instance;
}

/** The instance the gizmo/fit sliders/assembly build currently target. */
export function activeArtworkInstance(): ArtworkInstance | null {
  return state.artworks.find((a) => a.id === state.activeArtworkId) ?? null;
}

/**
 * Make an instance active and pull its placement into the legacy global fields the fit sliders and
 * gizmo still read/write — the sliders don't know about instances directly, so "switch which design
 * you're editing" has to happen by re-seeding those globals (the reverse of syncActiveArtworkPlacement,
 * which pushes edits back out before a build). Also mirrors `state.parsed` to the newly active
 * instance's source so flat-mode/bbox code keeps reading the right design.
 */
export function setActiveArtwork(id: string | null): void {
  if (id === null) {
    state.activeArtworkId = null;
    return;
  }
  const a = state.artworks.find((x) => x.id === id);
  if (!a) return; // unknown id — leave the current active instance alone
  state.activeArtworkId = id;
  state.offsetX = a.offsetU;
  state.offsetY = a.offsetV;
  state.scalePct = a.scalePct;
  state.rotationDeg = a.rotationDeg;
  state.flipX = a.flipX;
  state.flipY = a.flipY;
  const src = state.sources.find((s) => s.id === a.sourceId);
  if (src) state.parsed = src.parsed;
}

/** Bind (or unbind, with `zoneId: null`) which zone an instance's artwork lands on. */
export function setArtworkZone(instanceId: string, zoneId: string | null): void {
  const a = state.artworks.find((x) => x.id === instanceId);
  if (!a) return;
  a.zone = zoneId ? { partId: partIdForZone(zoneId), zoneId } : null;
}

/**
 * Switch one instance between placing a single copy of its design and repeating it across the whole
 * zone. Set per instance, not per source: the same design can legitimately be a sticker on one zone
 * and a background fill on another.
 */
export function setArtworkMode(instanceId: string, mode: ArtworkInstance['mode']): void {
  const a = state.artworks.find((x) => x.id === instanceId);
  if (a) a.mode = mode;
}

function partIdForZone(zoneId: string): number {
  return state.assembly.parts.find((p) => p.zones?.some((z) => z.id === zoneId))?.id ?? 0;
}

/**
 * Every zone id currently offered by the loaded assembly parts, deduped and named — what the
 * per-instance zone dropdown (and the Part panel's per-zone template links) offer. Empty outside
 * assembly mode, or for a kind with no zone sidecar (a part with `zones: undefined` has one
 * implicit flat zone, not a pickable one).
 */
export function availableZones(): { zoneId: string; name: string; templateFile?: string }[] {
  const seen = new Map<string, { name: string; templateFile?: string }>();
  for (const part of state.assembly.parts)
    for (const z of part.zones ?? [])
      if (!seen.has(z.id)) seen.set(z.id, { name: z.name, templateFile: z.templateFile });
  return Array.from(seen, ([zoneId, v]) => ({ zoneId, ...v }));
}

/**
 * How many of the assembly's design zones currently carry at least one artwork instance, out of
 * how many the part offers — the number behind the chair's "N of M surfaces have artwork" notice
 * and the pre-export coverage check. An instance with `zone: null` ("All zones") counts every zone
 * covered, since that's what it actually cuts onto. `{ total: 0, ... }` outside assembly mode or on
 * a single/no-zone kind, where there's nothing to reconcile.
 */
export function zoneCoverage(): { total: number; covered: number } {
  const zones = availableZones();
  if (!zones.length) return { total: 0, covered: 0 };
  if (state.artworks.some((a) => a.zone === null))
    return { total: zones.length, covered: zones.length };
  const bound = new Set(
    state.artworks.map((a) => a.zone?.zoneId).filter((id): id is string => !!id),
  );
  return { total: zones.length, covered: bound.size };
}

/**
 * Remove one artwork instance (the list panel's × on a row). If that was the last instance using
 * its source, the source goes with it — an orphaned source can't be targeted by anything and would
 * just be dead weight in the list. Falls back to the full clearArtwork() when nothing is left, so
 * `state.parsed` and the color/merge/base settings reset exactly as before.
 */
export function removeArtworkInstance(instanceId: string): void {
  const a = state.artworks.find((x) => x.id === instanceId);
  if (!a) return;
  state.artworks = state.artworks.filter((x) => x.id !== instanceId);
  const sourceStillUsed = state.artworks.some((x) => x.sourceId === a.sourceId);
  if (!sourceStillUsed) state.sources = state.sources.filter((s) => s.id !== a.sourceId);

  if (!state.artworks.length) {
    clearArtwork();
    return;
  }
  pruneSettingsToPalette(); // the removed source's colors are gone; don't keep settings for them
  if (state.activeArtworkId === instanceId) setActiveArtwork(state.artworks[0].id);
}

/**
 * Drop every loaded artwork — the counterpart to loadArtworkSource, used when the last instance is
 * removed. Leaves offset/scale/rotation/flip alone: those are a placement preference, not
 * artwork-specific, and (like autoMergeLevel) intentionally survive a reload/removal. Pure state
 * only — callers own any DOM/rebuild side effects.
 */
export function clearArtwork(): void {
  state.parsed = null;
  state.sources = [];
  state.artworks = [];
  state.activeArtworkId = null;
  state.colorSettings = {};
  state.mergeGroups = [];
  clearBaseColor();
  state.keptApart = [];
}

/**
 * Clear every instance's zone binding — called on an assembly kind switch. The new kind's parts are
 * an entirely different mesh, so a stale `{ partId, zoneId }` would either point at nothing or
 * (worse) silently match a same-named zone on an unrelated part; clearing back to "every zone the
 * part offers" is the same safe default a freshly-loaded source gets, and the user can re-target
 * from the list. Without this, an instance bound to a chair zone would take no cut at all after
 * switching to the wheel, with nothing in the UI explaining why.
 */
export function clearArtworkZoneBindings(): void {
  state.artworks.forEach((a) => {
    a.zone = null;
  });
}

/**
 * Mirror the legacy global placement fields onto the active instance. Those globals are still the
 * fit sliders' and gizmo's write target, so this keeps the instance's placement fresh (called before
 * assembly-mode code reads from it) without requiring every slider handler to know about instances.
 */
export function syncActiveArtworkPlacement(): void {
  const a = activeArtworkInstance();
  if (!a) return;
  a.offsetU = state.offsetX;
  a.offsetV = state.offsetY;
  a.scalePct = state.scalePct;
  a.rotationDeg = state.rotationDeg;
  a.flipX = state.flipX;
  a.flipY = state.flipY;
}
