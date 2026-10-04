import * as THREE from 'three';
import type { Position } from 'geojson';
import {
  MIN_CUT_DEPTH_MM,
  addPartTooDeepClamp,
  addZeroDepthRaise,
  depthDiffers,
  CLIP_REMNANT_FLOOR_MM2,
  edgeCutThroughNotice,
  regionLabel,
  requestedDepth,
  subLayerDepth,
  thinDepthNotice,
  thinWallWarning,
  tooDeepWarning,
  zeroDepthWarning,
  type PartDepthClamp,
  type ZeroDepthRaise,
} from './depth';
import type {
  AssemblyBuild,
  AssemblyPaletteEntry,
  AssemblyPart,
  AssemblyPartOutput,
  ColorSettings,
  DetectedColor,
  IndexedMesh,
  ParsedSVG,
  PolyFeature,
} from '../types';
import {
  applyColorMerges,
  computeNetRegionsByColor,
  intersectQuiet,
  dropUnprintableRemnants,
  planarArea,
  cleanFeature,
  differenceAllChecked,
  differenceChecked,
  intersectChecked,
  safeIntersectChecked,
  fitsBesideClips,
  roomBesideClips,
  safeUnion,
  UnionTooBig,
  YIELD_BUDGET_MS,
  yieldToBrowser,
} from './regions';
import {
  getManifold,
  manifoldDelete,
  manifoldIsValid,
  manifoldToMeshes,
  mapFeatureCoords,
  REPAIR_ERODE_MM,
  repairSelfIntersections,
  soupToManifold,
  type ManifoldSolid,
} from './manifold';
import {
  faceXZBBox,
  oppositeSide,
  OVERSHOOT_MM,
  type CutRegion,
  type DesignPlacement,
  type KeepSide,
  type NetExclusion,
  type ZoneMapper,
} from './zones';
import { zoneMappersFor } from './zoneMappers';
import { FILL_REFINE_MM } from './conformal';
import {
  featureVertexCount,
  MAX_FILL_TILES,
  tileCoverage,
  tileFeature,
  type TileCell,
  type TileGrid,
  type TileRefusal,
  type TileRefusalReport,
} from './patterns';
import {
  clipToConvex,
  overlappingDesignPairs,
  type InkPolygon,
  type PlacedDesign,
} from './designOverlap';
import { generatedDesignFaceOverride, generatedFitFactor } from '../assembly/kinds';
import {
  dismissNotice,
  dropBuildWarningsSince,
  noticeBuild,
  warnBuild,
  warningMark,
} from '../warnings';
import { csgFault, resetCsgFaults } from './csgFault';
import { reportProgress } from '../progress';
import { throwIfCancelled } from '../cancel';

// The zone layer owns these now; re-exported so importers keep their '../geometry/assembly' paths.
export { asmPartFaceNormal, faceXZBBox, rotatePointY, OVERSHOOT_MM } from './zones';

/**
 * Visual counterpart to rotatePointY, which remaps which design slice lands where but never moves
 * geometry: a duplicate part needs a real 3D transform to render clear of its source.
 * Three.js's rotation.y sign convention is opposite rotatePointY's, hence the negation.
 */
export function asmPartTransformGroup(part: AssemblyPart): {
  outer: THREE.Group;
  add(mesh: THREE.Object3D): void;
} {
  if (!part.isDuplicateOf) {
    const outer = new THREE.Group();
    return {
      outer,
      add(mesh) {
        outer.add(mesh);
      },
    };
  }
  const outer = new THREE.Group();
  outer.position.set(part.pivotX, 0, part.pivotZ);
  outer.rotation.y = (-part.angleDeg * Math.PI) / 180;
  const inner = new THREE.Group();
  inner.position.set(-part.pivotX, 0, -part.pivotZ);
  outer.add(inner);
  return {
    outer,
    add(mesh) {
      inner.add(mesh);
    },
  };
}

/** A feature's polygons, whichever of the two geometry types it carries. */
function polysOf(f: PolyFeature): Position[][][] {
  return f.geometry.type === 'MultiPolygon'
    ? (f.geometry.coordinates as Position[][][])
    : [f.geometry.coordinates as Position[][]];
}

/**
 * Two designs' regions for one color in one feature, WITHOUT a union: feeds color detection and
 * merge grouping, where only total area matters. Each artwork sits near its own SVG origin until
 * placement, so a real union would fold unrelated coordinates and undercount every shared color.
 */
function concatFeatures(a: PolyFeature, b: PolyFeature): PolyFeature {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'MultiPolygon', coordinates: [...polysOf(a), ...polysOf(b)] },
  } as PolyFeature;
}

/** One placed design: an SVG, where it goes, and which surface it goes on. */
export interface ArtworkBuildInput {
  parsed: ParsedSVG;
  /** Only used to name designs in warnings; a caller that doesn't track names cuts identically. */
  name?: string;
  /** `DesignZone.id` to cut onto. `null` means every zone the part offers (the single-zone case). */
  zoneId?: string | null;
  scaleMult: number;
  /**
   * The largest `scaleMult` the Scale control allows, so a fill refused for detail can tell "raise
   * Scale" from "raising Scale will not reach". Defaults to `scaleMult` (no headroom).
   */
  maxScaleMult?: number;
  offX: number;
  offZ: number;
  /** user horizontal mirror (fixes artwork that reads back-to-front on the face) */
  flipX: boolean;
  /** user vertical mirror, on top of the built-in SVG y-down correction */
  flipY: boolean;
  /** design rotation about its center on the face, in degrees (0 = as authored) */
  rotationDeg: number;
  /**
   * 'sticker' (default) places one copy; 'fill' repeats it across the whole zone, one period per
   * SVG viewBox, clipped to the zone boundary.
   */
  mode?: 'sticker' | 'fill';
  /**
   * Set when this design keeps one half of a self-mirrored zone, its reflection the other. The half
   * kept is the one the placed centre lies on; this value settles only a design centred exactly on
   * the line, where a mirrored pair would otherwise both keep the same half.
   */
  keepSide?: KeepSide;
  /** Set on the reflection mirroredBuildInput makes, so a notice about the pair is said once. */
  reflected?: boolean;
  /** Shared by a mirrored design and its reflection; the overlap check never compares the two. */
  mirrorPair?: string;
  /**
   * Set on every placement `netToZoneBuildInput` makes, so the cut is clipped to the canvas this
   * zone owns on the whole-part sheet rather than to everything its own chart reaches. Off for a
   * design bound to this zone by name, which is the whole reason the partition costs no surface.
   */
  netBound?: boolean;
}

export interface AssemblyBuildInput {
  /**
   * Every design being cut, in paint order. Colors pool across all of them (one hex in two
   * artworks is one AMS slot at one depth); placement stays per artwork.
   */
  artworks: ArtworkBuildInput[];
  parts: AssemblyPart[];
  mergeGroups: string[][];
  colorSettings: ColorSettings;
  globalDepth: number;
  /** design radius in mm: the SVG boundary circle maps to this (ignored when designFit==='rect') */
  radius: number;
  /** how artwork maps onto the face; 'rect' scales the SVG 1:1 in mm and centers on the face */
  designFit?: 'wheel' | 'rect';
  autoMergeLevel?: number;
  baseColorKey?: string | null;
  /** every raw hex the base assignment excludes from cutting (see state/store.ts addToBase) */
  baseColorMembers?: string[];
  keptApart?: string[];
}

/**
 * Anchor for a `designFit: 'rect'` design: the document canvas centre (viewBox or declared mm box),
 * never the drawn content's. Templates span the surface 1:1 (`zoneTemplateSVG`,
 * `gen-templates.mjs`), so a shape in a sheet corner wants that corner of the surface. Null when no
 * canvas is declared.
 */
export function canvasAnchor(
  parsed: Pick<ParsedSVG, 'canvas'>,
): { cx: number; cy: number; r: number } | null {
  const c = parsed.canvas;
  if (!c || !(c.w > 0) || !(c.h > 0)) return null;
  return { cx: c.w / 2, cy: c.h / 2, r: Math.max(c.w, c.h) / 2 };
}

/**
 * Whether a `<circle>` is a template's boundary marker (the circle the drawing sits inside) or part
 * of the drawing. Taking the largest circle blindly scaled one of four r=18 corner dots to the full
 * 276mm face and threw the rest clear, silently (docs/findings/2026-08-16-maker-ease-review.md).
 *
 * Compared as bounding boxes: no circle contains its own bbox corners, so a strict test rejects
 * public/templates/wheel-cover-circle.svg (r=140, bbox corners 198 units out). Not by fill: that
 * template's boundary is a filled disc and its only unfilled circle is the centre-cap ring, which a
 * fill filter picks, blowing every template-drawn design up 7.6x.
 */
function enclosesArtwork(
  circle: { cx: number; cy: number; r: number },
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
): boolean {
  // Slack for artwork drawn up to or a hair over the rim; relative to r so it is scale-free.
  const slack = circle.r * 0.02;
  return (
    circle.cx - circle.r - slack <= bbox.minX &&
    circle.cy - circle.r - slack <= bbox.minY &&
    circle.cx + circle.r + slack >= bbox.maxX &&
    circle.cy + circle.r + slack >= bbox.maxY
  );
}

