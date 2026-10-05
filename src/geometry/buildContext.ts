import type { AssemblyPaletteEntry, AssemblyPart, ColorSettings, PolyFeature } from '../types';
import type { ArtworkBuildInput } from './assembly';
import type { PartDepthClamp, ZeroDepthRaise } from './depth';
import type { ManifoldAPI } from './manifold';
import type { TileCell } from './patterns';
import type { DesignPlacement } from './zones';

/** What every part's build reads. Fixed for one `buildAssemblyGeometry` call. */
export interface BuildContext {
  artworks: ArtworkBuildInput[];
  palette: AssemblyPaletteEntry[];
  /** [color][artwork], see `featuresByColor` in buildAssemblyGeometry */
  featuresByColor: (PolyFeature | null)[][];
  placements: DesignPlacement[];
  maxScalePlacement: (ai: number) => DesignPlacement;
  tileCells: TileCell[];
  tileVerts: number[];
  colorSettings: ColorSettings;
  globalDepth: number;
  wasm: ManifoldAPI;
}

export interface TornPill {
  message: string;
  tearMm: number;
}

/**
 * Build-wide state a part reads as well as writes, so it carries from one part to the next. Only
 * keyed reads and writes, so the part cache (partCache.ts) can log which keys a part touched.
 */
export interface CrossPartState {
  /** Standing straddle pills for this build, keyed by design and boundary — raiseTornWarning. */
  tornPills: { get(key: string): TornPill | undefined; set(key: string, pill: TornPill): void };
  /**
   * Overlap is per zone, and the loop walks zones once per part. Both placers add the same
   * translation, mirror and rigid rotation to BOTH designs, so overlap is part-invariant; skipping
   * the repeat keeps the ink transform off the per-part path.
   */
  overlapCheckedZones: { has(zoneId: string): boolean; add(zoneId: string): void };
}

/**
 * What one part adds to the build's facts, which a part only writes. Each part fills its own and
 * mergePartTally folds it into the build's, so a cached part's can be folded in the same way.
 */
export interface PartTally {
  /**
   * Colors an edge rule took the full thickness, with the depth. Said once at the end: one fact
   * about the design, and a color can sit on several parts.
   */
  edgeCutColors: Map<string, number>;
  /** Zero-depth raises, build-wide: the message names no part, and is said once. */
  zeroDepthRaises: Map<string, ZeroDepthRaise>;
  /** A part's maxCutDepth() clamp (addPartTooDeepClamp), keyed per part since the bound is. */
  tooDeepClamps: Map<string, PartDepthClamp>;
  /** A thinner wall under the region: "deeper than the part goes" is false of that pocket. */
  thinWallClamps: Map<string, PartDepthClamp>;
  /**
   * Depth actually cut per palette index, for the colour list's display-only Depth field
   * (docs/tech-debt.md).
   */
  colorAppliedDepth: Map<number, number>;
  /**
   * Palette indices that reached a design surface: a survived clip, an inlay (a cut-through zone's
   * boolean is its bound), or any CSG failure on the color, so a broken boolean never also says
   * "move it". Only colors that provably reached nothing get the off-part warning.
   */
  landedColors: Set<number>;
  /**
   * Of those, kept out only by hidden surface: the opposite remedy (move it off covered surface,
   * not back onto the part).
   */
  hiddenColors: Set<number>;
  /**
   * A fill color left with nothing once it yielded to the stickers on top, and every color that
   * reached a cutter. The first minus the second is a color the stickers hide everywhere.
   */
  coveredColors: Set<number>;
  exposedColors: Set<number>;
}

/** Everything one part's build writes besides its output and the warnings list. */
export type BuildTally = CrossPartState & PartTally;

export function newPartTally(): PartTally {
  return {
    edgeCutColors: new Map(),
    zeroDepthRaises: new Map(),
    tooDeepClamps: new Map(),
    thinWallClamps: new Map(),
    colorAppliedDepth: new Map(),
    landedColors: new Set(),
    hiddenColors: new Set(),
    coveredColors: new Set(),
    exposedColors: new Set(),
  };
}

/**
 * Fold one part's facts into the build's, leaving both what writing them one by one would have:
 * insertion order included, which sets the order of labels and notices at the end of the build.
 * Copies every entry, so `from` can be folded again (a cached part) without the two sharing a list.
 */
export function mergePartTally(into: PartTally, from: PartTally): void {
  for (const [label, depth] of from.edgeCutColors) into.edgeCutColors.set(label, depth);
  for (const [key, e] of from.zeroDepthRaises) {
    const at = into.zeroDepthRaises.get(key);
    if (!at) into.zeroDepthRaises.set(key, { ...e, labels: [...e.labels] });
    else for (const l of e.labels) if (!at.labels.includes(l)) at.labels.push(l);
  }
  for (const k of ['tooDeepClamps', 'thinWallClamps'] as const)
    for (const [key, e] of from[k]) {
      const at = into[k].get(key);
      if (!at) into[k].set(key, { ...e, labels: [...e.labels] });
      else for (const l of e.labels) if (!at.labels.includes(l)) at.labels.push(l);
    }
  for (const [ci, d] of from.colorAppliedDepth) {
    const prev = into.colorAppliedDepth.get(ci);
    into.colorAppliedDepth.set(ci, prev == null ? d : Math.min(prev, d));
  }
  for (const k of ['landedColors', 'hiddenColors', 'coveredColors', 'exposedColors'] as const)
    for (const ci of from[k]) into[k].add(ci);
}

/** Progress and yielding for one part, owned by the part loop (it knows how many parts are done). */
export interface PartProgress {
  /** progress within the current part, in [0, 1] */
  reportPartProgress: (subFraction: number) => void;
  maybeYield: () => Promise<void>;
}

/** A part the build can cut: loaded, with a design face and a mesh. */
export type CuttablePart = AssemblyPart & {
  boundaryLoops: number[][][];
  positions: Float32Array;
};

export const isCuttable = (p: AssemblyPart): p is CuttablePart =>
  p.loaded && !!p.boundaryLoops && !!p.positions;
