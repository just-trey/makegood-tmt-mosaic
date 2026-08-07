import { HUBCAP_PLATE } from '../export/threemf';
import { outlineBounds, type Outline } from './hubcapOutline';
import { shapeToFeature } from './regions';
import {
  extrudeRegionToSoup,
  getManifold,
  manifoldIsValid,
  manifoldToMeshes,
  soupToManifold,
} from './manifold';

/**
 * The hubcap is the app's first *generated* part: only its four mounting clips ship as a baked
 * asset (public/stl/hubcap-clips.3mf), and the disc they carry is built here at whatever diameter
 * the user asked for.
 *
 * Every constant below was measured off the reference mesh the part was modelled from
 * (an untracked stubs/hubcap.stl, 5 bodies: 4 clips + 1 disc), and tests/hubcap.test.ts
 * regenerates the disc at DEFAULT_DIAMETER and checks it back against those measurements. That
 * test is the reason these are numbers rather than guesses — see its header.
 */

/**
 * The clips' top face, and so the disc's underside: the two are *exactly* coincident in the
 * reference (both at y = 24.2550), not merely close. They are separate bodies that touch
 * face-to-face, which is why the union below is a real boolean rather than a soup concat.
 */
export const HUBCAP_BASE_Y = 24.255;

/** Disc thickness, and the 45° chamfer on its top outer edge — both measured, both exact. */
export const HUBCAP_THICKNESS_MM = 3;
export const HUBCAP_CHAMFER_MM = 1;

/** Design face height — the chamfer's top, where artwork is cut. */
export const HUBCAP_FACE_Y = HUBCAP_BASE_Y + HUBCAP_THICKNESS_MM;

/**
 * The diameter of the disc a human actually modelled, to full precision.
 *
 * This is a *measurement*, not a setting: tests/hubcap.test.ts regenerates at this diameter and
 * checks the result back against the reference mesh's own rings and bbox, so rounding it would
 * make that test pass against a disc 0.75mm wider than the part it claims to reproduce.
 */
export const HUBCAP_REFERENCE_DIAMETER_MM = 220.752;

/**
 * The diameter the app loads with — a round 220mm, deliberately *not*
 * HUBCAP_REFERENCE_DIAMETER_MM.
 *
 * The two were one constant until it turned out to be answering two different questions: what the
 * reference part measures, and what a user should be handed on load. A volunteer reading "220.75"
 * has no way to know whether that digit matters, and the part is no more correct at the reference
 * size than at any other — the clips are what mate with the wheel, and they don't move.
 */
export const HUBCAP_DEFAULT_DIAMETER_MM = 220;

/**
 * The diameter the plate arrangements in HUBCAP_PLATE were verified at, and so the largest disc
 * they may be applied to.
 *
 * Equal to the default today, and that is a coincidence worth not collapsing: the default is what
 * a user is handed, this is what a human checked on a plate. If someone re-verifies at a different
 * size, this moves and the default needn't.
 */
export const HUBCAP_VERIFIED_DIAMETER_MM = 220;

/**
 * The verified plate arrangement for this bed, or undefined if none applies.
 *
 * Two conditions, and both are about not claiming more than was checked:
 *
 * - **The bed must have its own entry.** The positions are absolute and bed-specific; there is no
 *   sensible way to carry them to a plate nobody verified (the H2D today).
 * - **The disc must not be larger than the verified one.** Smaller is safe by construction — the
 *   part and the tower both stay put, so a smaller disc only opens the gap between them, and its
 *   own plate margins only grow. Larger is not, and on a 256mm bed the verified clearance is just
 *   7mm, so "a bit larger" is enough to eat it.
 *
 * Falling through returns undefined, and the caller drops to the computed centring plus
 * suggestTowerPos, which warns. That is the honest outcome: nothing was verified for that case.
 */
export function hubcapPlacement(
  diameterMm: number,
  bedKey: string,
):
  | {
      fixedPosByPlate: Record<string, { x: number; y: number }>;
      primeTowerDeltaByPlate: Record<string, { x: number; y: number }>;
      projectSettings: Record<string, string>;
    }
  | undefined {
  const plate = HUBCAP_PLATE[bedKey];
  if (!plate || diameterMm > HUBCAP_VERIFIED_DIAMETER_MM) return undefined;
  return {
    fixedPosByPlate: { [bedKey]: plate.pos },
    // held relative to the part, the frame primeTowerDelta is defined in
    primeTowerDeltaByPlate: {
      [bedKey]: { x: plate.tower.x - plate.pos.x, y: plate.tower.y - plate.pos.y },
    },
    projectSettings: { prime_tower_width: plate.towerWidthMm },
  };
}

