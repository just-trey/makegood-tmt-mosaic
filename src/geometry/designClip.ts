import type { Position } from 'geojson';
import type { ParsedSVG, PolyFeature } from '../types';
import type { ArtworkBuildInput } from './assembly';
import { CLIP_REMNANT_FLOOR_MM2 } from './depth';
import { clipToConvex, type InkPolygon } from './designOverlap';
import { mapFeatureCoords } from './manifold';
import {
  cleanFeature,
  differenceChecked,
  dropUnprintableRemnants,
  intersectChecked,
} from './regions';
import type { KeepSide, NetExclusion, ZoneMapper } from './zones';

/** A feature's polygons, whichever of the two geometry types it carries. */
export function polysOf(f: PolyFeature): Position[][][] {
  return f.geometry.type === 'MultiPolygon'
    ? (f.geometry.coordinates as Position[][][])
    : [f.geometry.coordinates as Position[][]];
}

/** One design's kept half of a self-mirrored zone, resolved to a side and the clip for it. */
export interface KeptHalf {
  side: KeepSide;
  /** the line the half is cut at, in the zone's 2D design space */
  centreU: number;
  clip: PolyFeature;
  /** what to call the zone in the notice */
  zoneName: string;
}

/**
 * Which half a design keeps on this zone, or null when it keeps all of it: the half its placed
 * centre lies on, `keepSide` breaking only the exact tie. The centre is `fillExtent()`'s, the same
 * bbox the placer anchors on, so this is the line mirroredBuildInput reflects about.
 */
export function keptHalfFor(
  mapper: ZoneMapper,
  a: ArtworkBuildInput,
  place: (pt: number[]) => number[],
  zoneName: string,
): KeptHalf | null {
  if (!a.keepSide) return null;
  const extent = mapper.fillExtent();
  if (!extent) return null;
  const centreU = (extent.minX + extent.maxX) / 2;
  const b = a.parsed.bbox;
  const du = place([(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2])[0] - centreU;
  const side: KeepSide = du > 0 ? 'right' : du < 0 ? 'left' : a.keepSide;
  const clip = mapper.sideClip(side);
  return clip ? { side, centreU, clip, zoneName } : null;
}

/**
 * `feat` cut to the half a design keeps, for both the cutter and the overlap ink. Crossing is read
 * off vertices, not area before/after (a no-op boolean still moves the last bits). `failed` returns
 * the region unclipped silently: the cutter names it, the ink reader ignores it. Empty once cleaned
 * is empty, not removed or failed.
 */
export function clipToKeptSide(
  feat: PolyFeature,
  half: KeptHalf,
): { feat: PolyFeature | null; removed: boolean; failed: boolean } {
  if (!cleanFeature(feat)) return { feat: null, removed: false, failed: false };
  const beyond =
    half.side === 'right'
      ? (u: number): boolean => u < half.centreU
      : (u: number): boolean => u > half.centreU;
  const crosses = polysOf(feat).some((rings) =>
    rings.some((ring) => ring.some((pt) => beyond(pt[0]))),
  );
  if (!crosses) return { feat, removed: false, failed: false };
  const r = intersectChecked(feat, half.clip);
  return { feat: r.feat, removed: r.clipped, failed: !r.clipped };
}

/** What the net clip did: what is left to cut here, where the rest went, and where it is torn. */
interface NetShareClip {
  feat: PolyFeature | null;
  movedTo: string[];
  torn: { toName: string; tearMm: number }[];
  failed: boolean;
}

/**
 * `feat` cut to the canvas this zone owns on the whole-part sheet, one exclusion at a time so the
 * notice can name where each patch went. The bbox gate keeps the common case boolean-free; the
 * intersect probe then raises a notice only when the cut really moved. A failed boolean hands the
 * region back whole (a doubled cut, not a missing one) and is named.
 * `torn`: patches the ink moved into where the two sheets don't actually join, pooled per neighbour
 * at the worst tear — one design is torn once as far as the user is concerned.
 */
export function clipToNetShare(feat: PolyFeature, exclusions: NetExclusion[]): NetShareClip {
  const movedTo: string[] = [];
  const worstTear = new Map<string, number>();
  let failed = false;
  let cur: PolyFeature | null = cleanFeature(feat);
  const done = (): NetShareClip => ({
    feat: cur,
    movedTo,
    // Only while ink is still cut here: a design wholly in the yield is cut once, on the neighbour.
    torn: cur ? [...worstTear].map(([toName, tearMm]) => ({ toName, tearMm })) : [],
    failed,
  });
  if (!cur || !exclusions.length) return done();
  for (const e of exclusions) {
    if (!cur) break;
    const b = featureBBox(cur);
    if (b[0] > e.bbox[2] || b[2] < e.bbox[0] || b[1] > e.bbox[3] || b[3] < e.bbox[1]) continue;
    if (!e.region) {
      failed = true;
      continue;
    }
    const hit = intersectChecked(cur, e.region);
    if (!hit.clipped) {
      failed = true;
      continue;
    }
    if (!hit.feat) continue;
    const cut = differenceChecked(cur, e.region);
    // The difference hands the subject back whole on a failure, so a move reported off `cut.feat`
    // alone would name a zone the ink never went to while it is still cut here as well.
    if (!cut.trimmed) {
      failed = true;
      continue;
    }
    cur = cut.feat;
    // The bake cuts a patch at the joining stretch's limits, so an entry is wholly one or the
    // other. `undefined` means "not surveyed", not "they join". The tear is required because the
    // warning quotes it and the bake writes both: a flag without the number is a truncated entry.
    if (e.joins === false && e.tearMm !== undefined)
      worstTear.set(e.toName, Math.max(e.tearMm, worstTear.get(e.toName) ?? 0));
    // A patch cut in two pieces is two entries naming one zone; the notice must not say it twice.
    if (!movedTo.includes(e.toName)) movedTo.push(e.toName);
  }
  return done();
}

/** [minX, minY, maxX, maxY] of a placed feature, for the cheap gate above. */
function featureBBox(f: PolyFeature): number[] {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const rings of polysOf(f))
    for (const ring of rings)
      for (const p of ring) {
        if (p[0] < b[0]) b[0] = p[0];
        if (p[1] < b[1]) b[1] = p[1];
        if (p[0] > b[2]) b[2] = p[0];
        if (p[1] > b[3]) b[3] = p[1];
      }
  return b;
}

