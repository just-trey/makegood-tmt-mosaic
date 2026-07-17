import type * as THREE from 'three';
import type {
  AssemblyPart,
  BaseParams,
  ColorSettings,
  LibraryEntry,
  ParsedSVG,
  ShapeKind,
} from '../types';
import { getFilament } from './filaments';
import { DEFAULT_PRINTER_ID } from '../export/printers';

/**
 * The single source of truth for everything the geometry pipeline consumes.
 * UI modules write here (then scheduleRebuild); geometry/scene code only reads.
 */
export interface AppState {
  parsed: ParsedSVG | null;
  shapeKind: ShapeKind;
  /** key (hex, "merge:a,b,c", or "__background__") -> per-recess settings */
  colorSettings: ColorSettings;
  stlRefMesh: THREE.Mesh | null;
  /** each inner array of raw hex codes = one merged AMS slot */
  mergeGroups: string[][];
  /** auto-merge slider stop — index into AUTO_MERGE_LEVELS (0 = off, default 1 = Slight/dedupe) */
  autoMergeLevel: number;
  /** dominant (largest-area) member of baseColorMembers — the color the body actually prints,
   * kept in sync by the build (see rebuild.ts). Seeded provisionally by addToBase(). */
  baseColorKey: string | null;
  /** every raw hex excluded from cutting because they're grouped into the base — accumulated via
   * addToBase(), shrunk via removeFromBase() */
  baseColorMembers: string[];
  /** raw hex codes explicitly pulled out of a group — pinned so the auto-merge slider won't
   * re-swallow them; in-memory only (not persisted), reset on new artwork */
  keptApart: string[];

  // base-shape parameters (mirrors the left-panel inputs)
  disc: { diameter: number; thickness: number };
  rect: { width: number; height: number; thickness: number };
  round: { width: number; height: number; corner: number; thickness: number };
  stlPlate: { width: number; height: number; thickness: number; faceZ: number };

  // artwork fit
  marginPct: number;
  scalePct: number;
  offsetX: number;
  offsetY: number;
  flipX: boolean;
  flipY: boolean;

  // depth
  globalDepth: number;
  recessBg: boolean;

  // export
  printerId: string;

  // assembly
  asmRadius: number;
  assembly: {
    kindId: string | null;
    parts: AssemblyPart[];
    nextPartId: number;
    library: LibraryEntry[];
  };

  /** body/base color, chosen from the owned-filament palette (null = neutral default) */
  baseFilamentId: string | null;
}

export const state: AppState = {
  parsed: null,
  shapeKind: 'disc',
  colorSettings: {},
  stlRefMesh: null,
  mergeGroups: [],
  autoMergeLevel: 1,
  baseColorKey: null,
  baseColorMembers: [],
  keptApart: [],

  disc: { diameter: 80, thickness: 4 },
  rect: { width: 80, height: 60, thickness: 4 },
  round: { width: 80, height: 60, corner: 8, thickness: 4 },
  stlPlate: { width: 80, height: 60, thickness: 4, faceZ: 0 },

  marginPct: 5,
  scalePct: 100,
  offsetX: 0,
  offsetY: 0,
  flipX: false,
  flipY: false,

  globalDepth: 1.0,
  recessBg: false,

  printerId: DEFAULT_PRINTER_ID,

  asmRadius: 138,
  assembly: { kindId: null, parts: [], nextPartId: 1, library: [] },

  baseFilamentId: null,
};

/** Neutral PLA-grey used when no base filament is chosen. */
export const DEFAULT_BASE_COLOR = '#b9c0c6';

/**
 * The base is one of: a detected artwork color (wins when set — it recolors the body to that
 * exact color AND excludes it from being cut, see applyColorMerges), a chosen filament, or the
 * neutral default. Only one is active at a time — assigning an artwork color and picking a
 * filament/default are mutually exclusive (see renderBaseColorSwatches).
 */
export function baseColorHex(): string {
  if (state.baseColorKey) return state.baseColorKey;
  return getFilament(state.baseFilamentId)?.hex ?? DEFAULT_BASE_COLOR;
}

/** Make these hexes THE base, releasing any previous members back to being cut — the "→ base"
 * button switches the base rather than growing it (users read a second click as "use this one
 * instead"). Growing the base is the drag gesture's job (see addToBase). */
export function replaceBase(hexes: string[]): void {
  const next = hexes.filter(Boolean);
  if (!next.length) return;
  clearBaseColor();
  addToBase(next);
}

/** Group more raw hexes into the base — accumulates, so dropping a color/merged group onto the
 * Base row grows the base slot instead of replacing it. The build re-derives baseColorKey as the
 * true dominant member on next rebuild; seed it here so the swatch/body have *something* to show
 * before that happens. */
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

/** Derive the flat-mode base parameters for the current shape from state. */
export function currentBaseParams(): BaseParams | null {
  const fit = {
    marginPct: state.marginPct,
    scaleMult: state.scalePct / 100,
    offsetX: state.offsetX,
    offsetY: state.offsetY,
    flipX: state.flipX,
    flipY: state.flipY,
  };
  if (state.shapeKind === 'disc')
    return { diameter: state.disc.diameter, thickness: state.disc.thickness, ...fit };
  if (state.shapeKind === 'rect')
    return {
      width: state.rect.width,
      height: state.rect.height,
      thickness: state.rect.thickness,
      ...fit,
    };
  if (state.shapeKind === 'round')
    return {
      width: state.round.width,
      height: state.round.height,
      corner: state.round.corner,
      thickness: state.round.thickness,
      ...fit,
    };
  if (state.shapeKind === 'stl')
    return {
      width: state.stlPlate.width,
      height: state.stlPlate.height,
      thickness: state.stlPlate.thickness,
      ...fit,
    };
  return null;
}