/**
 * Radial extent of the clips' *top faces* — the only surface the disc can bond to, since the two
 * bodies meet on one plane and share no volume. Measured at 10.634..16.046mm.
 *
 * Note this is not the clips' overall reach (their corners get to ~19.5mm): a clip is a shaped
 * body, and what matters here is the annulus it presents at y = HUBCAP_BASE_Y. Using the bigger
 * number would reject disc sizes that bond perfectly well.
 */
export const HUBCAP_CLIP_FACE_INNER_R_MM = 10.634;
export const HUBCAP_CLIP_FACE_OUTER_R_MM = 16.046;

/**
 * Smallest disc that fully covers the clip tops, and so the floor the diameter control clamps to.
 *
 * Below 2x the *inner* radius (21.3mm) the disc misses the clips entirely and the part exports as
 * five loose bodies — verified, and the reason `HubcapBody.components` exists. Between the two the
 * disc catches only a sliver of each clip, which fuses but bonds on almost nothing. Clamping to
 * full coverage rather than to bare contact is the difference between a part that prints and one
 * that technically slices.
 */
export const HUBCAP_MIN_DIAMETER_MM = 2 * HUBCAP_CLIP_FACE_OUTER_R_MM;

/**
 * Raised when the disc missed the clips. Deliberately carries no numbers: it is retracted and
 * re-raised on every regeneration (see AssemblyPart.buildWarning), which needs a stable string to
 * match on — and the diameter that caused it is already on screen in the control beside it.
 */
export const HUBCAP_DISCONNECTED_WARNING =
  'The hubcap disc is too small to reach its mounting clips — they would print as four loose ' +
  'pieces. Increase the diameter.';

/**
 * Max chord deviation when a circle is tessellated. 0.03mm is well inside one 0.2mm layer and a
 * fraction of a 0.4mm nozzle, so the facets cannot survive slicing. At the default diameter it
 * yields 135 segments, against the 133 the reference CAD chose — the two agree on area and volume
 * far more tightly than this tolerance, which is why the test compares geometry and not topology.
 */
const CHORD_TOL_MM = 0.03;

/** Segment count for a circle of this radius, from CHORD_TOL_MM. Floored at 3. */
export function hubcapSegments(radiusMm: number): number {
  if (!(radiusMm > 0)) return 3;
  const ratio = 1 - Math.min(1, CHORD_TOL_MM / radiusMm);
  return Math.max(3, Math.ceil(Math.PI / Math.acos(ratio)));
}

/** A closed CCW-in-(x, z) circle of `n` points. */
function circleRing(radius: number, n: number): { x: number; z: number }[] {
  const ring: { x: number; z: number }[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    ring.push({ x: radius * Math.cos(t), z: radius * Math.sin(t) });
  }
  return ring;
}

/**
 * The disc alone, as a triangle soup in the part's native frame (Y up, centred on the axis).
 *
 * Four bands, which is exactly how the reference is built: a flat underside, a straight outer
 * wall for `thickness - chamfer`, the 45° chamfer, then the design face inset by the chamfer.
 * Winding is outward everywhere — the caps fan in opposite directions and the two wall bands are
 * wound so their normals point radially out. Getting any of those backwards makes Manifold read
 * the solid as its own complement, so tests/hubcap.test.ts checks the signed volume.
 */
export function hubcapDiscSoup(diameterMm: number): Float32Array {
  const rOuter = diameterMm / 2;
  const rInner = rOuter - HUBCAP_CHAMFER_MM;
  const n = hubcapSegments(rOuter);
  const yBase = HUBCAP_BASE_Y;
  const yMid = HUBCAP_FACE_Y - HUBCAP_CHAMFER_MM;
  const yTop = HUBCAP_FACE_Y;

  const lo = circleRing(rOuter, n);
  const mid = circleRing(rOuter, n);
  const hi = circleRing(rInner, n);

  // caps fan to n-2 triangles each, the two wall bands to 2n each
  const out = new Float32Array((2 * (n - 2) + 4 * n) * 9);
  let o = 0;
  const push = (
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
  ): void => {
    out[o++] = ax;
    out[o++] = ay;
    out[o++] = az;
    out[o++] = bx;
    out[o++] = by;
    out[o++] = bz;
    out[o++] = cx;
    out[o++] = cy;
    out[o++] = cz;
  };

  for (let i = 1; i < n - 1; i++) {
    // underside, normal -Y: fanning the (x, z) ring in its own order faces down
    push(lo[0].x, yBase, lo[0].z, lo[i].x, yBase, lo[i].z, lo[i + 1].x, yBase, lo[i + 1].z);
    // design face, normal +Y: the same fan reversed
    push(hi[0].x, yTop, hi[0].z, hi[i + 1].x, yTop, hi[i + 1].z, hi[i].x, yTop, hi[i].z);
  }

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    // straight outer wall
    push(lo[i].x, yBase, lo[i].z, mid[i].x, yMid, mid[i].z, mid[j].x, yMid, mid[j].z);
    push(lo[i].x, yBase, lo[i].z, mid[j].x, yMid, mid[j].z, lo[j].x, yBase, lo[j].z);
    // chamfer
    push(mid[i].x, yMid, mid[i].z, hi[i].x, yTop, hi[i].z, hi[j].x, yTop, hi[j].z);
    push(mid[i].x, yMid, mid[i].z, hi[j].x, yTop, hi[j].z, mid[j].x, yMid, mid[j].z);
  }
  return out;
}

