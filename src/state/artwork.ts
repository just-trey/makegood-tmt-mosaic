import type { ArtworkInstance, DesignSource, ParsedSVG, RasterState, ZoneMirror } from '../types';
import { clearBaseColor, state } from './store';
import { deltaE, hexToLab } from '../color';
import {
  parseRasterImage,
  placedFloors,
  rasterCappedMessage,
  rasterColorLossKey,
  rasterColorLossNotice,
  rasterTracedMessage,
} from '../raster/parse';
import type { RasterParseResult } from '../raster/parse';
import type { RasterImage } from '../raster/types';
import type { NetZonePlacement } from '../geometry/zoneCharts';
import { boundsCentre, netOffsetToZone, WHOLE_CHAIR_ZONE } from '../geometry/zones';
import { currentAssemblyKind, currentDesignScaleContext, fillWithheld } from '../assembly/kinds';
import { canvasAnchor, designMmPerUnit, placedFootprintMM } from '../geometry/designScale';
import { OVERLAP_WARN_FRACTION } from '../geometry/designOverlap';
import { dismissNotice, notice, warn } from '../warnings';

let nextSourceId = 1;
let nextArtworkId = 1;

/**
 * How far each additional design is stepped off one already at that spot, in mm on the face.
 *
 * A new instance seeds from the fit settings, so on a one-zone part (wheel, footrest) a second
 * design landed exactly coplanar with the first, with nothing showing there were two. Stepping it
 * makes it visible and draggable.
 *
 * Deliberately small rather than "clear of the first": the app doesn't control design size (the
 * wheel's default is a 276mm circle), and a step that separated that would throw a small design off
 * the face, where the boundary clip silently eats it. Clearing the rest is the user's call —
 * buildAssemblyGeometry warns and names both designs while they cross (geometry/designOverlap.ts).
 */
export const INSTANCE_CASCADE_MM = 8;

/** Two placements count as the same spot within this — a float-comparison tolerance, not a gap. */
const SAME_SPOT_MM = 1e-6;

/**
 * Do two zone bindings put their designs on the same surface? `null` ("All zones") and the
 * whole-part id each cover every zone, so each shares a surface with any binding, itself included.
 * Comparing ids directly treats them as zones of their own and lets a bound design seed on top of
 * one already stamped everywhere.
 */
function sharesSurface(a: string | null, b: string | null): boolean {
  const everywhere = (z: string | null): boolean => z === null || z === WHOLE_CHAIR_ZONE;
  return everywhere(a) || everywhere(b) || a === b;
}

/** One design's placement on one surface, in that surface's own offset space. */
interface PlacedMark {
  /** a real zone id, or null for a binding that lands on every zone at once */
  zoneId: string | null;
  offsetU: number;
  offsetV: number;
}

/**
 * Where a placement actually lands, one entry per surface it cuts on.
 *
 * A whole-part binding is placed in **net** mm and cut as one placement per sheet, so its offsets
 * move onto each zone (`netOffsetToZone`, the same algebra as the build's expansion in rebuild.ts)
 * before they compare against a zone-bound placement; raw, net mm vs zone mm is neither same nor
 * different. Empty for a whole-part binding on a kind with no net — nothing is cut, and the build says so.
 */
function placedMarks(zoneId: string | null, offsetU: number, offsetV: number): PlacedMark[] {
  if (zoneId !== WHOLE_CHAIR_ZONE) return [{ zoneId, offsetU, offsetV }];
  const net = netZones();
  if (!net) return [];
  return net.zones.map((z) => {
    const [u, v] = netOffsetToZone([offsetU, offsetV], z.place, net.netCentre, z.zoneCentre);
    return { zoneId: z.zoneId, offsetU: u, offsetV: v };
  });
}

const sameSpot = (x: PlacedMark, y: PlacedMark): boolean =>
  sharesSurface(x.zoneId, y.zoneId) &&
  Math.abs(x.offsetU - y.offsetU) < SAME_SPOT_MM &&
  Math.abs(x.offsetV - y.offsetV) < SAME_SPOT_MM;

