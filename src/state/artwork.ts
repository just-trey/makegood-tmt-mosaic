import type { ArtworkInstance, DesignSource, ParsedSVG } from '../types';
import { clearBaseColor, state } from './store';

let nextSourceId = 1;
let nextArtworkId = 1;

/**
 * Register a freshly-parsed SVG as a new design source, alongside whatever is already loaded, and
 * auto-create its instance unbound (`zone: null`, meaning "every zone the part offers" — the flat/
 * single-zone behavior every part had before multi-zone parts). Placement seeds from the current
 * global offset/scale/rotation/flip so a first-time load (still the common case) behaves exactly as
 * before; a source added later starts from that same snapshot rather than the *previous* active
 * instance's placement, since the two designs aren't related. The new instance becomes active, and
 * `state.parsed` — the field flat mode and legacy single-instance code still read — mirrors it.
 */
export function loadArtworkSource(
  parsed: ParsedSVG,
  name: string,
  kind: DesignSource['kind'] = 'upload',
): ArtworkInstance {
  const source: DesignSource = { id: `source-${nextSourceId++}`, kind, name, parsed };
  state.sources.push(source);

  const instance: ArtworkInstance = {
    id: `artwork-${nextArtworkId++}`,
    sourceId: source.id,
    zone: null,
    offsetU: state.offsetX,
    offsetV: state.offsetY,
    scalePct: state.scalePct,
    rotationDeg: state.rotationDeg,
    flipX: state.flipX,
    flipY: state.flipY,
    mode: 'sticker',
  };
  state.artworks.push(instance);
  state.parsed = parsed;
  setActiveArtwork(instance.id);
  return instance;
}

/**
 * A second placement of an already-loaded source — the artwork list's "+ add to another zone"
 * action. Starts from neutral placement (not the current globals): it's going on a different zone
 * than wherever the source's other instance(s) sit, so copying that unrelated placement would just
 * be confusing. Becomes the active instance so the fit sliders/gizmo land on it immediately.
 */
export function addInstanceForSource(sourceId: string, zoneId: string | null): ArtworkInstance {
  const partId = zoneId ? partIdForZone(zoneId) : 0;
  const instance: ArtworkInstance = {
    id: `artwork-${nextArtworkId++}`,
    sourceId,
    zone: zoneId ? { partId, zoneId } : null,
    offsetU: 0,
    offsetV: 0,
    scalePct: 100,
    rotationDeg: 0,
    flipX: false,
    flipY: false,
    mode: 'sticker',
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
