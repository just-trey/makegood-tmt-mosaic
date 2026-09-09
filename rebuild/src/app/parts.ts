import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import type { PlacedDesign } from '../design/placement';
import { placedRegions } from '../design/placement';
import { isEmpty, unionAll, type MultiPolygon } from '../design/poly';
import { buildSurfaceMap, type SurfaceMap } from '../export/template';
import { fromManifold, toManifold } from '../geometry/csg';
import { hubcapSolid } from '../geometry/hubcap';
import { surfaceInput, type PieceMesh, type SurfaceInput } from '../geometry/inlay';
import type { Mesh } from '../geometry/mesh';
import { read3mf } from '../geometry/threemf-read';
import { kindDef, piecesFor, WHEEL_DIAMETER_MM, type KindDef } from '../parts/catalog';

const meshCache = new Map<string, Promise<Mesh>>();

export function partUrl(file: string): string {
  return `${import.meta.env.BASE_URL}parts/${file}`.replace(/\/\/+/g, '/');
}

export function loadMesh(file: string): Promise<Mesh> {
  let p = meshCache.get(file);
  if (!p) {
    p = fetch(partUrl(file))
      .then((r) => {
        if (!r.ok) throw new Error(`Couldn't load part file ${file} (${r.status}).`);
        return r.arrayBuffer();
      })
      .then((buf) => read3mf(buf))
      .then((parts) => {
        if (parts.length === 0) throw new Error(`Part file ${file} has no model in it.`);
        return parts[0].mesh;
      });
    meshCache.set(file, p);
  }
  return p;
}

export interface HubcapRequest {
  diameterMm: number;
  /** Outline in the hubcap's surface-local mm when cutting to the design's shape. */
  outline?: MultiPolygon;
}

/** The smallest disc the four clips fit under, and the most the wheel allows. */
export const HUBCAP_MIN_MM = 40;
export const HUBCAP_MAX_MM = WHEEL_DIAMETER_MM;

export function hubcapLimits(bedMm: number): { min: number; max: number } {
  return { min: HUBCAP_MIN_MM, max: Math.min(HUBCAP_MAX_MM, bedMm - 12) };
}

let clipsManifold: Promise<Manifold> | null = null;

export async function buildHubcap(wasm: ManifoldToplevel, req: HubcapRequest): Promise<{ mesh: Mesh; warnings: string[] }> {
  const warnings: string[] = [];
  if (!clipsManifold) clipsManifold = loadMesh('hubcap-clips.3mf').then((m) => toManifold(wasm, m));
  const clips = await clipsManifold;
  let shape: Parameters<typeof hubcapSolid>[1];
  if (req.outline && !isEmpty(req.outline)) shape = { kind: 'silhouette', outline: req.outline };
  else shape = { kind: 'circle', diameterMm: req.diameterMm };
  const solid = hubcapSolid(wasm, shape);
  const joined = wasm.Manifold.union(solid, clips);
  solid.delete();
  const mesh = fromManifold(joined);
  joined.delete();
  return { mesh, warnings };
}

/** The outline a hubcap takes from a design: every color's region, joined, in surface-local mm. Scaled down if it would reach past the wheel. */
export function silhouetteOutline(design: PlacedDesign): { outline: MultiPolygon; scaledBy: number } | null {
  const placed = placedRegions({ ...design, mode: 'sticker' }, { minX: -200, minY: -200, maxX: 200, maxY: 200 });
  const all = [...placed.byColor.values()];
  if (all.length === 0) return null;
  let outline: MultiPolygon;
  try {
    outline = unionAll(all);
  } catch {
    return null;
  }
  if (isEmpty(outline)) return null;
  let reach = 0;
  for (const poly of outline) for (const p of poly[0]) reach = Math.max(reach, Math.hypot(p[0], p[1]));
  const limit = WHEEL_DIAMETER_MM / 2;
  if (reach <= limit) return { outline, scaledBy: 1 };
  const k = limit / reach;
  return { outline: outline.map((poly) => poly.map((ring) => ring.map(([x, y]) => [x * k, y * k] as [number, number]))), scaledBy: k };
}

export interface LoadedKind {
  def: KindDef;
  pieces: PieceMesh[];
  surfaces: SurfaceInput[];
}

export async function loadKind(kind: KindDef['kind'], variant: string, hubcap?: { wasm: ManifoldToplevel; req: HubcapRequest }): Promise<LoadedKind> {
  const def = kindDef(kind);
  const defs = piecesFor(def, variant);
  const pieces: PieceMesh[] = [];
  if (kind === 'hubcap' && hubcap) {
    const built = await buildHubcap(hubcap.wasm, hubcap.req);
    pieces.push({ id: 'hubcap', name: 'Hubcap', mesh: built.mesh });
  } else {
    const meshes = await Promise.all(defs.map((p) => loadMesh(p.file)));
    defs.forEach((p, i) => pieces.push({ id: p.id, name: p.name, mesh: meshes[i], noDesign: p.noDesign }));
  }
  const surfaces = def.surfaces.map((s) => surfaceInput(s, pieces));
  return { def, pieces, surfaces };
}

const mapCache = new Map<string, SurfaceMap>();

export function surfaceMap(loaded: LoadedKind, surfaceId: string, cell = 1.5): SurfaceMap | null {
  const s = loaded.surfaces.find((x) => x.def.id === surfaceId);
  if (!s) return null;
  const key = `${loaded.def.kind}:${surfaceId}:${loaded.pieces.map((p) => p.mesh.pos.length).join(',')}:${cell}`;
  let m = mapCache.get(key);
  if (!m) {
    m = buildSurfaceMap(s, loaded.pieces, cell);
    mapCache.set(key, m);
  }
  return m;
}
