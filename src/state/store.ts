import type {
  ArtworkInstance,
  AssemblyPart,
  ColorSettings,
  DesignSource,
  LibraryEntry,
  ParsedSVG,
} from '../types';
import type { ZoneNet } from '../geometry/zoneCharts';
import { getFilament } from './filaments';
import { DEFAULT_PRINTER_ID } from '../export/printers';
import { HUBCAP_DEFAULT_DIAMETER_MM } from '../geometry/hubcap';

/**
 * The single source of truth for everything the geometry pipeline consumes.
 * UI modules write here (then scheduleRebuild); geometry/scene code only reads.
 */
export interface AppState {
  parsed: ParsedSVG | null;
  /** key (hex or "merge:a,b,c") -> per-recess settings */
  colorSettings: ColorSettings;
  /** each inner array of raw hex codes = one merged AMS slot */
  mergeGroups: string[][];
  /** auto-merge slider stop — index into AUTO_MERGE_LEVELS (0 = off, default 1 = Slight/dedupe) */
  autoMergeLevel: number;
  /** dominant (largest-area) member of baseColorMembers — the body's printed color, kept in sync by the build (rebuild.ts); seeded provisionally by addToBase(). */
  baseColorKey: string | null;
  /** every raw hex excluded from cutting because grouped into the base — grown by addToBase(), shrunk by removeFromBase() */
  baseColorMembers: string[];
  /** raw hexes explicitly pulled out of a group, pinned so auto-merge won't re-swallow them; in-memory only, reset on new artwork */
  keptApart: string[];

  // artwork fit
  /** Bounded by SCALE_MIN_PCT/SCALE_MAX_PCT below. */
  scalePct: number;
  offsetX: number;
  offsetY: number;
  flipX: boolean;
  flipY: boolean;
  /** design rotation about its center, in degrees (0 = as authored) */
  rotationDeg: number;

  // depth
  globalDepth: number;

  // export
  printerId: string;

  // assembly
  asmRadius: number;
  /** Outer diameter (mm) of the generated hubcap disc. A build parameter: changing it re-runs the generator (asmRebuildGeneratedParts), so it lives in state beside the other rebuild inputs, not the editing panel. */
  hubcapDiameterMm: number;
  /**
   * Cut the hubcap to the silhouette of its artwork instead of leaving it a circle. Shape and artwork
   * are one object, so this is a toggle, not a second upload (silhouetteFromShapes). Off,
   * `hubcapDiameterMm` is the circle's diameter; on, the silhouette's longest side.
   */
  hubcapSilhouette: boolean;
  assembly: {
    kindId: string | null;
    /** chosen hardware variant for a kind with `variants` (chair Standard/Kit); null otherwise */
    variantId: string | null;
    parts: AssemblyPart[];
    nextPartId: number;
    library: LibraryEntry[];
    /** The loaded kind's baked net: where each zone's sheet sits unfolded, for a design bound to the whole part. Null if the bake baked none. Read only through `netZones()` (state/artwork.ts), which also checks the zones are loaded. */
    net: ZoneNet | null;
  };

  /** body/base color, chosen from the owned-filament palette (null = neutral default) */
  baseFilamentId: string | null;

  /**
   * Multi-zone artwork model. `parsed` stays the single source of parsed geometry the build reads;
   * `sources`/`artworks` are a parallel layer mirroring it into named instances for a future
   * multi-instance panel (Phase 2b). Today at most one of each (state/artwork.ts).
   */
  sources: DesignSource[];
  artworks: ArtworkInstance[];
  /** the instance the gizmo, fit sliders, and the build currently target */
  activeArtworkId: string | null;
}

export const state: AppState = {
  parsed: null,
  colorSettings: {},
  mergeGroups: [],
  autoMergeLevel: 1,
  baseColorKey: null,
  baseColorMembers: [],
  keptApart: [],

  scalePct: 100,
  offsetX: 0,
  offsetY: 0,
  flipX: false,
  flipY: false,
  rotationDeg: 0,

  globalDepth: 1.0,

  printerId: DEFAULT_PRINTER_ID,

  asmRadius: 138,
  hubcapDiameterMm: HUBCAP_DEFAULT_DIAMETER_MM,
  hubcapSilhouette: false,
  assembly: { kindId: null, variantId: null, parts: [], nextPartId: 1, library: [], net: null },

  baseFilamentId: null,

  sources: [],
  artworks: [],
  activeArtworkId: null,
};

/** Neutral PLA-grey used when no base filament is chosen. */
/**
 * Smallest Design radius the app accepts, in mm. Not a print constraint: 0 makes every cut fail
 * while Export stays green and a negative builds as positive, so it only has to be above zero. It
 * matches the field's `step`, keeping the spinner on its grid (`min` is the step base).
 *
 * Shared with the restore path: a "> 0" guard there was looser than the field's floor, so a session
 * carrying 0.2 showed 0.2 unmarked, then the first blur snapped the field to its default while state
 * kept 0.2 — panel and export disagreeing.
 */
export const MIN_DESIGN_RADIUS_MM = 0.5;

/**
 * What Scale can be set to, in percent. Duplicated in index.html's `#p-scale` min/max, which
 * actually clamp the slider pair; nothing pins the two together.
 *
 * Not only a slider range: the gizmo clamps drags to it, and the assembly build gets the max as
 * `maxScaleMult` to decide whether a refused fill says "Raise Scale" or "at any Scale". Raise the
 * markup alone and the app calls a fill impossible at a Scale the slider reaches. Change both in one commit.
 */
export const SCALE_MIN_PCT = 25;
export const SCALE_MAX_PCT = 400;

export const DEFAULT_BASE_COLOR = '#b9c0c6';

/**
 * The base is one of: a detected artwork color (wins when set — recolors the body to it AND excludes
 * it from cutting, see applyColorMerges), a chosen filament, or the neutral default. Artwork color
 * and filament/default are mutually exclusive (see renderBaseColorSwatches).
 */
export function baseColorHex(): string {
  if (state.baseColorKey) return state.baseColorKey;
  return getFilament(state.baseFilamentId)?.hex ?? DEFAULT_BASE_COLOR;
}

/** Group more raw hexes into the base: accumulates, so "→ base" and dropping onto the Base row both grow it. One semantic on purpose: the button used to replace, so a second click silently evicted the first color while the same drop added. Removal is the Base row's "×". The build re-derives baseColorKey as the dominant member; seeded here so something shows before then. */
export function addToBase(hexes: string[]): void {
  const add = hexes.filter(Boolean);
  if (!add.length) return;
  const set = new Set(state.baseColorMembers);
  add.forEach((h) => set.add(h));
  state.baseColorMembers = Array.from(set);
  if (!state.baseColorKey) state.baseColorKey = add[0];
  add.forEach((h) => {
    const idx = state.keptApart.indexOf(h);
    if (idx !== -1) state.keptApart.splice(idx, 1);
  });
}

/** Pull one color back out of the base — it returns to being cut as its own recess. */
export function removeFromBase(hex: string): void {
  const idx = state.baseColorMembers.indexOf(hex);
  if (idx === -1) return;
  state.baseColorMembers.splice(idx, 1);
  if (!state.baseColorMembers.length) {
    clearBaseColor();
  } else if (state.baseColorKey === hex) {
    // build re-derives the true dominant next rebuild; seed with a remaining member meanwhile
    state.baseColorKey = state.baseColorMembers[0];
  }
}

/** Undo a base assignment — the slot(s) go back to being cut. */
export function clearBaseColor(): void {
  state.baseColorKey = null;
  state.baseColorMembers = [];
}