/** Signed volume of a closed triangle soup — negative means the winding is inside-out. */
export function soupVolume(soup: Float32Array): number {
  let v = 0;
  for (let i = 0; i < soup.length; i += 9) {
    const ax = soup[i],
      ay = soup[i + 1],
      az = soup[i + 2];
    const bx = soup[i + 3],
      by = soup[i + 4],
      bz = soup[i + 5];
    const cx = soup[i + 6],
      cy = soup[i + 7],
      cz = soup[i + 8];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

/**
 * The kind's 1:1 design template, built for the diameter currently set.
 *
 * Every other part's template is a file baked by scripts/gen-templates.mjs, which guarantees the
 * template and the app agree by extracting the outline from the shipped mesh. A generated part has
 * no shipped mesh to extract from, and a static file would be true-to-size at exactly one diameter
 * and quietly wrong at every other — the worst failure mode for a template someone prints and
 * draws on. Agreement is instead guaranteed by construction: this and hubcapDiscSoup read the same
 * constants, so the drawing and the part cannot disagree.
 *
 * Ink and sizing match the baked templates (scripts/lib/svgstyle.mjs) so the set still reads as one.
 */
export function hubcapTemplateSvg(diameterMm: number): string {
  const GRAY = '#bcbcbc';
  const ACCENT = '#1a4f8f';
  const LABEL_SIZE = 8;
  // The design face is the disc less the chamfer all round — the flat surface artwork lands on,
  // and so the true size of the drawing area. Templating the full diameter would put a ring of
  // artwork onto the 45 degree bevel, where it gets cut away.
  const faceD = round2(diameterMm - 2 * HUBCAP_CHAMFER_MM);
  const c = round2(faceD / 2);
  return `<svg xmlns="http://www.w3.org/2000/svg"
     width="${faceD}mm" height="${faceD}mm" viewBox="0 0 ${faceD} ${faceD}">
  <!-- GENERATED by src/geometry/hubcap.ts for a ${round2(diameterMm)}mm hubcap. The gray disc is
       the flat design face at 1:1 mm: the part is ${round2(diameterMm)}mm across, less a
       ${HUBCAP_CHAMFER_MM}mm chamfer all round. Re-download this after changing the diameter. -->
  <circle cx="${c}" cy="${c}" r="${c}" fill="${GRAY}"/>
  <text x="${c}" y="${round2(c + LABEL_SIZE / 3)}" text-anchor="middle" font-family="sans-serif"
        font-size="${LABEL_SIZE}" fill="${ACCENT}">${round2(diameterMm)}mm hubcap</text>
</svg>
`;
}

const round2 = (v: number): number => Number(v.toFixed(2));

export interface HubcapBody {
  /** Triangle soup, the frame every other part arrives in (see asmLoadPartBuffer). */
  positions: Float32Array;
  /** Welded vertices, so 3MF export doesn't have to re-derive them from the soup. */
  vertices: Float32Array;
  /** Connected solids in the result. Anything but 1 means the disc missed the clips. */
  components: number;
}

/**
 * Disc ∪ clips, as one solid.
 *
 * The union is a genuine boolean and not a soup concat because the two bodies meet on exactly
 * coincident faces (see HUBCAP_BASE_Y): concatenating would leave a pair of opposed coplanar
 * skins buried inside the part, which slices as a seam and reads to Manifold as two solids rather
 * than one. `components` is reported rather than asserted so the caller can say something useful —
 * an outline that doesn't reach the clips is a user error, not a bug.
 */
/**
 * What the disc is cut to: a plain circle, or the silhouette of the artwork on it.
 *
 * The two build differently on purpose. A circle reproduces the reference part, chamfered edge
 * and all. A silhouette is cut FLAT — square edges — which makes it a plain prism on the outline,
 * so it goes through `extrudeRegionToSoup` rather than through a second chamfer builder that
 * would have to loft between an outline and an erosion of it.
 */
export type HubcapShape =
  { kind: 'circle'; diameterMm: number } | { kind: 'silhouette'; outline: Outline };

/** The disc alone, in the part's native frame, for either kind of shape. */
function hubcapDiscFor(shape: HubcapShape): Float32Array {
  if (shape.kind === 'circle') return hubcapDiscSoup(shape.diameterMm);
  const feature = shapeToFeature({
    fill: '',
    order: 0,
    // artwork/outline space is (x, z) here; the extruder speaks turf features keyed (x, y)
    loops: shape.outline.map((r) => r.map((p) => ({ x: p.x, y: p.z }))),
  });
  const soup = feature
    ? extrudeRegionToSoup(feature, HUBCAP_FACE_Y, HUBCAP_THICKNESS_MM, 0, 1)
    : null;
  if (!soup) throw new Error('the silhouette enclosed no area to cut the hubcap from');
  return soup;
}

export async function buildHubcapBody(
  shape: HubcapShape,
  clipsSoup: Float32Array,
): Promise<HubcapBody> {
  const wasm = await getManifold();
  const disc = soupToManifold(wasm, hubcapDiscFor(shape));
  const clips = soupToManifold(wasm, clipsSoup);
  try {
    if (!manifoldIsValid(disc)) throw new Error('generated hubcap disc is not a closed solid');
    if (!manifoldIsValid(clips)) throw new Error('hubcap clips mesh is not a closed solid');
    const body = wasm.Manifold.union(disc, clips);
    try {
      if (!manifoldIsValid(body)) throw new Error('hubcap disc ∪ clips produced no solid');
      const parts = body.decompose();
      const components = parts.length;
      parts.forEach((p) => p.delete());
      const { soup, indexed } = manifoldToMeshes(body);
      return { positions: soup, vertices: indexed.positions, components };
    } finally {
      body.delete();
    }
  } finally {
    disc.delete();
    clips.delete();
  }
}

/**
 * How big a silhouette may be before it stops fitting the wheel it mounts on.
 *
 * The wheel is round and 280mm across, so what has to fit inside that circle is the outline's
 * furthest CORNER, not its longest side — a square at 280mm on a side reaches r=198 and would
 * overhang the rim by 58mm. So the cap is derived per shape: scale the longest side up until the
 * furthest point sits on the rim, and no further.
 */
export const HUBCAP_WHEEL_DIAMETER_MM = 280;

export function maxSizeForWheel(outline: Outline): number {
  const [x0, z0, x1, z1] = outlineBounds(outline);
  const longest = Math.max(x1 - x0, z1 - z0);
  if (!(longest > 0)) return HUBCAP_WHEEL_DIAMETER_MM;
  // furthest point from the axis once the outline is centred on its own bounds
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  let far = 0;
  for (const r of outline)
    for (const p of r) {
      const d = Math.hypot(p.x - cx, p.z - cz);
      if (d > far) far = d;
    }
  if (!(far > 0)) return HUBCAP_WHEEL_DIAMETER_MM;
  // at longest = L the outline reaches `far`; it may reach at most the wheel's radius
  return (longest * (HUBCAP_WHEEL_DIAMETER_MM / 2)) / far;
}

/**
 * Narrower than this and a feature is one nozzle-width of plastic standing the disc's full 3mm.
 * A printability threshold, not a geometric one — 1mm is comfortably over a 0.4mm nozzle while
 * still catching the hair-thin strokes a traced cartoon leaves behind.
 */
export const HUBCAP_MIN_FEATURE_MM = 1;

/**
 * How much of the clips' bonding face a silhouette has to cover.
 *
 * Generous on purpose. The failure worth refusing is a clip over a hole or off the shape, which
 * loses most of the face; a shape that nicks the rim loses a percent or two and still bonds
 * across the rest. An earlier version demanded every sample on the outer radius and refused a
 * real silhouette over one sample in sixty-four.
 */
export const HUBCAP_MIN_CLIP_COVERAGE = 0.9;

/** Silhouette asked for with nothing loaded to take one from. */
export const HUBCAP_SILHOUETTE_NO_ARTWORK =
  'The hubcap is set to follow your artwork’s shape, but no artwork is loaded — it stays round ' +
  'until you add one.';

/**
 * The refusal. Carries no numbers so it can be retracted and re-raised on every rebuild (see
 * AssemblyPart.buildWarning), and the size that caused it is in the control beside it.
 */
export const HUBCAP_SILHOUETTE_MISSES_CLIPS =
  'That shape doesn’t cover the hubcap’s mounting clips, so it stays round — make it bigger, or ' +
  'use artwork whose middle is filled in.';

export const HUBCAP_SILHOUETTE_THIN_DETAIL =
  'Some of this shape is thinner than 1mm, which is about one nozzle wide — those parts will be ' +
  'fragile. Simplifying the artwork or making the hubcap bigger will thicken them.';
