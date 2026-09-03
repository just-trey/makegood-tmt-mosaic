import type { ArtworkInstance, DesignSource, ParsedSVG, RasterState, ZoneMirror } from '../types';
import { clearBaseColor, state } from './store';
import { deltaE, hexToLab } from '../color';
import { parseRasterImage } from '../raster/parse';
import type { RasterImage } from '../raster/types';
import { currentDesignScaleContext, fillWithheld } from '../assembly/kinds';
import { canvasAnchor, designMmPerUnit, placedFootprintMM } from '../geometry/assembly';
import { OVERLAP_WARN_FRACTION } from '../geometry/designOverlap';

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
 * The largest placed design the cascade will step the full width of.
 *
 * A diagonal step of `c` separates two designs needing `c` of clearance completely, while the
 * constant step `d` leaves them covering ((c−d)/c)² of each other, which only reaches
 * `OVERLAP_WARN_FRACTION` for c ≥ d/(1−√fraction). Below that the constant seeded a real overlap
 * the build then said nothing about, because it fell under the warn threshold: two 10mm designs
 * stepped 8mm apart cut 4% into each other in silence. So step the full clearance up to here, and
 * keep the constant above it, where it is both the smaller move and a loud one.
 *
 * Scaling the step all the way up instead is what INSTANCE_CASCADE_MM already rejects: the wheel's
 * default design is a 276mm circle, and a step sized to clear that throws the design off the face.
 *
 * What this buys is bounded. Any single step has a silent band from itself up to 1.4625× itself,
 * and one step per surface is forced (a step chosen per design puts a later small one between an
 * earlier big one's spots — pinned by "does not park a small design inside one already cascaded
 * past it" in tests/artwork.test.ts). So a surface carrying anything over this size is back on the
 * constant, and designs of opposite proportions (an 8x11.5mm design against an 11.5x8mm one, both
 * reading 8mm on their narrow axis) defeat the clearance measure whatever it is set to — reading
 * the wider axis instead would part that pair at the cost of moving every shaped-alike pair
 * further than it needs to go, a defensible swap rather than a fix.
 *
 * Closing the band for real means dropping the lattice: search for the nearest free placement
 * given the two designs' actual footprints, instead of stepping a fixed distance and testing for
 * an exact-spot collision. That is a real placement search and wants its own change.
 */
export const CASCADE_CLEAR_MAX_MM = INSTANCE_CASCADE_MM / (1 - Math.sqrt(OVERLAP_WARN_FRACTION));

function cascadeStepMM(clearance: number): number {
  return clearance > CASCADE_CLEAR_MAX_MM
    ? INSTANCE_CASCADE_MM
    : Math.max(INSTANCE_CASCADE_MM, clearance);
}

/** What the cascade needs to know about a design to size its step: enough to place it. */
interface CascadeSubject {
  parsed: ParsedSVG | null | undefined;
  scalePct: number;
  rotationDeg: number;
}

function footprintOf(d: CascadeSubject): { w: number; h: number } | null {
  if (!d.parsed) return null;
  const f = placedFootprintMM(
    d.parsed,
    d.scalePct / 100,
    d.rotationDeg,
    currentDesignScaleContext(),
  );
  return f.w > 0 && f.h > 0 ? f : null;
}

function subjectOf(a: ArtworkInstance): CascadeSubject {
  return {
    parsed: state.sources.find((s) => s.id === a.sourceId)?.parsed,
    scalePct: a.scalePct,
    rotationDeg: a.rotationDeg,
  };
}

/**
 * How far the step has to reach on this surface: the largest design already on it or arriving,
 * measured across that design's narrower axis, which is what two copies of it need to come apart.
 *
 * Read off the surface rather than off the one pair being separated, deliberately. Every design on
 * a surface steps along the same diagonal lattice, so a step sized per pair lets a later, smaller
 * design land between two of an earlier one's lattice points and sit inside it: a 5mm design
 * stepping 8mm past a 10mm one at 10mm ends up wholly within it. Taking the largest keeps one
 * lattice.
 *
 * The narrower axis is the cheapest one to separate along, and it answers for the pair whenever
 * the two designs are shaped alike. It does not otherwise: a 5x200 bar and a 200x5 bar both report
 * 5, and no step derived from that will part them. See docs/tech-debt.md.
 *
 * Zero when no footprint is known, which falls the step back to the constant.
 */
function surfaceClearanceMM(zoneId: string | null, incoming: CascadeSubject): number {
  const narrower = (f: { w: number; h: number } | null): number => (f ? Math.min(f.w, f.h) : 0);
  let most = narrower(footprintOf(incoming));
  for (const a of state.artworks)
    if (sharesSurface(a.zone?.zoneId ?? null, zoneId))
      most = Math.max(most, narrower(footprintOf(subjectOf(a))));
  return most;
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
  incoming: CascadeSubject,
): { offsetU: number; offsetV: number } {
  if (state.shapeKind !== 'assembly') return { offsetU, offsetV };
  const at = (u: number, v: number): ArtworkInstance | undefined =>
    state.artworks.find(
      (a) =>
        sharesSurface(a.zone?.zoneId ?? null, zoneId) &&
        Math.abs(a.offsetU - u) < SAME_SPOT_MM &&
        Math.abs(a.offsetV - v) < SAME_SPOT_MM,
    );
  if (!at(offsetU, offsetV)) return { offsetU, offsetV };
  const step = cascadeStepMM(surfaceClearanceMM(zoneId, incoming));
  for (let i = 1; i <= state.artworks.length; i++) {
    const u = offsetU + step * i,
      v = offsetV + step * i;
    if (!at(u, v)) return { offsetU: u, offsetV: v };
  }
  return { offsetU, offsetV };
}

/**
 * How large one working pixel of an image will print, in mm, at the placement it is about to be
 * traced for. Undefined when there is nothing to answer with, and the trace then falls back to its
 * fraction-of-the-image floor alone.
 *
 * **Assembly kinds only.** A flat plate fits the design's *drawn content*, which does not exist
 * until the trace has run, and the closest pre-trace stand-in (the opaque pixels) is wrong in the
 * damaging direction: one stray opaque speck in a corner inflates the extent, shrinks mm per pixel
 * and raises the floor over printable detail. An assembly places an image on its own frame
 * (`designAnchor`), so nothing there needs the traced bbox. docs/tech-debt.md carries the rest.
 *
 * This is the half the raster stage never had. It runs strictly before placement is known, so
 * without this value its despeckle floor could only be a share of the image, which for one
 * photograph means removing 8.7mm features on the footrest and 1.4mm ones on the smallest hubcap.
 * With it, `despeckleFloorPx` sizes the floor in mm, lowering it below the fraction on flat art
 * placed large as well as raising it to a nozzle width on small faces.
 * Asking the two scale rules the build already uses, rather than restating a third one here, is
 * what keeps the floor and the cut talking about the same design.
 *
 * Fixed at the moment of the trace: the Scale slider does not re-trace, because a trace measured
 * ~830ms and a drag would fire it per step. Shrinking afterwards therefore keeps the older, more
 * permissive floor, and enlarging keeps detail removed that the new size could print, until
 * Colors or Detail re-runs it (docs/tech-debt.md).
 */
export function rasterMmPerPixel(img: RasterImage, sourceId?: string): number | undefined {
  if (state.shapeKind !== 'assembly') return undefined;
  const mm = assemblyMmPerUnit(img, sourceId);
  return mm !== undefined && Number.isFinite(mm) && mm > 0 ? mm : undefined;
}

/**
 * The largest millimetre-per-pixel any instance of this source is placed at.
 *
 * The largest, because one trace serves every instance: a floor sized for the smallest copy would
 * throw away detail the biggest one prints perfectly well. Each instance is asked separately
 * rather than taking the largest scale, because Fill and Sticker do not share a scale rule (see
 * `designMmPerUnit`'s forceRect) and on the wheel they are different formulas entirely.
 *
 * A source with no instance yet is a first load, and every raster load is a Sticker at the global
 * fit, which is exactly what `loadArtworkSource` is about to create.
 *
 * An image anchors on its own frame on every assembly kind, wheel included (`designAnchor`), so
 * none of this needs the traced bbox that does not exist yet.
 *
 * Undefined while a rect kind's parts are still loading. `designMmPerUnit` answers 1mm per unit
 * there, which is a real branch for an SVG with no viewBox and a fiction for an image: it would be
 * stored on the source and saved to the session as if it had been measured, and a floor derived
 * from it is inert.
 */
function assemblyMmPerUnit(img: RasterImage, sourceId?: string): number | undefined {
  const canvas = { w: img.w, h: img.h };
  const ctx = currentDesignScaleContext();
  const anchorR = canvasAnchor({ canvas })?.r ?? 1;
  const placed = state.artworks.filter((a) => a.sourceId === sourceId);
  const anyRect = ctx.isRect || placed.some((a) => a.mode === 'fill');
  if (anyRect && !ctx.designFace()) return undefined;
  const at = (scalePct: number, fill: boolean) =>
    designMmPerUnit(
      { userUnitMM: null, canvas, origin: 'raster' },
      scalePct / 100,
      anchorR,
      ctx,
      fill,
    );
  return placed.length
    ? Math.max(...placed.map((a) => at(a.scalePct, a.mode === 'fill')))
    : at(state.scalePct, false);
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
    ...cascadedOffset(zoneId, state.offsetX, state.offsetY, {
      parsed,
      scalePct: state.scalePct,
      rotationDeg: state.rotationDeg,
    }),
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
): { capped: boolean; droppedColors: number; detailLowersFloor: boolean } | null {
  const source = state.sources.find((s) => s.id === sourceId);
  if (!source || !isRasterSource(source)) return null;
  const colors = patch.colors ?? source.raster.colors;
  const detail = patch.detail ?? source.raster.detail;

  // Re-derived rather than reused: this is a fresh trace, so it gets the size the design is placed
  // at now, not the one it happened to be loaded at. The stored value stands in when the placement
  // cannot be read (a rect kind mid-reload), which keeps the last real measurement rather than
  // dropping the floor and saving that loss into the session — but only inside assembly mode, or
  // switching to a plate would apply a part's floor to a shape that has none.
  const mmPerPixel =
    state.shapeKind === 'assembly'
      ? (rasterMmPerPixel(source.raster.image, source.id) ?? source.raster.mmPerPixel)
      : undefined;
  const result = parseRasterImage(source.raster.image, {
    colors,
    detail,
    mmPerPixel,
    name: source.name,
  });
  const oldPalette = source.raster.palette;
  // A brand-new ParsedSVG with a brand-new `shapes` array, never a mutation of the old one:
  // computeNetRegionsByColor memoizes on that array's identity, so an in-place edit would serve
  // the old regions forever.
  source.parsed = result.parsed;
  source.raster = {
    ...source.raster,
    colors,
    detail,
    mmPerPixel,
    palette: result.palette,
    regions: result.componentCount,
  };

  const active = activeArtworkInstance();
  if (active && active.sourceId === source.id) state.parsed = source.parsed;
  remapSettingsToPalette(oldPalette, result.palette);
  pruneSettingsToPalette();
  return {
    capped: result.capped,
    droppedColors: result.droppedColors,
    detailLowersFloor: result.detailLowersFloor,
  };
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
    ...cascadedOffset(zoneId, 0, 0, {
      parsed: state.sources.find((s) => s.id === sourceId)?.parsed,
      scalePct: 100,
      rotationDeg: 0,
    }),
    scalePct: 100,
    rotationDeg: 0,
    flipX: false,
    flipY: false,
    // Sticker/fill is a property of the design, not of where it sits: a pattern placed on a second
    // zone is still a pattern, so inherit rather than reset (unlike the placement above).
    mode: allowedArtworkMode(
      state.artworks.find((x) => x.sourceId === sourceId)?.mode ?? 'sticker',
    ),
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

/** Baked mirror relation of a zone, looked up off the loaded parts. Undefined off assembly mode too. */
function zoneMirrorOf(zoneId: string): ZoneMirror | undefined {
  for (const part of state.assembly.parts)
    for (const z of part.zones ?? []) if (z.id === zoneId) return z.mirror;
  return undefined;
}

/** Bind (or unbind, with `zoneId: null`) which zone an instance's artwork lands on. */
export function setArtworkZone(instanceId: string, zoneId: string | null): void {
  const a = state.artworks.find((x) => x.id === instanceId);
  if (!a) return;
  a.zone = zoneId ? { partId: partIdForZone(zoneId), zoneId } : null;
  // A saved (or already-ticked) Mirror survives rebinding to another zone that also offers it —
  // restoreSession rebinds every instance's zone here after the pool restores mirror:true — and
  // drops the moment the new zone (or "All zones") offers none, so a stale flag never reaches a
  // mapper with no mirror to apply it against.
  if (a.mirror && !(zoneId && zoneMirrorOf(zoneId))) a.mirror = false;
}

/**
 * Toggle whether an instance also cuts on its bound zone's mirror. Only takes effect on a zone
 * that actually offers one (`ZoneMirror`, baked per zone); asking for it on any other zone leaves
 * it off, same as a session restored before Mirror existed.
 */
export function setArtworkMirror(instanceId: string, on: boolean): void {
  const a = state.artworks.find((x) => x.id === instanceId);
  if (!a) return;
  a.mirror = on && !!(a.zone && zoneMirrorOf(a.zone.zoneId));
}

/**
 * Switch one instance between placing a single copy of its design and repeating it across the whole
 * zone. Set per instance, not per source: the same design can legitimately be a sticker on one zone
 * and a background fill on another.
 */
export function setArtworkMode(instanceId: string, mode: ArtworkInstance['mode']): void {
  const a = state.artworks.find((x) => x.id === instanceId);
  if (a) a.mode = allowedArtworkMode(mode);
}

/**
 * Fill coerced to Sticker on a kind that withholds it. State never holds Fill for a part where Fill
 * misbehaves, so the build pipeline needs no matching check — the alternative, letting `mode` stay
 * 'fill' and reinterpreting it downstream, is the one shared value meaning two things at once that
 * CLAUDE.md warns about. Deliberately keyed on fillWithheld() and not on whether the control is
 * currently shown: a flat part hides Fill but merely ignores it, and clamping there would discard a
 * setting the user picked in assembly mode the moment they glanced at a disc.
 */
export function allowedArtworkMode(mode: ArtworkInstance['mode']): ArtworkInstance['mode'] {
  return mode === 'fill' && fillWithheld() ? 'sticker' : mode;
}

/**
 * Re-clamp every loaded design's mode against the current part. Artwork outlives a part switch
 * (only its zone bindings are cleared), so a design set to Fill on the wheel would otherwise arrive
 * on the chair still set to Fill and rebuild through the path the flag exists to keep it out of.
 * Returns whether anything changed, so callers can skip a needless rebuild.
 */
export function clampArtworkModes(): boolean {
  let changed = false;
  state.artworks.forEach((a) => {
    const next = allowedArtworkMode(a.mode);
    if (next !== a.mode) {
      a.mode = next;
      changed = true;
    }
  });
  return changed;
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
export function availableZones(): {
  zoneId: string;
  name: string;
  templateFile?: string;
  mirror?: ZoneMirror;
}[] {
  const seen = new Map<string, { name: string; templateFile?: string; mirror?: ZoneMirror }>();
  for (const part of state.assembly.parts)
    for (const z of part.zones ?? [])
      if (!seen.has(z.id))
        seen.set(z.id, { name: z.name, templateFile: z.templateFile, mirror: z.mirror });
  return Array.from(seen, ([zoneId, v]) => ({ zoneId, ...v }));
}

/**
 * How many of the assembly's design zones currently carry at least one artwork instance, out of
 * how many the part offers — the number behind the chair's "N of M zones have artwork" notice
 * and the pre-export coverage check. An instance with `zone: null` ("All zones") counts every zone
 * covered, since that's what it actually cuts onto. `{ total: 0, ... }` outside assembly mode or on
 * a single/no-zone kind, where there's nothing to reconcile.
 */
export function zoneCoverage(): { total: number; covered: number } {
  const zones = availableZones();
  if (!zones.length) return { total: 0, covered: 0 };
  if (state.artworks.some((a) => a.zone === null))
    return { total: zones.length, covered: zones.length };
  const bound = new Set<string>();
  for (const a of state.artworks) {
    const zoneId = a.zone?.zoneId;
    if (!zoneId) continue;
    bound.add(zoneId);
    // A mirrored instance cuts on its twin too (or the same zone's other half, already counted).
    if (a.mirror) {
      const mirror = zoneMirrorOf(zoneId);
      if (mirror && 'twin' in mirror) bound.add(mirror.twin);
    }
  }
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
    a.mirror = false;
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
