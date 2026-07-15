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
  /** raw hex codes currently checked in the color list */
  selectedForMerge: Set<string>;

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
  plateSize: string;

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
  selectedForMerge: new Set(),

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

  plateSize: '256x256',

  asmRadius: 138,
  assembly: { kindId: null, parts: [], nextPartId: 1, library: [] },

  baseFilamentId: null,
};

/** Neutral PLA-grey used when no base filament is chosen. */
export const DEFAULT_BASE_COLOR = '#b9c0c6';

export function baseColorHex(): string {
  return getFilament(state.baseFilamentId)?.hex ?? DEFAULT_BASE_COLOR;
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
