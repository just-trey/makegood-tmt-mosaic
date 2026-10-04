import type { ConformalChart } from './conformal';
import type { ZoneMirror } from '../types';

/**
 * Runtime side of the design-zone sidecar (`public/stl/<kind>-zones.json`, baked by
 * scripts/bake-zones.mjs): rebuilds a zone's `ConformalChart` from baked UV plus the part's loaded
 * mesh. The sidecar stores per-part *vertex indices* (packed 3MF order, as load3MF returns), not
 * positions, so a chart resolves against the exact mesh loaded; a per-part fingerprint guards that.
 */

/** One printed part's slice of a zone's chart (indices are part-local, into the packed mesh order). */
export interface SidecarChart {
  libraryPartId: string;
  /** triangle indices into the part's packed mesh order (for per-part cutting later) */
  tris: number[];
  /** the part's packed vertex indices this chart uses, parallel to `uv`/`chartTris` numbering */
  verts: number[];
  /** interleaved u,v in true mm, shared zone UV space */
  uv: number[];
  /** chart-local index triples (into `verts`/`uv`) */
  chartTris: number[][];
  /**
   * This part's own slice of the zone in UV (possibly several islands): its cutter's clip. On a
   * seam-spanning zone it is strictly smaller than the outline, and clipping to the outline would
   * push artwork past this part's chart, where the warp drops the color on both parts.
   */
  subRegions: { outer: number[][]; holes: number[][][] }[];
  /** `subRegions` less `deadRegions`, baked and cleaned — what the cut clips to. */
  cutRegions?: { outer: number[][]; holes: number[][][] }[];
  /**
   * Surface of this chart another part hides once assembled (wheels, cushions), already shrunk by
   * the config's bleed so artwork still runs past the visible edge. Subtracted from the artwork
   * clip and shown shaded. Absent on kinds baked without a covers file: absent and empty both
   * mean "nothing is hidden".
   */
  deadRegions?: { outer: number[][]; holes: number[][][] }[];
}

export interface SidecarZone {
  id: string;
  name: string;
  templateFile: string;
  charts: SidecarChart[];
  /** zone outer boundary ring in UV mm */
  boundary: number[][];
  holes: number[][][];
  /** UV polylines where printed parts meet, for UI display */
  seams: number[][][];
  /**
   * The whole zone's UV bbox (min is (0,0) by bake convention) — the template's coordinate space,
   * and what the mapper anchors placement and fill tiling on. Measured across every chart, so a
   * zone spanning a seam places one design across the parts rather than one per part.
   */
  uvBounds: { minU: number; minV: number; maxU: number; maxV: number };
  up: number[];
  normalSign: 1 | -1;
  distortion: { max: number; mean: number };
  /**
   * The zone's mirror relation plus how well the twin's chart (or this zone's other half) really
   * is the reflection of this one: per paired vertex, the twin's UV against this zone's UV
   * reflected about its `uvBounds` centre, in mm. Baked by scripts/lib/zonebake.mjs, never typed
   * by hand; absent when the config declares no `mirrorAxis` or the zone pairs with nothing.
   */
  mirror?: ZoneMirror & { residualMm: { pairs: number; rms: number; p95: number; max: number } };
}

/**
 * Where one zone's sheet sits on the kind's net, as a rotation and translation taking that zone's
 * own UV mm to net mm (never a scale: a resized sheet would print the design at the wrong size).
 * `attached` says the placement is the measured registration across a shared seam, so a design
 * carries across the join; false says the sheet was merely laid beside its neighbour.
 */
