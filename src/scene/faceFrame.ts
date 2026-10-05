import * as THREE from 'three';
import { state } from '../state/store';
import { currentAssemblyKind, currentDesignScaleContext } from '../assembly/kinds';
import { primaryZoneMapper, zoneMappersFor } from '../geometry/zoneMappers';
import { designAnchor, designMmPerUnit } from '../geometry/designScale';
import { netGizmoMapper, WHOLE_CHAIR_ZONE } from '../geometry/zones';
import type { GizmoMapper, ZoneFrame, ZoneMapper } from '../geometry/zones';
import { activeArtworkInstance, netZones } from '../state/artwork';
import type { AssemblyPart } from '../types';
import { modelToWorldDir, modelToWorldPoint, modelWorldMatrix } from './viewport';

/**
 * The design's pose on the face in WORLD space, with axes from the build's own conventions so a
 * drag maps 1:1 to the recut. Mappers work in the native frame, so everything goes through the
 * model group's transform (grid lift, plus any display rotation).
 */
export interface FaceFrame {
  /** world position of the design center (where the SVG anchor lands) */
  origin: THREE.Vector3;
  /** world vector a drag reads the +offsetX change against: see ZoneFrame.uAxis */
  uAxis: THREE.Vector3;
  /** the same for +offsetY */
  vAxis: THREE.Vector3;
  /** unit plane normal (for raycasting the face) */
  normal: THREE.Vector3;
  /** half the design's on-face width along u, in mm, at the current scale (pre-rotation) */
  halfW: number;
  /** half the design's on-face height along v, in mm, at the current scale (pre-rotation) */
  halfH: number;
  /**
   * World point (du, dv) mm from the center ON the surface: the curved `origin + du·uAxis +
   * dv·vAxis`. A tangent rectangle leaves the chair's flank by 16mm at 100mm across and 110mm at
   * 300mm. A flat face returns exactly the plane formula.
   */
  pointAt(du: number, dv: number): THREE.Vector3;
  /**
   * mm the design center sits off its surface (0 = on it). The chair's flanks fill 38% of their UV
   * rectangle, and a query in the rest snaps silently up to 136mm away onto unrelated surface.
   */
  offSurfaceMM: number;
  /**
   * `offSurfaceMM` for a center moved (du, dv), for mid-drag (this frame is from pointerdown).
   * Past `giveUpMM` the answer only exceeds the cap — enough, and a miss skips walking the grid.
   */
  offSurfaceAt(du: number, dv: number, giveUpMM: number): number;
  offsetX: number;
  offsetY: number;
  scalePct: number;
  rotationDeg: number;
}

/** The face frame from current state, or null with nothing to manipulate. Recomputed per refresh. */
export function computeFaceFrame(): FaceFrame | null {
  if (!state.parsed) return null;
  return assemblyFrame();
}

/**
 * Every mapper cutting the *active* artwork's bound zone (a part's first zone puts the gizmo on an
 * unrelated surface). A zone spans parts (the chair's `left` covers four), each holding one slice
 * of the UV space; one part's chart snaps others' points tens of mm away, so all are returned.
 * Unbound artwork and sidecar-less kinds get the single primary mapper.
 */
function gizmoMappers(parts: AssemblyPart[], isRect: boolean): GizmoMapper[] {
  const zoneId = activeArtworkInstance()?.zone?.zoneId;
  const zoneMappers = (id: string): ZoneMapper[] =>
    parts
      .filter((p) => p.loaded && !p.isDuplicateOf && p.zones?.some((z) => z.id === id))
      .flatMap((p) => zoneMappersFor(p, parts, isRect, null).filter((m) => m.zoneId === id));
  // A whole-part binding is in net mm: every zone's mappers, wrapped in their sheet's transform.
  if (zoneId === WHOLE_CHAIR_ZONE) {
    const net = netZones();
    const bound = (net?.zones ?? []).flatMap((z) =>
      zoneMappers(z.zoneId).map((m) => netGizmoMapper(m, z.place, net!.netCentre, z.zoneCentre)),
    );
    if (bound.length) return bound;
  } else if (zoneId) {
    const bound = zoneMappers(zoneId);
    if (bound.length) return bound;
  }
  // A zoned part counts once its zones resolve to at least one; a structural piece has none.
  const primary = parts.find(
    (p) =>
      p.loaded &&
      !p.isDuplicateOf &&
      p.boundaryLoops &&
      p.positions &&
      (!p.zones || p.zones.length),
  );
  const mapper = primary ? primaryZoneMapper(primary, parts, isRect) : null;
  return mapper ? [mapper] : [];
}

/**
 * Outline-sample search budget: a miss walks grid rings to it, per part, per sample. On the chair's
 * `left` zone, 64 samples over four parts: 2.7ms at 3mm vs 22ms at 25mm. An unheld sample is
 * better on the tangent plane than snapped 100mm away.
 */
const SAMPLE_GIVE_UP_MM = 3;

/**
 * The least-snapped frame across `mappers`. `from`, the last winner, is tried first and updated:
 * neighbouring outline points almost always share a chart.
 */
function bestFrameAt(
  mappers: GizmoMapper[],
  u: number,
  v: number,
  from: { i: number },
  giveUpMM?: number,
): ZoneFrame {
  // Fixed first: reading `from.i` while writing it could skip the mapper holding the point.
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
  // The build's own mappers, so the gizmo and the cut can't drift apart.
  const mappers = gizmoMappers(parts, isRect);
  if (!mappers.length || !mappers[0].faceNormal) return null;

  const bbox = state.parsed!.bbox;
  const svgW = bbox.maxX - bbox.minX,
    svgH = bbox.maxY - bbox.minY;
  if (!(svgW > 0) || !(svgH > 0)) return null;
  const contentCx = (bbox.minX + bbox.maxX) / 2,
    contentCy = (bbox.minY + bbox.maxY) / 2;
  // The build's resolvers, not a copy: a restated scale assumed 1 unit = 1 mm for `width="100%"`
  // files while the build auto-fits, drawing the frame several times too big and off the cut.
  // No `notice`: this runs on every gizmo refresh.
  const scaleMult = state.scalePct / 100;
  const anchor = designAnchor(state.parsed!, isRect);
  const mmPerUnit = designMmPerUnit(
    state.parsed!,
    scaleMult,
    anchor.r,
    currentDesignScaleContext(),
  );

  // The cut anchors on the *document*, so off-center content lands off-center; the frame needs the
  // same displacement or it misses the artwork. Measured via the build's placer (content minus
  // anchor; offsets cancel, hence 0/0). Zero when the anchor is the content center. Any of the
  // zone's mappers agrees: charts share the zone-wide UV space, so a seam-spanning design is one.
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

  // frameAt is NATIVE space: the origin goes through the model transform as a point, axes as
  // directions.
  const centerU = state.offsetX + placedContent[0] - placedAnchor[0];
  const centerV = state.offsetY + placedContent[1] - placedAnchor[1];
  // Seeded at the design center and carried through the outline samples that follow it.
  const from = { i: 0 };
  // Uncapped: off every chart, the snapped center is what the frame is drawn around.
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
    // Per-sample queries in the cut's (u, v) space bend like the artwork and cross printed seams.
    // Off every chart, the tangent plane: the nearest surface can be 100mm away, unrelated.
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
