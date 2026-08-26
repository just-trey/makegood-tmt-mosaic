import type { ConformalChart } from './conformal';

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
}

/**
 * The only sidecar format this build understands. The per-part mesh fingerprints guard the
 * *geometry* pairing; this guards the *format*, so a visitor holding a cached schema-1 sidecar
 * (whose charts carry `subBoundary` rather than `subRegions`, and whose zones have no `uvBounds`)
 * can't be paired with newer code that would read its per-part clip region as absent and clip every
 * part to the whole zone.
 */
export const SIDECAR_SCHEMA = 2;

export interface ZoneSidecar {
  schema: number;
  kindId: string;
  /** per referenced part: the mesh it was baked against, to refuse a mismatched re-pack */
  meshes: Record<string, { triangleCount: number; bboxHash: string }>;
  zones: SidecarZone[];
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
    zoneBounds: zone.uvBounds,
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