/**
 * A rejected circle that still looks meant as the boundary: it holds some of the drawing, and what
 * escaped is small enough to be a stray. Without this, one stray mark silently drops a template to
 * the bbox fit, a fraction of the intended size and off-centre. Judged by the escapers' size, not a
 * shape-count share: template plus one stray is one in, one out, which no majority rule catches.
 */
function looksLikeAnEscapedBoundary(
  circle: { cx: number; cy: number; r: number },
  parsed: ParsedSVG,
): boolean {
  const dist = (p: { x: number; y: number }) => Math.hypot(p.x - circle.cx, p.y - circle.cy);
  // Excluded, or a decorative filled circle qualifies on its own body.
  const isTheCircle = (sh: (typeof parsed.shapes)[number]) =>
    sh.loops.every((l) => l.every((p) => Math.abs(dist(p) - circle.r) <= circle.r * 0.02));
  const others = parsed.shapes.filter((sh) => !isTheCircle(sh));
  const held = others.filter((sh) =>
    sh.loops.every((l) => l.every((p) => dist(p) <= circle.r * 1.02)),
  );
  if (!held.length || held.length === others.length) return false;
  const escaped = others.filter((sh) => !held.includes(sh));
  // A fifth of the diameter: bigger than any speck, smaller than a drawing placed outside.
  const strayLimit = circle.r * 0.4;
  return escaped.every((sh) => {
    const pts = sh.loops.flat();
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return (
      Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) <= strayLimit
    );
  });
}

/**
 * Design anchor per artwork: the SVG's <circle> when it encloses the drawing, else a pseudo-circle
 * on the artwork bbox; rect parts anchor on the canvas (canvasAnchor). Only a circle that held most
 * of the drawing and lost some gets a notice; the other branches behave and stay silent.
 * Shared with the gizmo (src/scene/faceFrame.ts), which passes no `notice`: it re-resolves on every
 * refresh and would refill the warnings panel from a mouse-move.
 */
export function designAnchor(
  parsed: ParsedSVG,
  isRect: boolean,
  notice?: (msg: string) => void,
): { cx: number; cy: number; r: number } {
  const circle = isRect ? null : parsed.rawSVGCircle;
  if (circle && enclosesArtwork(circle, parsed.bbox)) return circle;
  // `notice &&` first: the scan walks every vertex, and the sinkless gizmo calls this on every
  // refresh and pointerdown.
  if (notice && circle && looksLikeAnEscapedBoundary(circle, parsed))
    notice(
      'This SVG has a circle around most of the artwork, but some of it falls outside. The ' +
        'design was fitted by its overall size instead, so it may print smaller than the ' +
        'template intends. Remove any stray marks outside the circle.',
    );
  // A raster anchors on its frame on every kind, wheel included, and says nothing: an image cannot
  // contain a boundary circle, so the notice below would ask every image for the impossible.
  const isRaster = parsed.origin === 'raster';
  if (isRect || isRaster) {
    const canvas = canvasAnchor(parsed);
    if (canvas) return canvas;
  }
  // No notice: centring on the bbox is what a file not drawn over a template wants.
  const bbox = parsed.bbox;
  return {
    cx: (bbox.minX + bbox.maxX) / 2,
    cy: (bbox.minY + bbox.maxY) / 2,
    r: Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY) / 2 || 1,
  };
}

/**
 * Largest flat design face across *loaded* parts, lazily memoized: the size reference for a rect
 * SVG with no mm size. A part still fetching would drop callers to the 1:1 branch.
 *
 * Known limit, harmless today: one scale for the whole assembly, while `placeOnPart` centres on
 * each part's own face. The footrest has one face; a rect kind mixing face sizes would crop
 * oversized artwork on the smaller faces. A fix must keep `designMmPerUnit`'s two callers (build
 * and gizmo) agreeing, since that is what makes the selection frame match the cut.
 */
export function memoLargestDesignFace(
  parts: AssemblyPart[],
): () => { w: number; h: number } | null {
  let memo: { w: number; h: number } | null | undefined;
  return () => {
    if (memo !== undefined) return memo;
    let found: { w: number; h: number } | null = null;
    for (const p of parts) {
      if (!p.loaded) continue;
      const bb = faceXZBBox(p.boundaryLoops);
      if (bb && bb.w > 0 && bb.h > 0 && (!found || bb.w * bb.h > found.w * found.h))
        found = { w: bb.w, h: bb.h };
    }
    return (memo = found);
  };
}

/** What `designMmPerUnit` needs about the assembly the design is being placed on. */
export interface DesignScaleContext {
  isRect: boolean;
  /** the wheel's Design radius in mm; unused on a rect kind */
  radius: number;
  /** lazy `memoLargestDesignFace(parts)`, read only on the no-declared-size rect branch */
  designFace: () => { w: number; h: number } | null;
  /**
   * Extra shrink a *generated* part applied to its own shape, which the artwork must follow (1 or
   * absent otherwise). Separate from `designFace` because an SVG with an absolute mm size returns
   * before the face is consulted: folded in there, the hubcap's wheel cap was a silent no-op for
   * this app's own templates.
   */
  generatedFit?: () => number;
}

/**
 * SVG user units to mm for one placed artwork. Wheel: circle radius maps to the mm Design radius.
 * Rect: via the declared physical size (userUnitMM), so a template lands life-size whatever
 * resolution an editor re-exported it at.
 *
 * With no mm size, the document canvas is meet-fit to the design face (the template's sheet *is*
 * the face); 1:1 only with no canvas either. Canvas, not viewBox: an Affinity export can drop the
 * viewBox and state the sheet in px alone. viewBox stays the fill tile period. `forceRect` is the
 * fill path, where a tile is a real-world period, not a radius-driven scale. Every shipped artwork
 * declares `width="100%"`, so auto-fit is the normal path, shared with the gizmo like
 * `designAnchor`. Reads only the document (content arrives as `anchorR`), so the raster stage can
 * ask a trace's scale before tracing (state/artwork.ts).
 *
 * **Known gap: a Fill tile with no mm size still auto-fits.** A 60-unit tile on the footrest's
 * 266x185mm face reads 3.0833 mm/unit under `width="100%"` + viewBox or `width="60px"` — a 185mm
 * period, one repeat per face; `width="60mm"` reads 1.0000. The four shipped patterns all declare
 * 60mm; a user's tile can hit it. What it should repeat at is a product call: docs/roadmap.md.
 */
export function designMmPerUnit(
  parsed: Pick<ParsedSVG, 'userUnitMM' | 'canvas' | 'origin'>,
  scaleMult: number,
  anchorR: number,
  ctx: DesignScaleContext,
  forceRect = false,
  notice: (msg: string) => void = () => {},
): number {
  // Applied to every branch below, deliberately: see DesignScaleContext.generatedFit.
  const fit = ctx.generatedFit?.() ?? 1;
  if (!ctx.isRect && !forceRect) return (ctx.radius / anchorR) * scaleMult * fit;
  if (parsed.userUnitMM != null) return parsed.userUnitMM * scaleMult * fit;
  const sheet = parsed.canvas;
  const designFace = ctx.designFace();
  if (designFace && sheet && sheet.w > 0 && sheet.h > 0) {
    // Two strings, not one format-neutral one: setting the document size in mm is the real fix for
    // an SVG and impossible for an image, so a shared message loses the actionable half of each.
    notice(
      parsed.origin === 'raster'
        ? 'This image has no real-world size, so it was auto-fit to the part face. Use Scale to fine-tune.'
        : 'This SVG has no size in millimeters, so it was auto-fit to the part face. Set the document size in millimeters for an exact size, or use Scale to fine-tune.',
    );
    return Math.min(designFace.w / sheet.w, designFace.h / sheet.h) * scaleMult * fit;
  }
  if (designFace)
    notice(
      'This SVG has no size in millimeters, so its true print size is unknown. It was placed 1:1 with its coordinate units. Set the document size in millimeters, or use Scale to correct the fit.',
    );
  return scaleMult * fit;
}

/**
 * Axis-aligned extent in zone mm of a design's placed content. Translation and mirroring don't
 * change an extent, so no mapper: `designMmPerUnit` and rotation (45° covers a bigger box than
 * square-on) are the whole story. Zero on an axis with no extent or under a non-finite scale
 * (degenerate anchor radius), never NaN.
 */
