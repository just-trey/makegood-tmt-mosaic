import * as THREE from 'three';
import { state } from '../state/store';
import { currentBaseParams } from '../state/store';
import { currentAssemblyKind } from '../assembly/kinds';
import { primaryZoneMapper, zoneMappersFor } from '../geometry/zoneMappers';
import { designAnchor, designMmPerUnit, memoLargestDesignFace } from '../geometry/assembly';
import { generatedDesignFaceOverride } from '../assembly/kinds';
import type { ZoneFrame, ZoneMapper } from '../geometry/zones';
import { activeArtworkInstance } from '../state/artwork';
import type { AssemblyPart } from '../types';
import { modelToWorldDir, modelToWorldPoint, modelWorldMatrix } from './viewport';

/**
 * Everything the on-face design gizmo needs to translate between the viewport and the placement
 * parameters (offsetX/offsetY/scalePct/rotationDeg). It describes the design's current pose on the
 * face in *world* space, plus the in-plane axes those two offsets move along.
 *
 * The axes are deliberately read off the SAME conventions the geometry build uses so a drag maps
 * 1:1 to what the recut produces. Everything here is in WORLD space: the mappers work in the
 * part's native frame, so both the origin and the axes are pushed through the model group's
 * transform (the grid lift, plus the display rotation for a kind that authors a display frame).
 */
export interface FaceFrame {
  /** world position of the design center (where the SVG anchor lands) */
  origin: THREE.Vector3;
  /** unit world vector the +offsetX slider moves the design along */
  uAxis: THREE.Vector3;
  /** unit world vector the +offsetY slider moves the design along */
  vAxis: THREE.Vector3;
  /** unit plane normal (for raycasting the face) */
  normal: THREE.Vector3;
  /** half the design's on-face width along u, in mm, at the current scale (pre-rotation) */
  halfW: number;
  /** half the design's on-face height along v, in mm, at the current scale (pre-rotation) */
  halfH: number;
  /**
   * World position of an on-face point (du, dv) mm from the design center, ON the surface — the
   * curved counterpart of `origin + du·uAxis + dv·vAxis`. The gizmo traces its outline through this
   * so the frame follows the part instead of floating off it: a tangent-plane rectangle leaves the
   * chair's flank by 16mm at 100mm across and 110mm at 300mm, which reads as the frame hanging in
   * space beside the part. Flat kinds return exactly the plane formula.
   */
  pointAt(du: number, dv: number): THREE.Vector3;
  /**
   * How far the design center sits outside the surface it is being cut onto, in mm (0 = on it).
   * A conformal zone covers only part of its UV rectangle — the chair's flanks fill 38% of theirs —
   * and a query in the empty part silently snaps to the nearest triangle, up to 136mm away on an
   * unrelated piece of surface. The gizmo shows that rather than drawing a confident frame there.
   */
  offSurfaceMM: number;
  /**
   * `offSurfaceMM` for a design center moved (du, dv) mm from where this frame put it — what the
   * off-surface warning has to ask mid-drag, since the frame itself is captured at pointerdown and
   * keeps reporting where the design *started*. `giveUpMM` caps the search; beyond it the answer is
   * only guaranteed to exceed the cap, which is all a "still on the surface?" test needs, and it
   * keeps the miss from walking the whole chart grid on every pointer-move.
   */
  offSurfaceAt(du: number, dv: number, giveUpMM: number): number;
  offsetX: number;
  offsetY: number;
  scalePct: number;
  rotationDeg: number;
}

/**
 * Build the face frame from current state, or null when there is nothing to manipulate (no
 * artwork, or an assembly with no loaded primary part). Recomputed on every gizmo refresh so it
 * tracks state edits, part changes, and the post-rebuild grid offset.
 */
export function computeFaceFrame(): FaceFrame | null {
  if (!state.parsed) return null;
  return state.shapeKind === 'assembly' ? assemblyFrame() : flatFrame();
}

