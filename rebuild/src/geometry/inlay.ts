import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { mirroredPlacement, placedRegions, type PlacedDesign } from '../design/placement';
import { isEmpty, mpBounds, simplifyMp, unionAll, type Bounds, type MultiPolygon } from '../design/poly';
import { slotOfColor, type SlotPlan } from '../design/slots';
import type { SurfaceDef } from '../parts/catalog';
import { CsgError, fromManifold, toManifold } from './csg';
import { buildCutter } from './cutter';
import { frameFromNormal, localToWorld, toLocalMesh, type Frame } from './frame';
import { meshBounds, type Affine, type Mesh, type Vec3 } from './mesh';
import { HeightSampler } from './raycast';

export interface Warning {
  text: string;
  kind: 'error' | 'warning' | 'info';
}

export interface PieceMesh {
  id: string;
  name: string;
  mesh: Mesh;
  noDesign?: boolean;
}

export interface SurfaceInput {
  def: SurfaceDef;
  frame: Frame;
  /** Extent of the surface's pieces in local (u, v) mm. */
  bounds: Bounds;
}

export interface CutJob {
  wasm: ManifoldToplevel;
  pieces: PieceMesh[];
  surfaces: SurfaceInput[];
  designs: PlacedDesign[];
  plan: SlotPlan;
  defaultDepthMm: number;
}

export interface InlayMesh {
  slot: number;
  color: string;
  mesh: Mesh;
  volumeMm3: number;
}

export interface CutPiece {
  id: string;
  name: string;
  body: Mesh;
  inlays: InlayMesh[];
}

export interface CutResult {
  pieces: CutPiece[];
  warnings: Warning[];
  slotsUsed: Set<number>;
}

/** The shallowest recess that prints: one standard layer. */
export const MIN_DEPTH_MM = 0.2;
/** Wall left behind a recess so it never breaks through. Three layers. */
export const WALL_KEEP_MM = 0.6;

export function surfaceInput(def: SurfaceDef, pieces: PieceMesh[]): SurfaceInput {
  const members = pieces.filter((p) => def.pieces.includes(p.id));
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of members) {
    const b = meshBounds(p.mesh);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], b.min[k]);
      max[k] = Math.max(max[k], b.max[k]);
    }
  }
  if (members.length === 0) {
    min.fill(0);
    max.fill(0);
  }
  const origin: Vec3 = def.origin ?? [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const frame = frameFromNormal(origin, def.normal, def.up);
  const bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of members) {
    const b = meshBounds(toLocalMesh(frame, p.mesh));
    bounds.minX = Math.min(bounds.minX, b.min[0]);
    bounds.maxX = Math.max(bounds.maxX, b.max[0]);
    bounds.minY = Math.min(bounds.minY, b.min[1]);
    bounds.maxY = Math.max(bounds.maxY, b.max[1]);
  }
  if (members.length === 0) Object.assign(bounds, { minX: 0, minY: 0, maxX: 0, maxY: 0 });
  return { def, frame, bounds };
}

/** Designs that land on a surface: its own, plus mirrored copies from its twin or from itself. */
export function designsOnSurface(surface: SurfaceDef, all: PlacedDesign[]): PlacedDesign[] {
  const out: PlacedDesign[] = [];
  for (const d of all) {
    if (d.surfaceId === surface.id) {
      out.push(d);
      if (d.mirror && !surface.mirrorOf) out.push({ ...d, id: d.id + ':mirror', placement: mirroredPlacement(d.placement) });
    } else if (d.mirror && surface.mirrorOf === d.surfaceId) {
      out.push({ ...d, id: d.id + ':mirror', surfaceId: surface.id, placement: mirroredPlacement(d.placement) });
    }
  }
  return out;
}

function fmt(v: number): string {
  return (Math.round(v * 100) / 100).toString();
}

/** Row-major 3x4 affine to Manifold's column-major 4x4. */
function affineToMat4(a: Affine): [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number] {
  return [a[0], a[4], a[8], 0, a[1], a[5], a[9], 0, a[2], a[6], a[10], 0, a[3], a[7], a[11], 1];
}