/**
 * The regions one design actually cuts, placed: what the overlap check consults when bounding boxes
 * alone would warn on artwork that never touches. Post-merge, post-base slot features, which never
 * overlap within a design, so areas add. Clipped to kept half and net share, and put through the
 * speck floor, exactly as the cutter; not the per-part boundary clip (no part here).
 */
export function placedInk(
  featuresByColor: (PolyFeature | null)[][],
  ai: number,
  place: (pt: number[]) => number[],
  half: KeptHalf | null,
  netExcl: NetExclusion[] = [],
): InkPolygon[] {
  const out: InkPolygon[] = [];
  for (const kept of placedInkFeatures(featuresByColor, ai, place, half, netExcl)) {
    for (const rings of polysOf(kept))
      out.push(
        rings.map((r) => {
          // GeoJSON rings repeat their first point; drop it so the clipper's wrap-around edge
          // isn't a zero-length one.
          const closed =
            r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1];
          return (closed ? r.slice(0, -1) : r) as number[][];
        }),
      );
  }
  return out;
}

/** `placedInk` as features, one per palette slot: what a fill yields to beneath a sticker. */
export function placedInkFeatures(
  featuresByColor: (PolyFeature | null)[][],
  ai: number,
  place: (pt: number[]) => number[],
  half: KeptHalf | null,
  netExcl: NetExclusion[],
): PolyFeature[] {
  const out: PolyFeature[] = [];
  for (const perArtwork of featuresByColor) {
    const f = perArtwork[ai];
    if (!f) continue;
    const placed = mapFeatureCoords(f, place);
    const half0 = half ? clipToKeptSide(placed, half).feat : placed;
    const share = half0 && netExcl.length ? clipToNetShare(half0, netExcl).feat : half0;
    const kept = dropUnprintableRemnants(share, CLIP_REMNANT_FLOOR_MM2).feat;
    if (kept) out.push(kept);
  }
  return out;
}

/**
 * The design's content bbox placed, cut to the kept half where it keeps one: the ink gate bounds
 * reach into the shared box rather than intersecting ink, so two disjoint halves of one design
 * would still trip it on whole footprints. Still convex, a quad against a half-plane.
 */
export function placedBBoxQuad(
  parsed: ParsedSVG,
  place: (pt: number[]) => number[],
  half: KeptHalf | null,
): number[][] {
  const b = parsed.bbox;
  const quad = [
    [b.minX, b.minY],
    [b.maxX, b.minY],
    [b.maxX, b.maxY],
    [b.minX, b.maxY],
  ].map(place);
  if (!half) return quad;
  const ring = (half.clip.geometry.coordinates as number[][][])[0];
  return clipToConvex(quad, ring.slice(0, -1));
}