function flatFrame(): FaceFrame | null {
  const bp = currentBaseParams();
  if (!bp) return null;
  const bbox = state.parsed!.bbox;
  const svgW = bbox.maxX - bbox.minX,
    svgH = bbox.maxY - bbox.minY;
  if (!(svgW > 0) || !(svgH > 0)) return null;
  const footW = state.shapeKind === 'disc' ? bp.diameter || 0 : bp.width || 0;
  const footH = state.shapeKind === 'disc' ? bp.diameter || 0 : bp.height || 0;
  // mirror fitTransform's auto-fit: margin shrinks the usable footprint on both sides
  const mW = footW * (1 - bp.marginPct / 50),
    mH = footH * (1 - bp.marginPct / 50);
  const autoScale = Math.min(mW / svgW, mH / svgH);
  const scale = autoScale * (state.scalePct / 100);
  // Captured, not read live inside pointAt below. The gizmo passes displacements measured from the
  // center of the frame it is holding, so a closure that re-read state.offsetX during a move drag
  // would add the delta a second time and send the outline off at twice the cursor. The assembly
  // path captures its center for the same reason.
  const ox = state.offsetX,
    oy = state.offsetY;
  // Flat mode never poses the model group, so this is the grid lift alone today — routed through
  // the same helpers as the assembly path so it stays right if that ever changes.
  return {
    origin: modelToWorldPoint(new THREE.Vector3(ox, oy, bp.thickness)),
    uAxis: modelToWorldDir(new THREE.Vector3(1, 0, 0)),
    vAxis: modelToWorldDir(new THREE.Vector3(0, 1, 0)),
    normal: modelToWorldDir(new THREE.Vector3(0, 0, 1)),
    halfW: (svgW * scale) / 2,
    halfH: (svgH * scale) / 2,
    // A flat plate IS its own tangent plane, so tracing the outline reduces to the plane formula —
    // kept in the same shape as the assembly path rather than special-cased in the gizmo.
    pointAt: (du, dv) => modelToWorldPoint(new THREE.Vector3(ox + du, oy + dv, bp.thickness)),
    offSurfaceMM: 0,
    offSurfaceAt: () => 0,
    offsetX: ox,
    offsetY: oy,
    scalePct: state.scalePct,
    rotationDeg: state.rotationDeg,
  };
}

/**
 * Every mapper that cuts the *active* artwork — one per printed part the bound zone covers.
 *
 * The zone the active instance is bound to is the only correct answer; falling back to the part's
 * first zone (as this used to) leaves the gizmo on an unrelated surface. But a zone routinely spans
 * several printed parts — the chair's `left` covers four — and each part carries only its own slice
 * of the shared UV space. Picking one part's chart and asking it about a point that lies on a
 * *different* part's slice gets the nearest-triangle answer instead, tens of millimetres away, which
 * is what put the frame beside the artwork rather than around it. So the caller gets all of them and
 * resolves each query against whichever slice actually holds it.
 *
 * Unbound artwork, and any kind with no zone sidecar, still resolve to the single primary mapper.
 */
function gizmoMappers(parts: AssemblyPart[], isRect: boolean): ZoneMapper[] {
  const zoneId = activeArtworkInstance()?.zone?.zoneId;
  if (zoneId) {
    const bound = parts
      .filter((p) => p.loaded && !p.isDuplicateOf && p.zones?.some((z) => z.id === zoneId))
      .flatMap((p) => zoneMappersFor(p, parts, isRect, null).filter((m) => m.zoneId === zoneId));
    if (bound.length) return bound;
  }
  // A part of a zoned kind only counts once its zones have resolved and at least one takes
  // artwork — a structural piece (no baked zone) has nothing for the gizmo to sit on.
  const primary = parts.find(
    (p) =>
      p.loaded && !p.isDuplicateOf && p.boundaryLoop && p.positions && (!p.zones || p.zones.length),
  );
  const mapper = primary ? primaryZoneMapper(primary, parts, isRect) : null;
  return mapper ? [mapper] : [];
}

/**
 * Search budget for an outline sample, which only has to answer "does this chart hold the point".
 * Cost is dominated by this: a miss walks grid rings until the budget runs out, once per part of
 * the zone, dozens of times per redraw. Measured on the chair's `left` zone, 64 samples across its
 * four parts cost 2.7ms at 3mm against 22ms at 25mm — and a sample no chart holds is better served
 * by the tangent plane than by a nearest-surface answer from 100mm away.
 */
const SAMPLE_GIVE_UP_MM = 3;

/**
 * The frame from whichever of `mappers` actually holds (u, v) — the least-snapped answer wins.
 *
 * `from` is the index that answered last, tried first and updated in place. The outline is traced
 * as a run of neighbouring points, so the previous winner almost always holds the next one, and a
 * hit on the chart resolves in the first grid ring.
 */
function bestFrameAt(
  mappers: ZoneMapper[],
  u: number,
  v: number,
  from: { i: number },
  giveUpMM?: number,
): ZoneFrame {
  // Fix the rotation base before the loop: reading `from.i` inside it, while the body also writes
  // it, walks a moving sequence that can skip a mapper entirely — including the one holding the
  // point, which left the frame snapped onto a neighbouring part and flagged off-surface.
  const start = from.i;
  let best = mappers[start].frameAt(u, v, giveUpMM);
  if (best.offChartMM === 0) return best;
  for (let k = 1; k < mappers.length; k++) {
    const i = (start + k) % mappers.length;
    const f = mappers[i].frameAt(u, v, giveUpMM);
    if (f.offChartMM < best.offChartMM) {
      best = f;
      from.i = i;
      if (best.offChartMM === 0) break;
    }
  }
  return best;
}