/**
 * The largest placed design the cascade will step the full width of.
 *
 * A diagonal step of `c` fully separates designs needing `c` clearance, while the constant step `d`
 * leaves them covering ((c−d)/c)² of each other, which only reaches `OVERLAP_WARN_FRACTION` for
 * c ≥ d/(1−√fraction). Below that the constant seeded a real overlap the build never mentioned:
 * two 10mm designs stepped 8mm apart cut 4% into each other in silence. So step the full clearance
 * up to here and keep the constant above it, where it is both smaller and loud.
 * Scaling the step all the way up is what INSTANCE_CASCADE_MM already rejects (276mm wheel default).
 *
 * Known limits: any single step has a silent band from itself up to 1.4625× itself, and one step per
 * surface is forced (per-design steps put a later small one between an earlier big one's spots —
 * pinned by "does not park a small design inside one already cascaded past it" in
 * tests/artwork.test.ts). So a surface with anything over this size is back on the constant, and
 * opposite-proportion designs (8x11.5mm vs 11.5x8mm) defeat the clearance measure whatever it is;
 * reading the wider axis would part that pair but move every alike pair further than needed.
 * Closing the band for real means a nearest-free-placement search on actual footprints, not a lattice.
 */
export const CASCADE_CLEAR_MAX_MM = INSTANCE_CASCADE_MM / (1 - Math.sqrt(OVERLAP_WARN_FRACTION));

function cascadeStepMM(clearance: number): number {
  return clearance > CASCADE_CLEAR_MAX_MM
    ? INSTANCE_CASCADE_MM
    : Math.max(INSTANCE_CASCADE_MM, clearance);
}

/** What the cascade needs to know about a design to size its step. */
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
 * across its narrower axis (what two copies need to come apart).
 *
 * Read off the surface, not the pair: every design steps along one diagonal lattice, and a per-pair
 * step lets a smaller later design land between an earlier one's lattice points and sit inside it
 * (a 5mm design stepping 8mm past a 10mm one at 10mm ends up wholly within it).
 *
 * The narrower axis answers for the pair only when the designs are shaped alike: a 5x200 bar and a
 * 200x5 bar both report 5 and no such step parts them. See docs/tech-debt.md.
 * Zero when no footprint is known, which falls back to the constant.
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
 * The seed offset moved off any instance already at that exact spot on the same surface, stepping
 * diagonally until free (or `steps` runs out). Returns the seed untouched when nothing is there —
 * the common first/only-design case — so its placement is bit-for-bit unchanged.
 */