export async function cutAll(job: CutJob, progress?: (msg: string, frac: number) => void | Promise<void>): Promise<CutResult> {
  const { wasm, plan } = job;
  const warnings: Warning[] = [];
  const bodies = new Map<string, Manifold>();
  const inlays = new Map<string, InlayMesh[]>();
  const slotsUsed = new Set<number>();
  const slotHadRegion = new Set<number>();
  const depthWarned = new Set<string>();
  const totalSteps = job.surfaces.reduce((n, s) => n + s.def.pieces.length, 0) * Math.max(1, plan.slots.length);
  let step = 0;

  for (const surface of job.surfaces) {
    const designs = designsOnSurface(surface.def, job.designs);
    if (designs.length === 0) continue;
    // Regions per slot, in surface-local mm.
    const perSlot = new Map<number, MultiPolygon[]>();
    for (const d of designs) {
      const placed = placedRegions(d, surface.bounds);
      for (const w of placed.warnings) warnings.push({ text: w, kind: 'warning' });
      for (const [color, mp] of placed.byColor) {
        const slot = slotOfColor(plan, color);
        if (!slot || slot.index === 1 || isEmpty(mp)) continue;
        (perSlot.get(slot.index) ?? perSlot.set(slot.index, []).get(slot.index)!).push(mp);
      }
    }
    const slotRegions = new Map<number, MultiPolygon>();
    for (const [index, mps] of perSlot) {
      slotHadRegion.add(index);
      try {
        // Nothing under 0.05 mm survives a 0.4 mm nozzle; dropping it keeps the cutter small.
        slotRegions.set(index, simplifyMp(unionAll(mps), 0.08));
      } catch {
        const color = plan.slots.find((s) => s.index === index)?.printColor ?? '';
        warnings.push({ text: `The ${color} shapes from different designs couldn't be combined on ${surface.def.name}. Move them apart or merge the designs in your editor.`, kind: 'warning' });
      }
    }
    if (slotRegions.size === 0) continue;

    for (const pieceId of surface.def.pieces) {
      const piece = job.pieces.find((p) => p.id === pieceId);
      if (!piece || piece.noDesign) continue;
      const local = toLocalMesh(surface.frame, piece.mesh);
      const localBounds = meshBounds(local);
      const sampler = new HeightSampler(local);
      let body: Manifold;
      const existing = bodies.get(piece.id);
      if (existing) body = existing;
      else {
        try {
          body = toManifold(wasm, piece.mesh);
        } catch {
          warnings.push({ text: `${piece.name} isn't a closed solid, so nothing can be cut into it. It exports as it is.`, kind: 'error' });
          continue;
        }
        bodies.set(piece.id, body);
      }
      for (const slot of plan.slots) {
        step++;
        const region = slotRegions.get(slot.index);
        if (!region) continue;
        const rb = mpBounds(region);
        if (!rb) continue;
        if (rb.maxX < localBounds.min[0] || rb.minX > localBounds.max[0] || rb.maxY < localBounds.min[1] || rb.minY > localBounds.max[1]) continue;
        await progress?.(`Cutting ${slot.printColor} into ${piece.name}`, step / totalSteps);

        let depth = slot.depthMm ?? job.defaultDepthMm;
        if (!(depth > 0)) {
          depth = MIN_DEPTH_MM;
          if (!depthWarned.has('min:' + slot.index)) {
            depthWarned.add('min:' + slot.index);
            warnings.push({ text: `A depth of 0 cuts nothing, so ${slot.printColor} is cut ${MIN_DEPTH_MM} mm deep, one layer.`, kind: 'info' });
          }
        }
        let cutter;
        try {
          cutter = buildCutter(wasm, region, sampler, depth, WALL_KEEP_MM);
        } catch {
          warnings.push({ text: `Couldn't shape the ${slot.printColor} recess for ${piece.name}, so it wasn't cut there. Simplify that color's shapes.`, kind: 'error' });
          continue;
        }
        if (cutter.cappedFraction > 0) {
          if (cutter.minDepthMm < MIN_DEPTH_MM && cutter.cappedFraction > 0.5) {
            warnings.push({ text: `Under ${slot.printColor} on ${piece.name} the wall is only ${fmt(cutter.minWallMm ?? 0)} mm thick, too thin to recess. That color wasn't cut there. Move the design onto thicker material.`, kind: 'warning' });
            cutter.manifold.delete();
            continue;
          }
          warnings.push({ text: `${slot.printColor} on ${piece.name} is cut shallower over ${cutter.cappedFraction < 0.01 ? 'a small part' : Math.round(cutter.cappedFraction * 100) + '%'} of its area: the wall there is as thin as ${fmt(cutter.minWallMm ?? 0)} mm, so the recess is ${fmt(cutter.minDepthMm)} mm deep there instead of ${fmt(depth)} mm.`, kind: 'warning' });
        }
        const cutterM: Manifold = cutter.manifold.transform(affineToMat4(localToWorld(surface.frame)));
        cutter.manifold.delete();
        if (String(cutterM.status()) !== 'NoError' && String(cutterM.status()) !== '0') {
          warnings.push({ text: `Couldn't shape the ${slot.printColor} recess for ${piece.name} (${String(cutterM.status())}), so it wasn't cut there.`, kind: 'error' });
          cutterM.delete();
          continue;
        }
        try {
          const inlay = body.intersect(cutterM);
          const vol = inlay.volume();
          if (vol < 0.05) {
            inlay.delete();
            cutterM.delete();
            continue;
          }
          const newBody: Manifold = wasm.Manifold.difference(body, cutterM);
          if (String(newBody.status()) !== 'NoError' && String(newBody.status()) !== '0') throw new CsgError(String(newBody.status()));
          body.delete();
          body = newBody;
          bodies.set(piece.id, body);
          (inlays.get(piece.id) ?? inlays.set(piece.id, []).get(piece.id)!).push({ slot: slot.index, color: slot.printColor, mesh: fromManifold(inlay), volumeMm3: vol });
          slotsUsed.add(slot.index);
          inlay.delete();
        } catch {
          warnings.push({ text: `Couldn't cut ${slot.printColor} into ${piece.name}, so that color was left out there. Try a slightly different depth or simplify the shape.`, kind: 'error' });
        } finally {
          cutterM.delete();
        }
        if (cutter.offPart > 0.02) {
          const key = 'off:' + surface.def.id + ':' + slot.index;
          if (!depthWarned.has(key)) {
            depthWarned.add(key);
            warnings.push({ text: `Part of the ${slot.printColor} design hangs off ${surface.def.name}. Only what sits on the part is cut.`, kind: 'info' });
          }
        }
      }
    }
  }

  for (const index of slotHadRegion)
    if (!slotsUsed.has(index)) {
      const slot = plan.slots.find((s) => s.index === index);
      if (slot) warnings.push({ text: `${slot.printColor} doesn't land on the part, so nothing was cut for it and it needs no filament slot. Move or scale the design if you meant it to print.`, kind: 'warning' });
    }

  const pieces: CutPiece[] = job.pieces.map((p) => {
    const m = bodies.get(p.id);
    const body = m ? fromManifold(m) : p.mesh;
    m?.delete();
    return { id: p.id, name: p.name, body, inlays: inlays.get(p.id) ?? [] };
  });
  return { pieces, warnings, slotsUsed };
}
