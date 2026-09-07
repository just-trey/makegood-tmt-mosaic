import type { ConformalChart } from './conformal';
import type { ZoneMirror } from '../types';

/**
 * Runtime side of the design-zone sidecar (`public/stl/<kind>-zones.json`, baked by
 * scripts/bake-zones.mjs). It reconstructs the `ConformalChart` a zone's mapper needs from the
 * baked UV data plus the part's own loaded mesh — the sidecar stores per-part *vertex indices*
 * (into the packed 3MF's vertex order, which load3MF now returns), not 3D positions, so the chart
 * always resolves against the exact mesh the app loaded. A per-part fingerprint guards that pairing.
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
   * This part's own slice of the zone in UV, as outer/hole regions — what its cutter is clipped
   * to. Equal to the zone outline while a zone lives on one part; once a zone spans a printed
   * seam it is strictly smaller, and clipping to the zone outline instead would push artwork past
   * this part's chart, where the warp reports it off-chart and drops the color on both parts.
   * A part's slice can be several disjoint islands, hence a list.
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
   * The zone's display name, carried here for the same reason `NetZoneExclusion.toName` is: the
   * build names a zone the net places but nothing loaded, and with no loaded part there is no zone
   * list to resolve the id against.
   *
   * Optional because it arrived inside schema 5 rather than with it, so a cached sidecar can be
   * this schema and still lack it. Its one reader falls back to the id, which is what shipped
   * before — not worth a schema bump, which would refuse every cached sidecar to fix a name in a
   * warning that only fires when a part failed to load.
   */
  name?: string;
  rotationDeg: number;
  offsetU: number;
  offsetV: number;
  attached: boolean;
  /** How well the shared seam really registers, in mm; absent on the root and on detached sheets. */
  seamResidualMm?: { to: string; pairs: number; rms: number; p95: number; max: number };
  /**
   * How much of that seam is a join rather than an abutment, surveyed row by row along the
   * boundary the two sheets share.
   *
   * `seamResidualMm` says how well the fit landed on the vertices the two zones SHARE. It says
   * nothing about the rest of the boundary, where the sheets still sit flush on the canvas and the
   * surfaces under them are far apart: on the chair's flank/back boundary 61 of 197 rows join, and
   * a design crossing one of the other 136 is torn by 33.5mm at the median. `vFrom`/`vTo` bound
   * the joining stretch in net mm, and are absent when no row joins at all.
   *
   * Measured by scripts/lib/netseam.mjs, which scripts/check-net-design.mjs re-runs against the
   * shipped file.
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
 * A patch of this zone's own UV that another sheet of the net owns: a whole-part design is cut
 * there on `to` alone, and never here. The zone stays reachable through its own per-zone binding,
 * which does not consult this at all.
 *
 * `toName` is the owning zone's display name, carried rather than looked up because the notice
 * this feeds is user-facing and the geometry layer has no zone list to resolve an id against.
 */
export interface NetZoneExclusion {
  to: string;
  toName: string;
  areaMm2: number;
  /**
   * Whether the stretch of boundary this patch lies along is a real join. False says the two
   * sheets merely abut there, so a design reaching across this patch is cut in two halves that
   * print `tearMm` apart. The bake cuts a patch at the joining stretch's limits so each piece can
   * answer this at all (`markNetExclusionContinuity`, scripts/lib/zonebake.mjs).
   *
   * Optional for the same reason `NetZonePlacement.name` is: it arrived inside schema 5, and a
   * cached schema-5 sidecar lacking it reads as "not surveyed", which is silence — exactly what
   * shipped before. The regions themselves are unchanged in meaning, so no cut moves. A bump would
   * refuse every cached sidecar to add a warning.
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
 * The only sidecar format this build understands. The per-part mesh fingerprints guard the
 * *geometry* pairing; this guards the *format*, so a visitor holding a cached schema-1 sidecar
 * (whose charts carry `subBoundary` rather than `subRegions`, and whose zones have no `uvBounds`)
 * can't be paired with newer code that would read its per-part clip region as absent and clip every
 * part to the whole zone. Schema 3 adds `deadRegions`: a cached schema-2 sidecar read by this code
 * would silently report "nothing is hidden" on a kind whose bake says otherwise, the same class of
 * failure, so it takes the same hard refusal. Schema 4 adds `mirror`: a cached schema-3 sidecar
 * would silently offer no Mirror on a kind whose bake says otherwise, so same again. Schema 5 adds
 * `net`, and repeats it once more: a cached schema-4 sidecar would offer no whole-part zone at all.
 * Schema 6 adds `cutRegions`, the clip the cut uses, which the runtime used to derive by
 * subtracting `deadRegions` from `subRegions` on every load: a cached schema-5 sidecar read here
 * would fall through to `subRegions` alone and cut into surface the covers hide.
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