export interface NetZonePlacement {
  /**
   * The zone's display name, carried like `NetZoneExclusion.toName`: the build names a zone the net
   * places but nothing loaded, with no zone list to resolve against. Optional because it arrived
   * inside schema 5; its one reader falls back to the id, and a bump would refuse every cached
   * sidecar for a warning that only fires when a part failed to load.
   */
  name?: string;
  rotationDeg: number;
  offsetU: number;
  offsetV: number;
  attached: boolean;
  /** How well the shared seam really registers, in mm; absent on the root and on detached sheets. */
  seamResidualMm?: { to: string; pairs: number; rms: number; p95: number; max: number };
  /**
   * How much of that seam is a join rather than an abutment, surveyed row by row. `seamResidualMm`
   * covers only the SHARED vertices; elsewhere the sheets sit flush on the canvas over surfaces far
   * apart: on the chair's flank/back boundary 61 of 197 rows join, and a design crossing one of the
   * other 136 is torn by 33.5mm at the median. `vFrom`/`vTo` bound the joining stretch in net mm,
   * absent when no row joins. Measured by scripts/lib/netseam.mjs; scripts/check-net-design.mjs
   * re-runs it against the shipped file.
   */
  seamContinuity?: {
    rows: number;
    met: number;
    vFrom?: number;
    vTo?: number;
    jumpMm: { median: number; p95: number; max: number };
  };
  /**
   * Canvas this zone yields, so a point of the net belongs to exactly one zone. Absent where it
   * yields none, which is every zone whose sheet lies over no other.
   */
  excluded?: NetZoneExclusion[];
}

/**
 * A patch of this zone's UV another sheet of the net owns: a whole-part design is cut there on `to`
 * alone; the zone's own per-zone binding ignores it. `toName` is carried because the notice is
 * user-facing and the geometry layer has no zone list to resolve an id against.
 */
export interface NetZoneExclusion {
  to: string;
  toName: string;
  areaMm2: number;
  /**
   * Whether this patch's stretch of boundary is a real join. False: the sheets merely abut, so a
   * design across the patch prints in two halves `tearMm` apart. The bake cuts patches at the
   * joining stretch's limits so each can answer (`markNetExclusionContinuity`,
   * scripts/lib/zonebake.mjs). Optional like `NetZonePlacement.name`: a cached schema-5 sidecar
   * lacking it reads as "not surveyed" (silence); regions are unchanged, so no cut moves.
   */
  joins?: boolean;
  /**
   * Median 3D distance between where the two sheets put the same point, over the surveyed rows
   * this patch spans. Only on a patch with `joins: false`; there is nothing to tear where they
   * meet.
   */
  tearMm?: number;
  regions: { outer: number[][]; holes: number[][][] }[];
}

/**
 * The whole kind unfolded onto one canvas: every zone at its net transform, plus the canvas extent
 * a design bound to the whole part is placed against. Absent on a kind with fewer than two zones.
 */
export interface ZoneNet {
  templateFile: string;
  bounds: { minU: number; minV: number; maxU: number; maxV: number };
  zones: Record<string, NetZonePlacement>;
}

/**
 * The only sidecar format this build reads (mesh fingerprints guard the geometry; this the format).
 * Each bump hard-refuses a cached older sidecar that would otherwise fail silently: schema 1 has
 * `subBoundary`, no `uvBounds` (every part clips to the whole zone); 3 adds `deadRegions` (else
 * "nothing is hidden"); 4 `mirror` (else no Mirror); 5 `net` (else no whole-part zone); 6
 * `cutRegions` (else falls through to `subRegions` and cuts into surface the covers hide).
 */
export const SIDECAR_SCHEMA = 6;

export interface ZoneSidecar {
  schema: number;
  kindId: string;
  /** per referenced part: the mesh it was baked against, to refuse a mismatched re-pack */
  meshes: Record<string, { triangleCount: number; bboxHash: string }>;
  zones: SidecarZone[];
  net?: ZoneNet;
}

/**
 * FNV-1a over "<triCount>|<minx,miny,minz,maxx,maxy,maxz>" (bbox to 3 decimals) — byte-identical to
 * scripts/lib/zonebake.mjs `meshFingerprint`, so a part's loaded mesh can be matched to the mesh
 * the sidecar was baked against. tests/chair-zones.test.ts pins the two together.
 */