export function placedFootprintMM(
  parsed: ParsedSVG,
  scaleMult: number,
  rotationDeg: number,
  ctx: DesignScaleContext,
): { w: number; h: number } {
  const mm = designMmPerUnit(parsed, scaleMult, designAnchor(parsed, ctx.isRect).r, ctx);
  const b = parsed.bbox;
  const w = (b.maxX - b.minX) * mm,
    h = (b.maxY - b.minY) * mm;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 0 || h < 0) return { w: 0, h: 0 };
  const t = (rotationDeg * Math.PI) / 180;
  const c = Math.abs(Math.cos(t)),
    sn = Math.abs(Math.sin(t));
  return { w: c * w + sn * h, h: sn * w + c * h };
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
function keptHalfFor(
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
 * Names detail too fine to print, per colour and part (the pair the user can act on). Says nothing
 * of cause, amount or remainder: three clips can each drop something, and the key dedupes across
 * them first-push-wins, so a remainder claim could outlive a later clip removing the rest. A
 * notice, not a warning: one nozzle square is the floor, so nothing printable went.
 */
export function unprintableSpeckNotice(label: string, partName: string): string {
  return (
    `"${label}" has detail on "${partName}" too fine to print, so it wasn't cut. A recess needs ` +
    `to be about 0.4 mm across to hold a bead.`
  );
}

/** One pill per colour and part, however many of the three clips leave a speck. See Notice.key. */
const speckKey = (ci: number, partId: number): string => `speck:${ci}:${partId}`;

/** Rule 1 for the net clip: where the part of a whole-part design this zone gave up is cut. */
export function netShareNotice(design: string, zone: string, toNames: string[]): string {
  const where =
    toNames.length === 1 ? `"${toNames[0]}"` : toNames.map((n) => `"${n}"`).join(' and ');
  return (
    `"${design}" reaches part of the whole-part sheet that ${where} owns. ` +
    `It is cut there, not on "${zone}".`
  );
}

/**
 * Rule 1's other half for the net clip: the ink moved and the sheets don't meet where it crossed,
 * so the halves cut tens of mm apart. A warning: the cut is correct, the result isn't what anyone
 * drew. `NetZoneExclusion.tearMm` is a median over the stretch, hence whole mm.
 * Raised from the clip, not a rebuild.ts boundary test: 31% and 8% of the chair's two boundaries
 * join, so a placed-bbox test would fire for nearly every whole-part design.
 * Zones are sorted: the divider is ragged, so one crossing raises this from both sides, and a
 * from/to order made two pills for one boundary. `raiseTornWarning` keeps the worse tear.
 */
export function netTornWarning(design: string, zones: string[], tearMm: number): string {
  const [a, b] = [...zones].sort();
  return (
    `"${design}" crosses between "${a}" and "${b}", where the two sheets do not join. ` +
    `It prints in two pieces, about ${Math.round(tearMm)}mm apart. Bind it to one zone instead.`
  );
}

/**
 * One pill per design and boundary, quoting the worst tear, so not the notice list's first-wins
 * dedupe: each side of a boundary measures its own rows (33.8mm and 2.6mm across the chair's
 * flank/back join), and first-wins could quote 2.6mm for a design torn by 34mm.
 * `seen` is per build and shared by colours, which can cross different torn stretches.
 */
function raiseTornWarning(
  seen: Map<string, { message: string; tearMm: number }>,
  design: string,
  zones: string[],
  tearMm: number,
): void {
  const key = `net-torn:${design}:${[...zones].sort().join(':')}`;
  const had = seen.get(key);
  if (had && had.tearMm >= tearMm) return;
  if (had) dismissNotice(had.message, key);
  const message = netTornWarning(design, zones, tearMm);
  seen.set(key, { message, tearMm });
  warnBuild(message, key);
}

/**
 * The net clip could not be applied, so this zone cuts the part another sheet also cuts and the
 * design lands twice. One remedy, the one that always works.
 */
export function netShareFailedWarning(design: string, zone: string): string {
  return (
    `Couldn't trim "${design}" to the part of the whole-part sheet "${zone}" owns. ` +
    `Some of it prints twice. Bind that design to one zone instead.`
  );
}

/** Rule 1 for the half clip: what a mirrored design lost to the centre line, and where it went. */
export function mirrorHalfNotice(design: string, zone: string, side: KeepSide): string {
  return (
    `"${design}" crosses the centre line of "${zone}". ` +
    `Its ${side} half is kept and mirrored onto the ${oppositeSide(side)}.`
  );
}

/**
 * The half clip could not be applied (the clipper flaked, or the zone has no centre to clip at),
 * so the design and its reflection both cut whole and their inlays double up along the centre line.
 * One remedy, the one that always works.
 */
export function mirrorClipFailedWarning(design: string, zone: string): string {
  return (
    `Couldn't crop "${design}" to its half of "${zone}". ` +
    `It and its mirror image both print in full. Untick Mirror on that design.`
  );
}

/**
 * Rules 1 and 3 for a fill yielding to a sticker: that one color keeps the overlap, and says so.
 * The remedy is a nudge because the failure is the clipper's, on these exact coordinates.
 */
export function fillYieldFailedWarning(label: string, fill: string, partName: string): string {
  return (
    `Couldn't fit "${label}" of "${fill}" around the design on top of it on "${partName}". ` +
    `Where they meet, both print in the same space. Move the design on top slightly.`
  );
}

/** Said once per color, and only when no part cuts it: covered on one part, it prints on another. */
export function fillCoveredNotice(label: string): string {
  return `"${label}" is hidden everywhere by the designs on top of it, so it isn't cut.`;
}

/**
 * The regions one design actually cuts, placed: what the overlap check consults when bounding boxes
 * alone would warn on artwork that never touches. Post-merge, post-base slot features, which never
 * overlap within a design, so areas add. Clipped to kept half and net share, and put through the
 * speck floor, exactly as the cutter; not the per-part boundary clip (no part here).
 */
function placedInk(
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
function placedInkFeatures(
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
function placedBBoxQuad(
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

/**
 * One word for the repeated thing: "tile", never also "copy" (convention 1). Second person, per the
 * README's voice. Shared by every fill fallback, including the extent-missing one past the switch.
 */
const FILL_FELL_BACK_TO_ONE_TILE = 'You have one tile instead.';

/**
 * Per-cause message for a Fill that couldn't repeat. `tileCoverage` refuses five ways and raising
 * Scale fixes two (docs/ui-conventions.md 2 and 3: one problem, one actionable remedy).
 */
export function fillRefusalMessage(
  designName: string,
  partName: string,
  reason: TileRefusal | undefined,
  detail?: NonNullable<TileRefusalReport['detail']> & { scalable: boolean },
): string {
  const placed = FILL_FELL_BACK_TO_ONE_TILE;
  const design = `"${designName}"`;
  switch (reason) {
    case 'too-many-tiles':
      return (
        `${design} is too small to fill "${partName}": it would take more than ` +
        `${MAX_FILL_TILES} tiles. ${placed} Raise Scale to fill it with fewer, larger tiles.`
      );
    // Two arms: a design can be over budget at every Scale the panel offers, and raising Scale
    // would repeat the warning (convention 2). Only the caller has the placer at maximum Scale,
    // hence `scalable`. The count is the busiest color's, not the tile's, and the wording says so.
    // Without its numbers it falls through to the default: a limit without them is unactionable.
    case 'too-detailed':
      if (detail)
        return detail.scalable
          ? `${design} is too detailed to fill "${partName}". Repeating its busiest color means ` +
              `merging ${detail.tiles} tiles of ${detail.points} points each. ${placed} Raise ` +
              'Scale to fill it with fewer, larger tiles.'
          : `${design} is too detailed to fill "${partName}" at any Scale. Its busiest color ` +
              `carries ${detail.points} points per tile. ${placed} Simplify the design in ` +
              'Illustrator or Inkscape.';
      break;
    // Not necessarily the busiest color, so it names none: a background that runs through every
    // tile joins into one shape however few points it has.
    case 'joins-too-big':
      if (detail)
        return detail.scalable
          ? `${design} is too detailed to fill "${partName}". One of its colors joins across ` +
              `all ${detail.tiles} tiles into one shape too big to cut. ${placed} Raise Scale ` +
              'to fill it with fewer, larger tiles.'
          : `${design} is too detailed to fill "${partName}" at any Scale. One of its colors ` +
              `joins across the tiles into one shape too big to cut. ${placed} Simplify the ` +
              'design in Illustrator or Inkscape.';
      break;
    // Not a missing viewBox: tileCellOf already falls back to the artwork bbox when the viewBox
    // isn't positive in both axes. Reaching here means the DRAWING has no extent in one direction.
    case 'no-tile-size':
      return (
        `${design} measures zero in one direction, so there is no tile to repeat across ` +
        `"${partName}". ${placed} Use a design with both width and height.`
      );
    case 'not-invertible':
      return (
        `The placement of ${design} on "${partName}" has collapsed to no width or no height. ` +
        `Its tiles can't be worked out. ${placed} Use "Reset to auto-fit" to put it back.`
      );
    case 'not-affine':
      return (
        `"${partName}" curves too much for ${design} to tile evenly across it. ${placed} Place ` +
        'separate designs on it instead of filling it.'
      );
  }
  // A refusal path that forgot to name itself, or its numbers: say so rather than guess a cause.
  return (
    `${design} couldn't be tiled across "${partName}", for a reason the app didn't record. ` +
    `${placed} Please report this.`
  );
}

/**
 * Name both designs when two land on top of each other. Nothing downstream notices: cutters are per
 * design, the body union looks perfect, and the inlays only meet in the export, where the slicer
 * picks arbitrarily. Per zone, not per part; warnings dedupe by message, so a pair is said once.
 */
function warnOverlappingDesigns(placed: PlacedDesign[]): void {
  for (const [a, b] of overlappingDesignPairs(placed)) {
    const both = a.fill && b.fill;
    const subject =
      a.name === b.name ? `Two placements of "${a.name}"` : `Designs "${a.name}" and "${b.name}"`;
    warnBuild(
      both
        ? // No move or rescale remedy: a fill covers the whole face, and Fill is only offered on
          // zoneless kinds (chair-body sets withholdFill), so there is nowhere to move one.
          `${subject} are both set to Fill, so they cover each other completely. Where their` +
            ' colors differ the export will carry two inlays claiming the same space. Switch one' +
            ' to Sticker, or remove it.'
        : // "may": the check bounds ink reaching the shared box rather than intersecting, so
          // artwork sharing a box without touching trips it (designOverlap.ts).
          `${subject} overlap. Where they cross, their recesses cut into each other and the` +
            ' export may carry two inlays claiming the same space. Move, rescale, or rotate one' +
            ' of them.',
    );
  }
}

/**
 * Vector + mesh-boolean assembly build. Per part: place the SVG's per-color net regions onto the
 * part's flat face in native coordinates, extrude each to a prism, then use Manifold to (a)
 * subtract all prisms from the part mesh (the full modified body) and (b) intersect each prism
 * with the part (a flush inlay solid per color).
 */
export async function buildAssemblyGeometry(
  input: AssemblyBuildInput,
): Promise<AssemblyBuild | null> {
  resetCsgFaults();
  const {
    artworks,
    parts,
    mergeGroups,
    colorSettings,
    globalDepth,
    radius,
    designFit,
    autoMergeLevel,
    baseColorKey,
    baseColorMembers,
    keptApart,
  } = input;
  if (!artworks.length || artworks.some((a) => !a.parsed)) return null;
  /** Standing straddle pills for this build, keyed by design and boundary — raiseTornWarning. */
  const tornPills = new Map<string, { message: string; tearMm: number }>();

  const isRect = designFit === 'rect';

  const anchorOf = (parsed: ParsedSVG) => designAnchor(parsed, isRect, noticeBuild);

  // Progress split: net regions ~0-40%, the per-part Manifold CSG loop ~40-100%.
  // `byColor` pools each artwork's regions by hex, so color detection, merging, base assignment
  // and depth all see one palette across every design in the scene.
  const perArtworkColors: Record<string, PolyFeature>[] = [];
  for (let i = 0; i < artworks.length; i++) {
    const r = await computeNetRegionsByColor(artworks[i].parsed.shapes, (f) =>
      reportProgress(((i + f) / artworks.length) * 0.4),
    );
    perArtworkColors.push(r.byColor);
  }
  const byColor: Record<string, PolyFeature> = {};
  for (const one of perArtworkColors)
    for (const [hex, feat] of Object.entries(one))
      byColor[hex] = byColor[hex] ? concatFeatures(byColor[hex], feat) : feat;
  if (!Object.keys(byColor).length) return null; // no fills at all, nothing to place

  const totalRawArea = Object.values(byColor).reduce((s, f) => s + planarArea(f), 0) || 1;
  const detectedColors: DetectedColor[] = Object.keys(byColor)
    .map((hex) => ({ hex, areaPct: (100 * planarArea(byColor[hex])) / totalRawArea }))
    .sort((a, b) => b.areaPct - a.areaPct);
  // baseColorMembers covers a whole merged group when a merged slot was sent to base; falls back
  // to just the dominant hex for older callers/plain-color assignments.
  const baseMembers =
    baseColorMembers && baseColorMembers.length
      ? baseColorMembers
      : baseColorKey
        ? [baseColorKey]
        : [];
  const baseArea = baseMembers.reduce((s, h) => s + planarArea(byColor[h] ?? null), 0);
  // the body prints the base's dominant (largest-area) member, same as a merged cut slot would
  const dominantBaseMember = baseMembers.reduce<{ hex: string; area: number } | null>((best, h) => {
    const area = planarArea(byColor[h] ?? null);
    return !best || area > best.area ? { hex: h, area } : best;
  }, null);
  const baseAssigned =
    baseColorKey && baseArea > 0
      ? {
          hex: dominantBaseMember?.hex ?? baseColorKey,
          areaPct: (100 * baseArea) / totalRawArea,
        }
      : null;

  // Merged colors become one region, one AMS slot, one depth; `key` doubles as the depth key.
  // Base-assigned colors are excluded, so an all-base design legitimately resolves to an empty
  // palette (uncut body) rather than failing.
  const resolved = applyColorMerges(byColor, mergeGroups, {
    autoMergeLevel,
    baseColors: baseMembers,
    keptApart,
  });
  const palette: AssemblyPaletteEntry[] = resolved.map((r) => ({
    hex: r.previewColor,
    key: 'asm:' + r.key,
    members: r.members,
    isMerge: r.isMerge,
  }));

  // Regions each artwork contributes to each palette slot, indexed [color][artwork]. Grouping is
  // decided once from the pooled colors so every artwork agrees which hexes share a slot.
  const featuresByColor: (PolyFeature | null)[][] = palette.map((c, ci) =>
    // With one artwork the pooling was a no-op and applyColorMerges already unioned this slot over
    // exactly this geometry: reuse it rather than paying for the same turf union twice per rebuild.
    artworks.length === 1
      ? [resolved[ci].feature]
      : perArtworkColors.map((one) => {
          let feat: PolyFeature | null = null;
          for (const hex of c.members) {
            const part = one[hex];
            if (part) feat = feat ? safeUnion(feat, part) : part;
          }
          return feat;
        }),
  );

  const scaleCtx: DesignScaleContext = {
    isRect,
    radius,
    // The gizmo builds this same context from the same helper: a frame drawn around a size the cut
    // didn't use encloses empty face (see designAnchor).
    designFace: () => generatedDesignFaceOverride() ?? memoLargestDesignFace(parts)(),
    generatedFit: generatedFitFactor,
  };
  const mmPerUnitOf = (
    parsed: ParsedSVG,
    scaleMult: number,
    anchorR: number,
    forceRect = false,
  ): number => designMmPerUnit(parsed, scaleMult, anchorR, scaleCtx, forceRect, noticeBuild);

  let wasm;
  try {
    wasm = await getManifold();
  } catch (e) {
    warnBuild(
      'Could not load the Manifold boolean engine, so assembly cutting is unavailable. ' +
        (e as Error).message,
    );
    return null;
  }
  const { Manifold } = wasm;

  // User mirrors layer on the mapper's per-face correction. zMul base is -1 because SVG Y runs down
  // while the viewport is Z-up; the user's vertical flip toggles it.
  // A fill's tile is one period: the viewBox (parsing bakes its origin out, so it starts at 0,0),
  // or the artwork bbox when no viewBox is declared.
  const tileCellOf = (parsed: ParsedSVG): TileCell => {
    const vb = parsed.viewBox;
    if (vb && vb.w > 0 && vb.h > 0) return { x: 0, y: 0, w: vb.w, h: vb.h };
    const b = parsed.bbox;
    return { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY };
  };
  const tileCells = artworks.map((a) => tileCellOf(a.parsed));

  // Points one tile costs the union, over its biggest color: the union runs per color, which is
  // what tileCoverage's ceiling caps. Hoisted so the part/zone loops don't re-walk every ring.
  const tileVerts = artworks.map((_a, ai) =>
    featuresByColor.reduce((n, perArtwork) => Math.max(n, featureVertexCount(perArtwork[ai])), 0),
  );

  const placements: DesignPlacement[] = artworks.map((a, ai) => {
    // A fill anchors on its tile, not the boundary circle: circle anchoring fits one design to the
    // Design radius, which for a pattern scales a single period up to the whole wheel.
    const cell = tileCells[ai];
    const fill = a.mode === 'fill';
    const svgC = fill
      ? { cx: cell.x + cell.w / 2, cy: cell.y + cell.h / 2, r: Math.max(cell.w, cell.h) / 2 || 1 }
      : anchorOf(a.parsed);
    return {
      svgC,
      mmPerUnit: mmPerUnitOf(a.parsed, a.scaleMult, svgC.r, fill),
      xFlip: a.flipX ? -1 : 1,
      zMul: a.flipY ? 1 : -1,
      offX: a.offX,
      offZ: a.offZ,
      rotationDeg: a.rotationDeg,
    };
  });

  // The same placement at maximum Scale: a fill refused for detail is re-asked against it, so
  // "raise Scale" is offered only where the slider reaches a small enough grid (predicting from the
  // padding rule's 3x3 minimum was wrong in between). Built on demand with the no-op notice sink:
  // auto-fit notices for a Scale the user never set are not theirs to see.
  const maxScalePlacement = (ai: number): DesignPlacement => ({
    ...placements[ai],
    mmPerUnit: designMmPerUnit(
      artworks[ai].parsed,
      artworks[ai].maxScaleMult ?? artworks[ai].scaleMult,
      placements[ai].svgC.r,
      scaleCtx,
      true,
    ),
  });

  // Overlap is per zone, and the loop walks zones once per part. Both placers add the same
  // translation, mirror and rigid rotation to BOTH designs, so overlap is part-invariant; skipping
  // the repeat keeps the ink transform off the per-part path.
  const overlapCheckedZones = new Set<string>();

  // Per-part Manifold CSG is the heavy work (turf's is done above). Yield on a time budget and
  // report per-part progress so the curtain climbs.
  const totalParts = parts.filter((p) => p.loaded && p.boundaryLoops && p.positions).length || 1;
  let partsDone = 0;
  let lastYield = performance.now();
  const maybeYield = async (): Promise<void> => {
    if (performance.now() - lastYield > YIELD_BUDGET_MS) {
      await yieldToBrowser();
      lastYield = performance.now();
    }
  };
  const reportPartProgress = (subFraction: number): void => {
    reportProgress(0.4 + ((partsDone + subFraction) / totalParts) * 0.6);
  };
  const finishPart = (): void => {
    partsDone++;
    reportPartProgress(0);
  };

  const partOutputs: AssemblyPartOutput[] = [];
  // Colors an edge rule took the full thickness, with the depth. Said once at the end: one fact
  // about the design, and a color can sit on several parts.
  const edgeCutColors = new Map<string, number>();
  // Zero-depth raises, build-wide: the message names no part, and is said once.
  const zeroDepthRaises = new Map<string, ZeroDepthRaise>();
  // A part's maxCutDepth() clamp (addPartTooDeepClamp), keyed per part since the bound is.
  const tooDeepClamps = new Map<string, PartDepthClamp>();
  // A thinner wall under the region: "deeper than the part goes" is false of that pocket.
  const thinWallClamps = new Map<string, PartDepthClamp>();
  // Depth actually cut per palette index, for the colour list's display-only Depth field
  // (docs/tech-debt.md).
  const colorAppliedDepth = new Map<number, number>();
  // Palette indices that reached a design surface: a survived clip, an inlay (a cut-through zone's
  // boolean is its bound), or any CSG failure on the color, so a broken boolean never also says
  // "move it". Only colors that provably reached nothing get the off-part warning.
  const landedColors = new Set<number>();
  // Of those, kept out only by hidden surface: the opposite remedy (move it off covered surface,
  // not back onto the part).
  const hiddenColors = new Set<number>();
  // A fill color left with nothing once it yielded to the stickers on top, and every color that
  // reached a cutter. The first minus the second is a color the stickers hide everywhere.
  const coveredColors = new Set<number>();
  const exposedColors = new Set<number>();
  /**
   * The one place a color is attributed to hidden surface: its placed region (tiles and all)
   * reached only this zone's dead surface. Dead surface is baked inside the chart's claim, so an
   * overlap proves the pre-clip boundary would have admitted it. intersectQuiet, not safeIntersect
   * (returns UNCLIPPED, an overlap for every color) nor the checked variant (warns about an
   * intersect that shaped nothing). A flake takes the off-part message.
   */
  const noteHiddenSurface = (mapper: ZoneMapper, placed: PolyFeature | null, ci: number): void => {
    const dead = mapper.deadArea();
    if (!placed || !dead) return;
    if (intersectQuiet(placed, dead)) hiddenColors.add(ci);
  };

  /**
   * Drop specks too small to print, notice once per colour and part across all three clips, and
   * mark the colour landed — together, so no colour gets both the speck notice and "lands entirely
   * off the part" (whose lower-Scale remedy is backwards for a design already too small).
   */
  const dropSpecks = (
    feat: PolyFeature | null,
    ci: number,
    part: AssemblyPart,
    c: { hex: string; isMerge: boolean; members: unknown[] },
  ): PolyFeature | null => {
    const r = dropUnprintableRemnants(feat, CLIP_REMNANT_FLOOR_MM2);
    if (!r.dropped) return r.feat;
    noticeBuild(
      unprintableSpeckNotice(regionLabel(c.hex, c.isMerge, c.members.length), part.name),
      speckKey(ci, part.id),
    );
    // The color DID reach this face; what it left could not print.
    landedColors.add(ci);
    return r.feat;
  };
  let anyPlacements = false;
  let viewSign = 1,
    viewSignSet = false; // Y direction of the first real part's design face
  for (const part of parts) {
    if (!part.loaded || !part.boundaryLoops || !part.positions) continue;
    throwIfCancelled();

    // One implicit flat zone, or a sidecar kind's baked conformal charts (possibly none). The
    // mapper owns all surface geometry; every zone's cutters union into one CSG pass, so a part is
    // cut once. Placement is still global, so a multi-zone part receives the SAME artwork on each
    // zone. Per-zone artwork is the artwork-instance work (state.artworks already models it).
    const mappers = zoneMappersFor(part, parts, isRect, wasm);

    if (!part.zones) {
      // Flat-path assumption only: a conformal zone's face legitimately points sideways (the
      // chair's side panels face ±X), which is what the baked chart exists to handle.
      const nrm = mappers[0].faceNormal;
      if (nrm && Math.abs(nrm[1]) < 0.9) {
        warnBuild(
          `Part "${part.name}": detected face normal (${nrm.map((v) => v.toFixed(2)).join(', ')}) isn't vertical. Assembly cutting assumes a horizontal face. Pick a different face or the cut may be wrong.`,
        );
      }
    }
    if (mappers.length && !part.isDuplicateOf && !viewSignSet) {
      viewSign = mappers[0].nsign;
      viewSignSet = true;
    }

    // Every Manifold solid this part allocates, freed by the finally below. A Set because steps
    // hand the same handle on; freeing per branch leaked WASM on each mid-cut cancel, so this is
    // what lets throwIfCancelled sit anywhere.
    const held = new Set<ManifoldSolid>();
    try {
      // A color can be cut on several zones of one part, so each collects a list of solids that is
      // unioned before the body/inlay booleans.
      const colorPrisms: Record<number, ManifoldSolid[]> = {};
      // Staged edge-rule colors, merged into edgeCutColors only where the part succeeds (see `keep`).
      const partEdgeColors = new Map<string, number>();
      // A plain function, not inlined below, so its early `return`s mean "skip this color" without
      // fighting the surrounding for-loop/await.
      const buildColorPrism = async (
        mapper: ZoneMapper,
        boundaryPoly: PolyFeature | null,
        place: (pt: number[]) => number[],
        half: KeptHalf | null,
        netExcl: NetExclusion[],
        zoneName: string,
        fills: (PolyFeature | null)[] | null,
        under: PolyFeature[],
        c: AssemblyPaletteEntry,
        ci: number,
        ai: number,
      ): Promise<void> => {
        const tiled = fills ? fills[ci] : featuresByColor[ci][ai];
        if (!tiled) return;
        let feat: PolyFeature | null = mapFeatureCoords(tiled, place);
        // On a clipper failure safeIntersect returns the region *unclipped*, which the edge rule
        // reads as all-edge and cuts clean through instead of recessed. Tracked, not assumed.
        let clipped = true;
        if (boundaryPoly) {
          const placed = feat;
          // An all-hidden chart (empty MultiPolygon boundary) comes back empty here, no branch
          // needed. A pre-tiling skip would save a fill's union pass but attributed off the UNTILED
          // source; restore it only for a bake that fails tests/chair-zones.test.ts ("no shipped
          // chart is hidden outright").
          const r = safeIntersectChecked(feat, boundaryPoly, `color ${c.hex} on ${part.name}`);
          feat = r.feat;
          clipped = r.clipped;
          // Before the speck floor: a clip returning nothing is hidden surface, with its own
          // remedy, not ink too small to print.
          if (!feat) {
            noteHiddenSurface(mapper, placed, ci);
            return;
          }
          // The dead region on a chart is baked to share that chart's own outline, which is where
          // this clip leaves a hairline rather than nothing. See dropUnprintableRemnants.
          feat = dropSpecks(feat, ci, part, c);
          if (!feat) return;
          // Only a real clip proves the color reached this face; a cut-through zone counts it when
          // its boolean yields an inlay, below.
          landedColors.add(ci);
        }
        // After the boundary clip, so what the notice reports lost is surface this part cuts.
        // The color counts as landed either way: what this takes off is cut by the reflection.
        // Said from the un-reflected input only, or the pair reports both halves as the one kept.
        if (half) {
          const r = clipToKeptSide(feat, half);
          const design = artworks[ai].name || 'design';
          if (r.failed) warnBuild(mirrorClipFailedWarning(design, half.zoneName));
          else if (r.removed && !artworks[ai].reflected)
            noticeBuild(mirrorHalfNotice(design, half.zoneName, half.side));
          // Same boundaries, same failure: the kept-side clip runs along the zone's own centre line.
          feat = dropSpecks(r.feat, ci, part, c);
          if (!feat) return;
        }
        // A whole-part design is cut only where the net says this zone owns the canvas, or a mark
        // where sheets overlap cuts on both. Nothing is lost (the owner cuts it; a per-zone binding
        // still reaches it), so this is a notice. Decided 2026-09-05: overlap left in measured
        // 8,730 and 8,226mm² of doubled canvas on the chair, where designs centre. The flanks yield
        // 8,668 and 8,158mm²: a sheet only yields canvas the sheet taking it can chart.
        if (netExcl.length) {
          const r = clipToNetShare(feat, netExcl);
          const design = artworks[ai].name || 'design';
          // Both: a zone can yield to two neighbours (the chair's back to each flank), failing on
          // one patch and moving ink on another.
          if (r.failed) warnBuild(netShareFailedWarning(design, zoneName));
          if (r.movedTo.length) noticeBuild(netShareNotice(design, zoneName, r.movedTo));
          // A separate fact: the move is right, the halves won't line up. One pill per boundary.
          for (const t of r.torn)
            raiseTornWarning(tornPills, design, [zoneName, t.toName], t.tearMm);
          // The net partition is cut from the same charts, so its patch boundaries coincide with
          // this zone's claim in exactly the way that leaves a hairline.
          feat = dropSpecks(r.feat, ci, part, c);
          if (!feat) return;
        }
        // A fill is background, so it yields to every sticker on the zone, or differing colors
        // export two inlays in one volume. One sweep per color and part: 0.3-0.6s of a wheel build
        // (`yield ms`, scripts/bench-fill-yield.ts). Chair unmeasured.
        if (under.length) {
          const r = differenceAllChecked(feat, under);
          if (!r.trimmed)
            warnBuild(
              fillYieldFailedWarning(
                regionLabel(c.hex, c.isMerge, c.members.length),
                artworks[ai].name || 'design',
                part.name,
              ),
            );
          if (!r.feat) {
            // Landed for a cut-through part too, which has no clip to have said so: the color is
            // under a sticker, not off the part, and the off-part warning's remedy would be wrong.
            landedColors.add(ci);
            coveredColors.add(ci);
            return;
          }
          // A sticker edge crossing a stripe leaves a tip often under the speck floor (0.12mm² in
          // tests/fill-yield.test.ts). Unfloored with no boundary: that region still reaches off
          // the part. Exposed before the floor: a color left only a speck still reached this face.
          exposedColors.add(ci);
          feat = boundaryPoly ? dropSpecks(r.feat, ci, part, c) : r.feat;
          if (!feat) return;
        }
        exposedColors.add(ci);
        const requested = requestedDepth(colorSettings, globalDepth, c.key);
        // A depth at or below zero cuts nothing and used to drop the color and its depth field
        // silently; raised so it stays fixable. The message names the *setting*, not the cut (a cut
        // depth claimed 0.02 mm on a 3 mm through-cut), and no part, so a wheel says it once.
        const raised = requested <= 0 ? MIN_CUT_DEPTH_MM : requested;
        // Bounded by how far the part extends behind its face (unbounded, 20 mm and 9999 mm both
        // exported unwarned on the wheel); resolveCutRegions also bounds each region by its wall.
        const depthSetting = Math.min(raised, mapper.maxCutDepth());
        const label = regionLabel(c.hex, c.isMerge, c.members.length);
        // One entry per depth, usually one. An edge rule (a hubcap cut to its artwork's shape)
        // splits off full-thickness polygons on the outer wall; the mapper decides, this extrudes.
        const regions = mapper.resolveCutRegions(feat, depthSetting, {
          label: `color ${label}`,
          clipped,
        });
        // Whether any slice landed at depthSetting, not a substituted depth (cut-through hole, edge
        // slice). Shared by the colour-list depth, too-deep pill and thin-depth note so they cannot
        // disagree; `some`, because a split color cuts at two depths at once.
        const landedAtSetting = regions.some((r) => !depthDiffers(r.depth, depthSetting));
        // A slice the wall under it cut shallower is still the setting, bounded, so the colour list
        // shows it the same way it shows the part bound.
        const wallCuts = regions.filter((r) => r.wall != null);
        const wallDepths = wallCuts.map((r) => r.depth);
        // The colour list's display-only Depth (docs/tech-debt.md), gated the same way so a
        // cutThrough or all-edge part never reports a recess it did not cut. Minimum across
        // parts/zones, so two depths show the more-clamped one, not whichever ran last.
        if (landedAtSetting || wallDepths.length) {
          const cut = Math.min(landedAtSetting ? depthSetting : Infinity, ...wallDepths);
          const prev = colorAppliedDepth.get(ci);
          colorAppliedDepth.set(ci, prev == null ? cut : Math.min(prev, cut));
        }
        for (const r of wallCuts)
          addPartTooDeepClamp(thinWallClamps, label, part.name, raised, r.depth, r.wall);
        if (requested <= 0) addZeroDepthRaise(zeroDepthRaises, label, requested, depthSetting);
        // Gated on what the mapper did, like the sub-layer note: a cutThrough part holes the whole
        // way, so "cut at 24.25 mm instead" would be false. Never test `part.cutThrough` here.
        // Rotated copies report too: same bound (asmAddDuplicate shares mesh, face, topZ) but a
        // different slice, so skipping them left a copy-only color's "cut at" depth unnamed.
        // addPartTooDeepClamp groups colors sharing a setting to one pill per half; per-color
        // overrides still split.
        else if (depthDiffers(depthSetting, raised) && landedAtSetting)
          addPartTooDeepClamp(tooDeepClamps, label, part.name, raised, depthSetting);
        // This one predicts the printed recess, so not on a part that cuts through ("too thin to
        // show up" is wrong about a 3 mm hole); ask the mapper, never `part.cutThrough`. Per-part
        // gating is right since warnings dedupe: said if any part cuts at the setting. A notice:
        // the depth is honored (see thinDepthNotice in depth.ts).
        else if (subLayerDepth(depthSetting) && landedAtSetting)
          noticeBuild(thinDepthNotice(label, depthSetting));
        // Only the refinement differs for a fill (a zone-wide cutter would explode at the sticker
        // step); the snap tolerance is a property of the bake, so both modes take the same one.
        const cutterOpts = fills ? { refineMM: FILL_REFINE_MM } : undefined;
        // Each slice is its own prism in colorPrisms[ci]; the union below welds them per color.
        // Edge colors stage per *part* and merge only once it emits inlays, so "the rim prints in
        // that color" can't outlive a later failure that exports it uncut.
        const keep = (man: ManifoldSolid, region: CutRegion): void => {
          held.add(man);
          (colorPrisms[ci] ||= []).push(man);
          if (region.edge) partEdgeColors.set(label, region.depth);
        };
        // Null for "no solid", whichever step failed: a flat mapper hands back a prism that will
        // not seal, while a conformal one tests its own prism before warping and returns null
        // instead. Both mean the same thing to the repair below, so both reach it.
        const solidFor = (feat: PolyFeature | null, depth: number): ManifoldSolid | null => {
          const soup = feat && mapper.buildCutter(feat, depth, OVERSHOOT_MM, cutterOpts);
          if (!soup || !soup.length) return null;
          const man = soupToManifold(wasm, soup);
          if (manifoldIsValid(man)) return man;
          // Freed: an un-watertight soup comes back as an *empty* solid, not a throw, so this is
          // the common path, and it never reaches `held`. The ladder can discard one per rung.
          manifoldDelete(man);
          return null;
        };
        for (const region of regions) {
          let man: ManifoldSolid | null = null;
          try {
            man = solidFor(region.feat, region.depth);
          } catch {
            /* retry below with self-intersections repaired */
          }
          // Clipped dense line-work can self-touch: valid to turf, not watertight to Manifold.
          // Repair with Manifold's 2D booleans and retry, widening the erode: a gravel photo on the
          // wheel put eleven regions here and one needed the wider rung. Smallest first, so a
          // region repairing at 0.01mm pays no extra loss. An edge slice gets only the narrowest:
          // eroding pulls it off the rim `keep` promises it prints on, leaving a rind of body.
          const rungs = region.edge ? REPAIR_ERODE_MM.slice(0, 1) : REPAIR_ERODE_MM;
          // No notice on a wider rung: an inward offset of `e` removes only what is thinner than
          // `2e`, so 0.05mm touches nothing over a quarter of a 0.4mm nozzle. (A notice's test was
          // always true, erode being monotone.) docs/findings/2026-08-20-extrude-repair-erode.md.
          for (const erodeMm of rungs) {
            if (man) break;
            try {
              man = solidFor(repairSelfIntersections(wasm, region.feat, erodeMm), region.depth);
            } catch {
              /* try the next distance, then warn */
            }
          }
          if (man) {
            keep(man, region);
            continue;
          }
          // Survived the clip, but no cutter came out, repaired or not: too degenerate to extrude,
          // or a conformal warp with no surface under it (usually a baked boundary over-claiming).
          // `continue`, so a color split across two depths keeps the slice that did extrude.
          landedColors.add(ci);
          warnBuild(`Couldn't cut color ${c.hex} into "${part.name}".`);
        }
      };
      // Artworks landing on a zone: those bound to it by id, plus any unbound one. Unbound is the
      // single-zone case (wheel, footrest), which goes wherever the part offers.
      const artworksOn = (mapper: ZoneMapper): number[] =>
        artworks.flatMap((a, ai) => (a.zoneId == null || a.zoneId === mapper.zoneId ? [ai] : []));

      // +1 reserved for the body/inlay CSG stage below, so progress reaches 1 only once every color
      // on every zone plus the final cuts are done.
      const zoneWork = mappers.map(artworksOn);
      // A fill's colors take two units each, one to tile and one to cut.
      const partUnits =
        palette.length *
          zoneWork.reduce(
            (s, l) => s + l.reduce((n, ai) => n + (artworks[ai].mode === 'fill' ? 2 : 1), 0),
            0,
          ) +
        1;
      let unitsDone = 0;
      for (let zi = 0; zi < mappers.length; zi++) {
        const mapper = mappers[zi];
        if (!zoneWork[zi].length) continue;
        const zoneName =
          part.zones?.find((z) => z.id === mapper.zoneId)?.name ?? mapper.zoneId ?? part.name;
        if (zoneWork[zi].length > 1 && !overlapCheckedZones.has(mapper.zoneId ?? '')) {
          warnOverlappingDesigns(
            zoneWork[zi].map((ai) => {
              const place = mapper.placer(placements[ai]);
              const half = keptHalfFor(mapper, artworks[ai], place, zoneName);
              const excl = artworks[ai].netBound ? mapper.netExcluded() : [];
              return {
                name: artworks[ai].name || 'design',
                quad: placedBBoxQuad(artworks[ai].parsed, place, half),
                fill: artworks[ai].mode === 'fill',
                ink: () => placedInk(featuresByColor, ai, place, half, excl),
                group: artworks[ai].mirrorPair,
              };
            }),
          );
          // Marked only where the check actually ran, so a part that happens to carry one design
          // can't suppress the zone's warning for the parts that carry both.
          overlapCheckedZones.add(mapper.zoneId ?? '');
        }
        const boundaryPoly = mapper.boundary();
        // What every fill on this zone yields to: each sticker's ink, placed as it is cut. Only
        // built when a fill shares the zone with one. A fill never yields to another fill; that
        // pairing is warned instead (warnOverlappingDesigns).
        const stickersHere = zoneWork[zi].filter((ai) => artworks[ai].mode !== 'fill');
        const fillHere = zoneWork[zi].some((ai) => artworks[ai].mode === 'fill');
        const under =
          stickersHere.length && fillHere
            ? stickersHere.flatMap((ai) => {
                const place = mapper.placer(placements[ai]);
                return placedInkFeatures(
                  featuresByColor,
                  ai,
                  place,
                  keptHalfFor(mapper, artworks[ai], place, zoneName),
                  artworks[ai].netBound ? mapper.netExcluded() : [],
                );
              })
            : [];
        for (const ai of zoneWork[zi]) {
          anyPlacements = true;
          const place = mapper.placer(placements[ai]);
          const half = keptHalfFor(mapper, artworks[ai], place, zoneName);
          const netExcl = artworks[ai].netBound ? mapper.netExcluded() : [];
          // A zone with no centre to clip at cuts the design and its reflection whole. Degenerate
          // (a chart with no extent), and still a doubled cut nobody asked for, so it is named.
          if (artworks[ai].keepSide && !half)
            warnBuild(mirrorClipFailedWarning(artworks[ai].name || 'design', zoneName));
          // One grid per (zone, artwork): every color repeats identically. An untileable fill
          // degrades to one copy plus a warning, not an empty part.
          const fill = artworks[ai].mode === 'fill';
          const extent = fill ? mapper.fillExtent() : null;
          // Named per design: both remedies reach only the ACTIVE design and warnings dedupe on the
          // string, so two designs failing alike would be one pill naming neither. Two placements
          // of the SAME design still collapse (that needs warnOverlappingDesigns's counted
          // phrasing). `fits`: would the max-Scale grid clear the limit that refused? Asked of the
          // same refusal path, so the remedy can't drift from how a grid is laid.
          const refuseFill = (
            refusal: TileRefusalReport,
            fits: (maxGrid: TileGrid) => boolean = () => true,
          ): void => {
            const maxGrid =
              extent &&
              tileCoverage(
                mapper.placer(maxScalePlacement(ai)),
                tileCells[ai],
                extent,
                tileVerts[ai],
              );
            warnBuild(
              fillRefusalMessage(
                artworks[ai].name || 'design',
                part.name,
                refusal.reason,
                refusal.detail && { ...refusal.detail, scalable: !!maxGrid && fits(maxGrid) },
              ),
            );
          };
          let grid: TileGrid | null = null;
          if (fill && !extent) {
            warnBuild(
              `Couldn't measure the area to fill on "${part.name}", so "${artworks[ai].name || 'design'}" ` +
                `can't be tiled across it. ${FILL_FELL_BACK_TO_ONE_TILE} Please report this.`,
            );
          } else if (extent) {
            const refusal: TileRefusalReport = {};
            grid = tileCoverage(place, tileCells[ai], extent, tileVerts[ai], refusal);
            if (!grid) refuseFill(refusal);
          }
          // Every color tiles before any is cut: one untileable color sends the whole design back
          // to one copy, and partial tiling lands colors out of register. Tiled *in SVG space*, so
          // tiles inherit placement and seam-straddling copies overlap where the union welds them.
          const unitsBefore = unitsDone;
          // Every call ahead takes the whole of one color's fill beside one of these: the face, the
          // kept half, each patch another zone owns, and every sticker it gives way to at once.
          const clipSets: PolyFeature[][] = [
            boundaryPoly ? [boundaryPoly] : [],
            half ? [half.clip] : [],
            ...netExcl.flatMap((e) => (e.region ? [[e.region]] : [])),
            under,
          ];
          const warnedBefore = warningMark();
          let fills: (PolyFeature | null)[] | null = null;
          let tiling = -1;
          if (grid) {
            try {
              fills = [];
              for (let ci = 0; ci < palette.length; ci++) {
                tiling = ci;
                throwIfCancelled();
                const source = featuresByColor[ci][ai];
                const base = unitsDone;
                const tiled = source
                  ? await tileFeature(
                      source,
                      grid,
                      (f) => reportPartProgress((base + f) / partUnits),
                      `color ${palette[ci].hex} on ${part.name}`,
                    )
                  : null;
                // Those calls can split a fill between its polygons but never inside one.
                if (tiled && !clipSets.every((clips) => fitsBesideClips(tiled, clips)))
                  throw new UnionTooBig();
                fills.push(tiled);
                reportPartProgress(++unitsDone / partUnits);
                await maybeYield();
              }
            } catch (e) {
              if (!(e instanceof UnionTooBig)) throw e;
              fills = null;
              // What tiling said about colors already tiled is about tiles now thrown away.
              dropBuildWarningsSince(warnedBefore);
              // The shape that joined can't be bigger than every tile's copy of its color, so a
              // grid whose copies fit is one where Scale is a real remedy. It has to be a smaller
              // grid as well: the engine's crossing limit can refuse copies that fit.
              const points = featureVertexCount(featuresByColor[tiling][ai]);
              const tiles = grid.count;
              refuseFill(
                { reason: 'joins-too-big', detail: { tiles, points } },
                (maxGrid) =>
                  maxGrid.count < tiles &&
                  clipSets.every((clips) => maxGrid.count * points <= roomBesideClips(clips)),
              );
            }
          }
          // A fill that never tiled still owes the progress its tiling units would have reported.
          if (fill && !fills) unitsDone = unitsBefore + palette.length;
          for (let ci = 0; ci < palette.length; ci++) {
            // Per colour: per-part checks left cancel latency at 140.4s on a 6000-region wheel
            // (2026-08-24 cycle, T0-7). A colour is the finest unit where nothing is half-built.
            throwIfCancelled();
            await buildColorPrism(
              mapper,
              boundaryPoly,
              place,
              half,
              netExcl,
              zoneName,
              fills,
              artworks[ai].mode === 'fill' ? under : [],
              palette[ci],
              ci,
              ai,
            );
            reportPartProgress(++unitsDone / partUnits);
            await maybeYield();
          }
        }
      }

      // Per color: the union of its cutters across every zone.
      const prismEntries: [number, ManifoldSolid][] = [];
      for (const [ci, list] of Object.entries(colorPrisms)) {
        // Past the cutter loop each step is one atomic Manifold call; this check and the next two
        // are the finest boundaries left, safe only because of the finally above.
        throwIfCancelled();
        let merged: ManifoldSolid;
        try {
          if (list.length === 1) {
            merged = list[0];
          } else {
            csgFault('color-union');
            merged = Manifold.union(list);
          }
        } catch {
          // This color's cutters (different zones, same part) couldn't be merged. Drop just this
          // color rather than losing the whole part's cut.
          landedColors.add(+ci);
          warnBuild(
            `Couldn't merge color ${palette[+ci].hex} on "${part.name}". It won't print there.`,
          );
          continue;
        }
        if (merged !== list[0]) held.add(merged);
        prismEntries.push([+ci, merged]);
      }
      if (!prismEntries.length) {
        // No cuts landed (or none survived the merge above): emit the untouched body so the
        // assembly still exports whole.
        partOutputs.push({ part, bodySoup: Float32Array.from(part.positions), inlaySoups: {} });
        finishPart();
        continue;
      }

      let partMan: ManifoldSolid;
      try {
        partMan = soupToManifold(wasm, part.positions);
        held.add(partMan);
      } catch {
        prismEntries.forEach(([pci]) => landedColors.add(pci));
        warnBuild(`Couldn't read "${part.name}", so it is not exported.`);
        finishPart();
        continue;
      }
      if (!manifoldIsValid(partMan)) {
        prismEntries.forEach(([pci]) => landedColors.add(pci));
        warnBuild(
          `Part "${part.name}" isn't a watertight/manifold mesh, so it can't be cut cleanly. Repair it (close holes, fix flipped faces) and retry. Exporting it uncut for now.`,
        );
        partOutputs.push({ part, bodySoup: Float32Array.from(part.positions), inlaySoups: {} });
        finishPart();
        continue;
      }

      // full modified body = part - union(all color pockets)
      const prismList = prismEntries.map(([, p]) => p);
      let cutter: ManifoldSolid;
      try {
        if (prismList.length === 1) {
          cutter = prismList[0];
        } else {
          csgFault('part-union');
          cutter = Manifold.union(prismList);
        }
      } catch {
        // Nothing to cut with. Same escape as the non-watertight branch above: export the untouched
        // body rather than risk a half-cut/half-inlaid pair that would overlap.
        prismEntries.forEach(([pci]) => landedColors.add(pci));
        warnBuild(`Couldn't merge the recesses on "${part.name}". It exports with no artwork.`);
        partOutputs.push({ part, bodySoup: Float32Array.from(part.positions), inlaySoups: {} });
        finishPart();
        continue;
      }
      if (cutter !== prismList[0]) held.add(cutter);
      throwIfCancelled();
      let bodySoup: Float32Array;
      let bodyIndexed: AssemblyPartOutput['bodyIndexed'];
      let bodyCutFailed = false;
      // `body` is declared outside the try so the finally frees it even when the throw came from
      // manifoldToMeshes rather than the boolean. Otherwise the solid leaks, unreachable.
      let body: ManifoldSolid | null = null;
      try {
        csgFault('difference');
        body = Manifold.difference(partMan, cutter);
        // After the solid exists, before conversion: the only injection point exercising the
        // finally's freed handle rather than just the degradation.
        csgFault('body-mesh');
        const meshes = manifoldToMeshes(body);
        bodySoup = meshes.soup;
        bodyIndexed = meshes.indexed;
      } catch {
        bodyCutFailed = true;
        bodySoup = Float32Array.from(part.positions);
      } finally {
        manifoldDelete(body);
      }
      await maybeYield();

      if (bodyCutFailed) {
        // Body and inlays come from the same boolean pass. If the cut failed, building inlays anyway
        // ships an uncut body plus inlay solids in the same volume, which a slicer resolves
        // arbitrarily. Export uncut and inlay-less instead.
        prismEntries.forEach(([pci]) => landedColors.add(pci));
        warnBuild(
          `Couldn't cut the recesses into "${part.name}". It exports with no artwork. ` +
            `Cutting halfway would leave two colors claiming the same space.`,
        );
        partOutputs.push({ part, bodySoup, inlaySoups: {} });
        finishPart();
        continue;
      }

      // per-color inlay = part ∩ prism (the part caps the overshoot, so the inlay top is flush)
      const inlaySoups: Record<number, Float32Array> = {};
      const inlayIndexed: Record<number, IndexedMesh> = {};
      for (const [ci, prism] of prismEntries) {
        throwIfCancelled();
        let inl: ManifoldSolid | null = null;
        try {
          csgFault('intersection');
          inl = Manifold.intersection(partMan, prism);
          const { soup, indexed } = manifoldToMeshes(inl);
          if (soup.length) {
            inlaySoups[ci] = soup;
            inlayIndexed[ci] = indexed;
            landedColors.add(ci);
          }
        } catch {
          // Unlike the body-cut failure above, exporting uncut can't undo this: the body's pocket
          // for this color is already cut, and redoing that difference is the expensive half. Name
          // the color and say the recess ships empty, so the warning is actionable.
          landedColors.add(ci);
          warnBuild(
            `Couldn't fit the inlay for color ${palette[ci].hex} on "${part.name}". Its pocket ` +
              `is cut into the body but will print as an empty recess.`,
          );
        } finally {
          manifoldDelete(inl);
        }
        await maybeYield();
      }

      // The part shipped with its inlays, so what the edge rule did is now true of the export and
      // can be said. Merged, not assigned: a color can reach the edge on one part and not another.
      for (const [l, d] of partEdgeColors) edgeCutColors.set(l, d);

      partOutputs.push({ part, bodySoup, inlaySoups, bodyIndexed, inlayIndexed });
      finishPart();
    } finally {
      held.forEach(manifoldDelete);
    }
  }
  // Build-wide, unlike the edge notice: these describe the typed setting, which a part failing its
  // booleans doesn't make untrue.
  for (const r of zeroDepthRaises.values())
    warnBuild(zeroDepthWarning(r.labels, r.requested, r.raisedTo));
  for (const c of tooDeepClamps.values())
    warnBuild(tooDeepWarning(c.labels, c.partName, c.requested, c.cutAt));
  for (const c of thinWallClamps.values())
    warnBuild(thinWallWarning(c.labels, c.partName, c.requested, c.cutAt, c.wall!));
  // Once: each color the edge rule cut through, by depth (one today, per-part in the model).
  const byEdgeDepth = new Map<number, string[]>();
  for (const [label, depth] of edgeCutColors) {
    const at = byEdgeDepth.get(depth);
    if (at) at.push(label);
    else byEdgeDepth.set(depth, [label]);
  }
  for (const [depth, labels] of byEdgeDepth) noticeBuild(edgeCutThroughNotice(labels, depth));
  // Gated on anyPlacements so a build with no design surfaces at all doesn't call every color
  // missing. See landedColors above for what counts as landed.
  if (anyPlacements) {
    const labelsOf = (want: (ci: number) => boolean): string[] =>
      palette
        .map((c, ci) =>
          landedColors.has(ci) || !want(ci)
            ? null
            : regionLabel(c.hex, c.isMerge, c.members.length),
        )
        .filter((l): l is string => l !== null);
    // Two causes, two remedies, so they are never merged into one count. A color the design put
    // only on surface the assembly covers is not off the part and Scale will not bring it back.
    const hidden = labelsOf((ci) => hiddenColors.has(ci));
    const off = labelsOf((ci) => !hiddenColors.has(ci));
    /**
     * Singular or plural form of a dropped-colors message, owning every quote (four hand copies
     * drifted on a full stop). The sentences stay whole in the callers: check-troubleshooting.mjs
     * finds each doc quote inside a shipped string, which a stitched message is not.
     */
    const missedWarning = (
      labels: string[],
      one: (label: string) => string,
      many: (count: number, list: string) => string,
    ): string =>
      labels.length === 1
        ? one(`"${labels[0]}"`)
        : many(labels.length, labels.map((l) => `"${l}"`).join(', '));
    if (off.length)
      warnBuild(
        missedWarning(
          off,
          (l) =>
            `${l} lands entirely off the part and won't print. ` +
            `Lower Scale or move the design to bring it back.`,
          (n, list) =>
            `${n} colors land entirely off the part and won't print: ` +
            `${list}. Lower Scale or move the design to bring them back.`,
        ),
      );
    // "only reaches surface that is hidden", not "lands only where hidden": a design mostly off the
    // part grazing one dead patch lands here too. No visible surface took it; some hidden did.
    if (hidden.length)
      warnBuild(
        missedWarning(
          hidden,
          (l) =>
            `${l} only reaches surface that's hidden once assembled and won't print. ` +
            `Move it off the hatching to bring it back.`,
          (n, list) =>
            `${n} colors only reach surface that's hidden once assembled and won't print: ` +
            `${list}. Move them off the hatching to bring them back.`,
        ),
      );
  }
  // Not gated on landedColors: the boundary clip already counted these as landed, which is true,
  // and is why nothing else would say where they went.
  for (const ci of coveredColors)
    if (!exposedColors.has(ci))
      noticeBuild(
        fillCoveredNotice(
          regionLabel(palette[ci].hex, palette[ci].isMerge, palette[ci].members.length),
        ),
      );
  palette.forEach((c, ci) => {
    const d = colorAppliedDepth.get(ci);
    if (d != null) c.appliedDepth = d;
  });
  return { partOutputs, palette, viewSign, detectedColors, baseAssigned };
}

/**
 * Palette indices that actually ship: an inlay on a part that still has a body to export (a part
 * whose cut consumed it whole is dropped at export, inlays and all). The one predicate behind the
 * export's material list, the color list's rows, and the slot count. Three sites each deriving
 * their own version of this is how a color came to cost an AMS slot while printing nothing.
 */
export function shippedColorIndices(partOutputs: AssemblyPartOutput[]): Set<number> {
  const shipped = new Set<number>();
  for (const o of partOutputs) {
    if (!o.bodySoup.length) continue;
    for (const ci of Object.keys(o.inlaySoups)) shipped.add(+ci);
  }
  return shipped;
}