function assemblyFrame(): FaceFrame | null {
  const parts = state.assembly.parts;
  const isRect = currentAssemblyKind()?.designFit === 'rect';
  // The same mappers the build uses — their frameAt() carries the face direction, face-plane Y or
  // UV chart, and (for rect) the face-center anchor, so the gizmo and the cut can't drift apart.
  const mappers = gizmoMappers(parts, isRect);
  if (!mappers.length || !mappers[0].faceNormal) return null;

  const bbox = state.parsed!.bbox;
  const svgW = bbox.maxX - bbox.minX,
    svgH = bbox.maxY - bbox.minY;
  if (!(svgW > 0) || !(svgH > 0)) return null;
  const contentCx = (bbox.minX + bbox.maxX) / 2,
    contentCy = (bbox.minY + bbox.maxY) / 2;
  // Anchor and scale come from the build's own resolvers, not restated here. Both used to be
  // re-derived, and the scale copy assumed 1 unit = 1 mm whenever the file declared no absolute
  // size — which is every artwork the app ships, since editors export `width="100%"`. The build
  // meanwhile auto-fits the viewBox to the design face, so the frame came out several times the
  // size of the cut and (through the displacement below, which is scaled by the same number)
  // nowhere near it. Pass no `notice`: this runs on every gizmo refresh.
  const scaleMult = state.scalePct / 100;
  const anchor = designAnchor(state.parsed!, isRect);
  const mmPerUnit = designMmPerUnit(state.parsed!, scaleMult, anchor.r, {
    isRect,
    radius: state.asmRadius || 138,
    designFace: () => generatedDesignFaceOverride() ?? memoLargestDesignFace(parts)(),
  });

  // The cut is anchored on the *document*, so it lands wherever the drawn content sits relative to
  // that anchor — off-center on the face for a design drawn off-center on its sheet. The frame has
  // to pick up the same displacement or it stops enclosing the artwork it is meant to select, and
  // the move hit-test grabs empty face. Measure it through the mapper's own placer, as the placed
  // content center minus the placed anchor, so the flips, mirror correction, scale and rotation
  // all come from the code the build uses rather than being restated here. The offsets cancel in
  // the difference, hence 0/0. Exactly zero whenever the anchor already is the content center —
  // every design that fills its sheet, and every circle-less wheel design.
  //
  // Any of the zone's mappers answers this identically: a conformal chart's placer works in the
  // zone-wide UV space the bake measured across every part, which is the whole reason a design
  // spanning a printed seam lands as one design rather than one copy per part.
  const place = mappers[0].placer({
    svgC: anchor,
    mmPerUnit,
    xFlip: state.flipX ? -1 : 1,
    zMul: state.flipY ? 1 : -1,
    offX: 0,
    offZ: 0,
    rotationDeg: state.rotationDeg,
  });
  const placedContent = place([contentCx, contentCy]);
  const placedAnchor = place([anchor.cx, anchor.cy]);

  // frameAt returns the design center and axes in the part's NATIVE space; the model group is both
  // lifted onto the grid and (for a kind with a display frame) rotated, so the whole frame has to
  // come through that transform — the origin as a point, the axes as directions.
  const centerU = state.offsetX + placedContent[0] - placedAnchor[0];
  const centerV = state.offsetY + placedContent[1] - placedAnchor[1];
  // Seeded at the design center and carried through the outline samples that follow it.
  const from = { i: 0 };
  // The design center is worth an uncapped search: when it does fall off every chart, the snapped
  // point is what the frame is drawn around, so it has to be a real place on the part.
  const frame = bestFrameAt(mappers, centerU, centerV, from);
  const origin = modelToWorldPoint(frame.origin);
  const uAxis = modelToWorldDir(frame.uAxis);
  const vAxis = modelToWorldDir(frame.vAxis);
  // Taken once for the whole outline: see modelWorldMatrix on why per-point is expensive.
  const toWorld = modelWorldMatrix().clone();
  return {
    origin,
    uAxis,
    vAxis,
    normal: modelToWorldDir(frame.normal),
    halfW: (svgW * mmPerUnit) / 2,
    halfH: (svgH * mmPerUnit) / 2,
    // Each outline sample is its own surface query, in the same (u, v) space the cut is placed in,
    // so the traced frame bends exactly the way the artwork does — and, resolved per sample across
    // the zone's parts, runs continuously over a printed seam instead of breaking at it. Where no
    // part's chart holds the sample the frame has run off the design surface, and the tangent plane
    // is the honest answer: the nearest scrap of surface can be 100mm away on unrelated geometry,
    // which would kink the outline across the model rather than let it leave the part.
    pointAt: (du, dv) => {
      const f = bestFrameAt(mappers, centerU + du, centerV + dv, from, SAMPLE_GIVE_UP_MM);
      return f.offChartMM === 0
        ? f.origin.applyMatrix4(toWorld)
        : origin.clone().addScaledVector(uAxis, du).addScaledVector(vAxis, dv);
    },
    offSurfaceMM: frame.offChartMM,
    offSurfaceAt: (du, dv, giveUpMM) =>
      bestFrameAt(mappers, centerU + du, centerV + dv, from, giveUpMM).offChartMM,
    offsetX: state.offsetX,
    offsetY: state.offsetY,
    scalePct: state.scalePct,
    rotationDeg: state.rotationDeg,
  };
}