export function meshFingerprint(
  vertices: Float32Array,
  triCount: number,
): { triangleCount: number; bboxHash: string } {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i += 3)
    for (let k = 0; k < 3; k++) {
      if (vertices[i + k] < mn[k]) mn[k] = vertices[i + k];
      if (vertices[i + k] > mx[k]) mx[k] = vertices[i + k];
    }
  const sig = `${triCount}|${[...mn, ...mx].map((v) => v.toFixed(3)).join(',')}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < sig.length; i++) {
    h ^= sig.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return { triangleCount: triCount, bboxHash: h.toString(16).padStart(8, '0') };
}

/**
 * True when the part's loaded mesh matches the mesh the sidecar baked its charts against. A false
 * here means the packed part was re-exported/re-packed without re-baking zones, so the baked UV
 * indices no longer address the same vertices — the caller must skip that part's zones rather than
 * cut against stale coordinates.
 */
export function fingerprintMatches(
  sidecar: ZoneSidecar,
  libraryPartId: string,
  vertices: Float32Array,
  triCount: number,
): boolean {
  const want = sidecar.meshes[libraryPartId];
  if (!want) return false;
  const got = meshFingerprint(vertices, triCount);
  return got.triangleCount === want.triangleCount && got.bboxHash === want.bboxHash;
}

/**
 * Rebuild the `ConformalChart` one part contributes to a zone, resolving the baked vertex indices
 * against the part's loaded vertex list (load3MF's `vertices`, packed-file order). The returned
 * chart is exactly what `ConformalZoneMapper` consumes.
 */
export function reconstructChart(
  zone: SidecarZone,
  chart: SidecarChart,
  partVertices: Float32Array,
  netExcluded?: NetZoneExclusion[],
): ConformalChart {
  const positions3 = new Float32Array(chart.verts.length * 3);
  for (let i = 0; i < chart.verts.length; i++) {
    const vi = chart.verts[i];
    if ((vi + 1) * 3 > partVertices.length)
      throw new Error(
        `zone "${zone.id}" chart references vertex ${vi} of part ${chart.libraryPartId}, ` +
          `which has only ${partVertices.length / 3} vertices. The sidecar is stale for this mesh`,
      );
    positions3[i * 3] = partVertices[vi * 3];
    positions3[i * 3 + 1] = partVertices[vi * 3 + 1];
    positions3[i * 3 + 2] = partVertices[vi * 3 + 2];
  }
  return {
    positions3,
    uv: Float32Array.from(chart.uv),
    triangles: Uint32Array.from(chart.chartTris.flat()),
    normalSign: zone.normalSign,
    boundary: zone.boundary,
    holes: zone.holes,
    subRegions: chart.subRegions,
    cutRegions: chart.cutRegions,
    deadRegions: chart.deadRegions,
    zoneBounds: zone.uvBounds,
    netExcluded,
  };
}

const sidecarCache = new Map<string, Promise<ZoneSidecar>>();

/**
 * Fetch + cache a kind's zone sidecar from public/stl/. Version-tagged like the parts manifest so a
 * returning visitor's cached sidecar can't lag a bundle that expects newer zones. Rejects (rather
 * than resolving empty) so the caller can fall back to the flat path with a warning.
 */
export function loadZonesSidecar(zonesFile: string): Promise<ZoneSidecar> {
  const cached = sidecarCache.get(zonesFile);
  if (cached) return cached;
  const v = typeof __APP_VERSION__ === 'undefined' ? 'dev' : __APP_VERSION__;
  const p = fetch(`stl/${zonesFile}?v=${v}`).then(async (res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const sidecar = (await res.json()) as ZoneSidecar;
    if (sidecar.schema !== SIDECAR_SCHEMA)
      throw new Error(`zone sidecar schema ${sidecar.schema}, expected ${SIDECAR_SCHEMA}`);
    return sidecar;
  });
  sidecarCache.set(zonesFile, p);
  // don't cache a rejection — let a later call retry the fetch
  p.catch(() => sidecarCache.delete(zonesFile));
  return p;
}