function cascadedOffset(
  zoneId: string | null,
  offsetU: number,
  offsetV: number,
  incoming: CascadeSubject,
): { offsetU: number; offsetV: number } {
  const taken = state.artworks.flatMap((a) =>
    placedMarks(a.zone?.zoneId ?? null, a.offsetU, a.offsetV),
  );
  const at = (u: number, v: number): boolean =>
    placedMarks(zoneId, u, v).some((m) => taken.some((t) => sameSpot(m, t)));
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
 * traced for. Undefined when there is nothing to answer with; the trace then uses its
 * fraction-of-the-image floor alone.
 *
 * Needs no traced bbox, because an assembly places an image on its own frame (`designAnchor`); a fit
 * to drawn content would use the opaque pixels, wrong in the damaging direction (one stray corner
 * speck inflates the extent, shrinks mm per pixel and raises the floor over printable detail).
 *
 * This runs before placement is known, so the despeckle floor was only a share of the image: for one
 * photograph, removing 8.7mm features on the footrest and 1.4mm ones on the smallest hubcap. With it,
 * `despeckleFloorPx` sizes the floor in mm, lowering it below the fraction on large flat art and
 * raising it to a nozzle width on small faces. Uses the build's own two scale rules, so floor and
 * cut describe the same design. Read on every rebuild, which re-traces once the floors stop matching
 * (`retraceMovedSources`).
 */
export function rasterMmPerPixel(img: RasterImage, sourceId?: string): number | undefined {
  const mm = assemblyMmPerUnit(img, sourceId);
  return mm !== undefined && Number.isFinite(mm) && mm > 0 ? mm : undefined;
}

/**
 * The largest millimetre-per-pixel any instance of this source is placed at.
 *
 * Largest, because one trace serves every instance and a floor sized for the smallest would discard
 * detail the biggest prints fine. Each instance is asked separately: Fill and Sticker use different
 * scale rules (`designMmPerUnit`'s forceRect), entirely different formulas on the wheel. A source
 * with no instance yet is a first load — a Sticker at the global fit, which `loadArtworkSource` is
 * about to create.
 *
 * Undefined while a rect kind's parts load: `designMmPerUnit` answers 1mm per unit there, real for
 * an SVG with no viewBox but a fiction for an image, which would be saved to the session as measured
 * and give an inert floor.
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
 * Register a freshly-parsed SVG as a new design source and auto-create its instance. Placement seeds
 * from the global offset/scale/rotation/flip — not the previous active instance, since the designs
 * aren't related — stepped off when that would land exactly on an existing design
 * (INSTANCE_CASCADE_MM). The instance becomes active and `state.parsed` (still read by legacy
 * single-instance code) mirrors it.
 *
 * Binds to the first offered zone on a multi-zone kind: `zone: null` ("All zones") stays available
 * but is the wrong default there — on the chair it recuts 25 conformal charts on every slider nudge
 * for a result nobody asked for. One-zone or zoneless kinds (wheel, footrest) start unbound.
 */
export function loadArtworkSource(
  parsed: ParsedSVG,
  name: string,
  kind: DesignSource['kind'] = 'upload',
  mode: ArtworkInstance['mode'] = 'sticker',
  // '' for the many tests that build a ParsedSVG directly; only session persistence (state/persist.ts) needs real text. A raster source has none.
  svgText: string = '',
  // Attached up front so a source is never briefly half-built for the list panel to render.
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

  // Whole chair is excluded from the default pick like `zone: null` above: it stamps the design onto every net zone at once.
  const zones = availableZones().filter((z) => z.zoneId !== WHOLE_CHAIR_ZONE);
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
 * Repopulate the pool from a restored session (state/persist.ts), preserving saved string ids
 * since `artworks[].sourceId` points at them. Zones come in as `zone: null`; the restore caller
 * re-applies them via setArtworkZone() once parts reload, since a saved `partId` can't outlive its
 * session. Advances the id counters so later loads can't collide.
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
 * Designs pool, so a base assignment or merge group made on one artwork must survive loading a
 * second. But keeping all of them is wrong too: a stale hex in `baseColorMembers` silently excludes
 * a later design that happens to reuse it. Pruning to what's on screen is right both ways.
 */
export function pruneSettingsToPalette(): void {
  const live = livePalette();
  const isLiveKey = (rawKey: string) => {
    // Assembly-mode depth keys are the flat key with an "asm:" prefix (geometry/assembly.ts). Read
    // past it: unprefixed, they fell through to the "not a hex" arm and were kept forever, so a
    // per-color depth outlived its design and re-applied to the next one using that hex.
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
 * How far a color may move across a re-quantize and still count as "the same" color.
 *
 * Re-quantizing moves every centroid, so palette hexes change on each Colors nudge; without this the
 * prune would delete per-color depths and base assignment every time. 6 is a deliberately generous
 * CIE76 distance — past the "Slight" auto-merge cutoff of 3, so slider drift is carried while a
 * genuinely different color is not.
 */
const SETTING_REMAP_DE = 6;

/**
 * The prefix geometry/assembly.ts builds its per-region depth keys with. Remapping the bare hex
 * moved no setting on a Colors nudge, and pruneSettingsToPalette (which reads past the prefix)
 * then deleted every custom recess depth.
 */
const DEPTH_KEY_PREFIX = 'asm:';

/**
 * Carry per-color settings across a palette change, for colors no longer painted by anything.
 * Depth on a *merged* group isn't carried: its key is built from member hexes, so it changes and
 * there is nothing stable to match; the prune that follows drops it.
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
    const from = DEPTH_KEY_PREFIX + oldHex;
    const to = DEPTH_KEY_PREFIX + target;
    if (state.colorSettings[from] && !state.colorSettings[to])
      state.colorSettings[to] = state.colorSettings[from];
    const swap = (list: string[]) => list.map((h) => (h === oldHex ? target : h));
    state.keptApart = swap(state.keptApart);
    state.baseColorMembers = swap(state.baseColorMembers);
    state.mergeGroups = state.mergeGroups.map(swap);
    if (state.baseColorKey === oldHex) state.baseColorKey = target;
  }
}

/** Re-run quantize/trace on a loaded image at new Colors/Detail. Reuses the decoded pixels; synchronous — the caller owns the rebuild it schedules. */
export function requantizeSource(
  sourceId: string,
  patch: { colors?: number; detail?: number },
): TraceOutcome | null {
  const source = state.sources.find((s) => s.id === sourceId);
  if (!source || !isRasterSource(source)) return null;
  const colors = patch.colors ?? source.raster.colors;
  const detail = patch.detail ?? source.raster.detail;

  // Re-derived: a fresh trace gets the size the design is placed at now. The stored value stands in
  // when placement can't be read (a rect kind mid-reload), rather than dropping the floor into the session.
  const mmPerPixel = rasterMmPerPixel(source.raster.image, source.id) ?? source.raster.mmPerPixel;
  const result = parseRasterImage(source.raster.image, {
    colors,
    detail,
    mmPerPixel,
    name: source.name,
  });
  failedRetraces.delete(source.id);
  dismissNotice('', retraceFailedKey(source.id));
  const oldPalette = source.raster.palette;
  // A new ParsedSVG with a new `shapes` array, never a mutation: computeNetRegionsByColor memoizes on that array's identity.
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
    floorReason: result.floorReason,
  };
}

/** What a finished trace says about itself, for `announceTrace`. */
export type TraceOutcome = Pick<
  RasterParseResult,
  'capped' | 'droppedColors' | 'detailLowersFloor' | 'floorReason'
>;

/** Raise the notices a finished trace owes — same at load, restore, slider and resize. Both keys replace in place (warnings.ts push). */
export function announceTrace(sourceId: string, name: string, result: TraceOutcome): void {
  notice(
    result.capped ? rasterCappedMessage(name, result.droppedColors) : rasterTracedMessage(name),
    sourceId,
  );
  const loss = rasterColorLossNotice(name, result);
  if (loss) notice(loss, rasterColorLossKey(sourceId));
  // Empty text: the key decides which entry goes (warnings.ts).
  else dismissNotice('', rasterColorLossKey(sourceId));
}

/** The floors a re-trace already came back empty at, per source. The same floors fail the same way, so later rebuilds skip the retrace. */
const failedRetraces = new Map<string, string>();

function floorsKey(source: DesignSource & { raster: RasterState }, mmPerPixel?: number): string {
  const f = placedFloors(source.raster.image, source.raster.detail, mmPerPixel);
  return `${f.floor}/${f.floorAtMax}`;
}

/** The key of the warning a failed re-trace raises, beside the notices the kept trace still owns. */
function retraceFailedKey(sourceId: string): string {
  return `${sourceId}:retrace`;
}

/**
 * Re-trace every raster source whose placement has moved its despeckle floor, when `settled`;
 * otherwise only report whether one is owed.
 *
 * Compared as floors, not a resize ratio, because no ratio exists (`bench-raster.ts steps`): on a
 * 32-270mm hubcap flat art moves its floors at a 0.01-4% resize where a placed floor binds and
 * holds them through 8.9-65% where the fraction does; a 512px photo holds them through any
 * enlargement. Equal floors trace identically. An unreadable placement (rect kind mid-reload) is
 * never stale.
 *
 * Per source: one that comes back empty keeps its old trace and says why while the rest re-trace;
 * that warning goes once the placement leaves the floors it failed at.
 */
export function retraceMovedSources(settled: boolean): { retraced: boolean; owed: boolean } {
  let retraced = false,
    owed = false;
  for (const source of state.sources) {
    if (!isRasterSource(source)) continue;
    const mmPerPixel = rasterMmPerPixel(source.raster.image, source.id);
    if (mmPerPixel === undefined) continue;
    const key = floorsKey(source, mmPerPixel);
    const failed = failedRetraces.get(source.id);
    if (failed !== undefined && failed !== key) {
      failedRetraces.delete(source.id);
      dismissNotice('', retraceFailedKey(source.id));
    }
    if (key === floorsKey(source, source.raster.mmPerPixel) || key === failed) continue;
    if (!settled) {
      owed = true;
      continue;
    }
    try {
      const result = requantizeSource(source.id, {});
      if (result) announceTrace(source.id, source.name, result);
      retraced = true;
    } catch (e) {
      failedRetraces.set(source.id, key);
      warn((e as Error).message, retraceFailedKey(source.id));
    }
  }
  return { retraced, owed };
}

/**
 * A second placement of an already-loaded source — the list's "+ add to another zone". Starts from
 * neutral placement, not the globals: it's going to a different zone, so copying the other
 * instance's placement would confuse. If it's the same zone (or the part has one), neutral means
 * straight on top, so it steps off (INSTANCE_CASCADE_MM). Becomes active.
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
    // Sticker/fill belongs to the design, not its position: a pattern on a second zone is still a pattern.
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
 * gizmo read/write (the reverse of syncActiveArtworkPlacement). Also mirrors `state.parsed` to its
 * source so bbox code reads the right design.
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
export function zoneMirrorOf(zoneId: string): ZoneMirror | undefined {
  for (const part of state.assembly.parts)
    for (const z of part.zones ?? []) if (z.id === zoneId) return z.mirror;
  return undefined;
}

/** Bind (or unbind, with `zoneId: null`) which zone an instance's artwork lands on. */
export function setArtworkZone(instanceId: string, zoneId: string | null): void {
  const a = state.artworks.find((x) => x.id === instanceId);
  if (!a) return;
  a.zone = zoneId ? { partId: partIdForZone(zoneId), zoneId } : null;
  // A saved or ticked Mirror survives rebinding to a zone that also offers it (restoreSession rebinds
  // after the pool restores mirror:true) and drops when the new zone offers none, so a stale flag
  // never reaches a mapper with nothing to mirror against. Judged only while some zone is offered:
  // restore may run while the parts manifest is in flight (an empty zone list is not evidence).
  if (a.mirror && (!zoneId || (availableZones().length > 0 && !zoneMirrorOf(zoneId))))
    a.mirror = false;
}

/** Toggle an instance's cut on its zone's mirror. Only takes effect on a zone that offers one (`ZoneMirror`); elsewhere it stays off, as in a pre-Mirror session. */
export function setArtworkMirror(instanceId: string, on: boolean): void {
  const a = state.artworks.find((x) => x.id === instanceId);
  if (!a) return;
  a.mirror = on && !!(a.zone && zoneMirrorOf(a.zone.zoneId));
}

/** Switch one instance between a single copy and a zone-wide repeat. Per instance, not per source: one design can be a sticker on one zone and a fill on another. */
export function setArtworkMode(instanceId: string, mode: ArtworkInstance['mode']): void {
  const a = state.artworks.find((x) => x.id === instanceId);
  if (a) a.mode = allowedArtworkMode(mode);
}

/**
 * Fill coerced to Sticker on a kind that withholds it. State never holds Fill where it misbehaves,
 * so the build needs no matching check — letting `mode` stay 'fill' and reinterpreting downstream
 * is the one-value-two-meanings CLAUDE.md warns about.
 */
export function allowedArtworkMode(mode: ArtworkInstance['mode']): ArtworkInstance['mode'] {
  return mode === 'fill' && fillWithheld() ? 'sticker' : mode;
}

/**
 * Names one design a switch took out of Fill, so the rewrite is never silent.
 * Two reasons reach here: a kind with `withholdFill` (the part can't), and Cut to artwork shape on
 * the hubcap (the setting can't). The message must name the true one.
 */
export function fillClampedNotice(name: string, partName: string, bySetting: boolean): string {
  return bySetting
    ? `"${name}" is a sticker now. Cut to artwork shape can't repeat a design across the shape it cut.`
    : `"${name}" is a sticker now. The ${partName} can't repeat a design across it yet.`;
}

/**
 * One key per design, so a second clamped design is reported instead of colliding with the first.
 * Exported because the notice outlives the design: clampArtworkModes' retraction walks live sources,
 * so after removal nothing matches. artworkListPanel's remove handler retracts it.
 */
export const fillClampKey = (sourceId: string): string => `fill-clamped:${sourceId}`;

/**
 * Re-clamp every loaded design's mode against the current part. Artwork outlives a part switch, so a
 * design set to Fill on the wheel would arrive on the chair still Fill and rebuild through the path
 * the flag keeps it out of. Returns whether anything changed, so callers can skip a rebuild.
 *
 * Says so when it does: a design carried over from the wheel loses a mode the user chose, and the
 * control it was chosen with is not on screen.
 */
export function clampArtworkModes(): boolean {
  let changed = false;
  const clamped = new Map<string, string>();
  state.artworks.forEach((a) => {
    const next = allowedArtworkMode(a.mode);
    if (next === a.mode) return;
    a.mode = next;
    changed = true;
    // Two placements of one design clamp together and are one row on screen, so named once. A gone
    // source still gets an entry under its own id — not being nameable is no reason for silence.
    const src = state.sources.find((s) => s.id === a.sourceId);
    clamped.set(src?.id ?? a.id, src?.name ?? 'A design');
  });
  // Session-scoped, so nothing else takes them down, and they state a standing fact (this design is
  // a sticker here). A clamped mode is plain `sticker` and indistinguishable from a chosen one, so
  // the fact can't be re-derived later — hence a still-true notice is left alone, not retracted and
  // re-raised. Only Fill working again ends it, the one condition checked here.
  //
  // Known staleness: moving between the chair and a hubcap already on Cut to artwork shape keeps
  // Fill withheld throughout, so nothing dismisses or re-raises and the pill keeps its original
  // wording, which on that path names a toggle the chair doesn't render. Fixing it means keying the
  // notice on the part as well as the design; written down rather than patched.
  if (!fillWithheld()) {
    for (const id of [...state.sources.map((s) => s.id), ...state.artworks.map((a) => a.id)])
      dismissNotice('', fillClampKey(id));
    return changed;
  }
  const bySetting = !currentAssemblyKind()?.withholdFill;
  const partName = currentAssemblyKind()?.name ?? 'part';
  for (const [id, name] of clamped)
    notice(fillClampedNotice(name, partName, bySetting), fillClampKey(id));
  return changed;
}

function partIdForZone(zoneId: string): number {
  return state.assembly.parts.find((p) => p.zones?.some((z) => z.id === zoneId))?.id ?? 0;
}

/**
 * Every zone id offered by the loaded assembly parts, deduped and named — what the per-instance zone
 * dropdown and the Part panel's template links offer. Empty outside assembly mode or for a kind with
 * no zone sidecar (`zones: undefined` is one implicit flat zone, not a pickable one).
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
  const out = Array.from(seen, ([zoneId, v]) => ({ zoneId, ...v }));
  const net = netZones();
  // First, as the whole part with every other entry a piece of it. Named for the thing, not the layout
  // ("net" is our word). Reads "Whole <kind>" off the kind's display name, first word only: the
  // chair's "Chair body" would name the part twice in "Whole chair body".
  if (net)
    out.unshift({
      zoneId: WHOLE_CHAIR_ZONE,
      name: `Whole ${(currentAssemblyKind()?.name ?? 'part').split(' ')[0].toLowerCase()}`,
      templateFile: state.assembly.net!.templateFile,
    });
  return out;
}

/** One zone of the net, with what's needed to move a whole-part placement onto it. */
export interface NetZoneBinding {
  zoneId: string;
  place: NetZonePlacement;
  /** the zone's own UV bbox centre, which is what its placer anchors on */
  zoneCentre: [number, number];
}

/**
 * The loaded kind's net resolved against the parts in the scene: the canvas anchor, one entry per
 * net zone a loaded part carries, and the zones on either side that didn't pair up.
 *
 * Null where a whole-part binding can't mean anything (no net baked, or none of its zones loaded).
 * The mismatch lists are kept, not filtered: a zone nothing carries, or a loaded zone the net never
 * placed, takes no artwork, and the build must say so.
 */
export function netZones(): {
  netCentre: [number, number];
  zones: NetZoneBinding[];
  /** zones the net places that no loaded part carries, named off the net's own record of them */
  missing: { zoneId: string; name: string }[];
  /** zones a loaded part offers that the net does not place */
  unplaced: { zoneId: string; name: string }[];
} | null {
  const net = state.assembly.net;
  if (!net) return null;
  const bounds = new Map<string, { minU: number; minV: number; maxU: number; maxV: number }>();
  const names = new Map<string, string>();
  for (const part of state.assembly.parts)
    for (const z of part.zones ?? []) {
      if (z.chart?.zoneBounds && !bounds.has(z.id)) bounds.set(z.id, z.chart.zoneBounds);
      if (!names.has(z.id)) names.set(z.id, z.name);
    }
  const zones: NetZoneBinding[] = [];
  const missing: { zoneId: string; name: string }[] = [];
  for (const [zoneId, place] of Object.entries(net.zones)) {
    const b = bounds.get(zoneId);
    if (b) zones.push({ zoneId, place, zoneCentre: boundsCentre(b) });
    else missing.push({ zoneId, name: place.name ?? zoneId });
  }
  if (!zones.length) return null;
  const unplaced = Array.from(bounds.keys())
    .filter((id) => !net.zones[id])
    .map((zoneId) => ({ zoneId, name: names.get(zoneId) ?? zoneId }));
  return { netCentre: boundsCentre(net.bounds), zones, missing, unplaced };
}

/**
 * How many design zones carry at least one artwork instance, out of how many the part offers — behind
 * the chair's "N of M zones have artwork" notice and the pre-export coverage check. `zone: null`
 * counts every zone covered. `{ total: 0, ... }` on a one/no-zone kind.
 */
export function zoneCoverage(): { total: number; covered: number } {
  // The whole-part entry is every other entry at once, not a surface of its own: not counted, only fillable.
  const zones = availableZones().filter((z) => z.zoneId !== WHOLE_CHAIR_ZONE);
  if (!zones.length) return { total: 0, covered: 0 };
  if (state.artworks.some((a) => a.zone === null))
    return { total: zones.length, covered: zones.length };
  const net = netZones();
  const bound = new Set<string>();
  for (const a of state.artworks) {
    const zoneId = a.zone?.zoneId;
    if (!zoneId) continue;
    // A whole-part design cuts onto every zone the net places, detached sheets included (the build expands it per zone).
    if (zoneId === WHOLE_CHAIR_ZONE) {
      for (const z of net?.zones ?? []) bound.add(z.zoneId);
      continue;
    }
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
 * Remove one artwork instance (the list's ×). Removing the last instance of a source removes the
 * source (an orphan can't be targeted). Falls back to clearArtwork() when nothing's left so
 * `state.parsed` and the color/merge/base settings reset as before.
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
 * Drop every loaded artwork — the counterpart to loadArtworkSource. Leaves offset/scale/rotation/
 * flip alone: a placement preference that (like autoMergeLevel) survives removal. State only —
 * callers own DOM/rebuild side effects.
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
 * Clear every instance's zone binding on an assembly kind switch. The new kind is a different mesh,
 * so a stale `{ partId, zoneId }` would point at nothing or silently match a same-named zone on an
 * unrelated part; "every zone the part offers" is the safe default. Otherwise a chair-zone instance
 * would take no cut on the wheel with nothing in the UI saying why.
 */
export function clearArtworkZoneBindings(): void {
  state.artworks.forEach((a) => {
    a.zone = null;
    a.mirror = false;
  });
}

/**
 * Mirror the legacy global placement fields onto the active instance. They're still the fit
 * sliders' and gizmo's write target, so this keeps the instance fresh before assembly code reads it.
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
