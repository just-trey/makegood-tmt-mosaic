import * as THREE from 'three';
import { state } from '../state/store';
import { currentAssemblyKind, currentVariantId } from '../assembly/kinds';
import { displayQuaternionFor } from '../scene/displayFrame';
import type { AssemblyKind } from '../types';
import { $ } from './dom';

/**
 * The part thumbnail beside the Part dropdown, drawn from the part's own mesh.
 *
 * Replaces five hand-authored glyphs picked by `designFit`, which says how artwork is fitted, not
 * what the part looks like: footrest, hubcap and chair all showed the same rectangle. The design
 * system rules out a bigger glyph set (`design-system/README.md` Iconography; convention 32 of
 * docs/ui-conventions.md names a mesh-rendered thumbnail). A silhouette can't go stale on a re-pack.
 */

/** Rendered box in CSS px, matching what the SVG glyphs occupied inside `.shape-thumb`. */
const THUMB_CSS_PX = 30;
/**
 * Supersampling factor for the silhouette mask before it is scaled into the box. It buys the
 * *interior* (smooth depth gradient, not one flat value per device pixel); the boundary is resolved
 * on the device grid by drawEdge(), since a downscaled boundary ramps over ~two device pixels
 * whatever the sample count.
 *
 * It multiplies the *device* pixel size, not CSS: sized off CSS px it was a real 4x only at 1x —
 * at devicePixelRatio 1.5 the 120px buffer landed on a 45px backing store, a 2.67x downscale, and
 * that extra softness was the whole difference (the backing store itself was right, 45 = 30 x 1.5, drawn 1:1).
 */
const SUPERSAMPLE = 4;
/**
 * Device pixels per CSS pixel, for the backing store and the buffer above. Unclamped: the cost is a
 * Float32Array of (30 x dpr x 4)^2 cached on `thumbKey()`, 129600 entries at dpr 3, and clamping it
 * is the undersized-backing-store bug above moved to a rarer display.
 */
const dpr = (): number => (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) || 1;

/**
 * The two pixel sizes a render uses: the canvas backing store and the mask buffer behind it.
 * Exported so both can be asserted without a 2D canvas (scripts/check-part-thumbnails.mjs reads the
 * backing store off the real page, but the buffer is internal and is what this path is about).
 */
export function thumbPixelSizes(ratio: number = dpr()): { out: number; buffer: number } {
  const out = Math.round(THUMB_CSS_PX * ratio);
  return { out, buffer: out * SUPERSAMPLE };
}
/** Fraction of the box the silhouette's longer axis fills, leaving the glyphs' optical margin. */
const FILL = 0.86;
/**
 * The token the silhouette is painted in, and the hex fallback if it reads empty.
 *
 * Neutral, not `--accent`, by decision: convention 19 of docs/ui-conventions.md reserves the accent
 * for selection (blue is also a filament a user owns), and an accent-filled picture beside the Part
 * dropdown reads as "this one is selected". The maintainer rejected the chrome-not-selection argument.
 *
 * It is also more legible, measured off rendered pixels against the `--panel-2` tile, same camera
 * and edge treatment:
 *
 *   --text-dim  7.3:1 nearest (every kind), 3.9-4.6:1 farthest
 *   --accent    5.3:1 nearest, 2.9-3.5:1 farthest
 *
 * The accent's farthest hubcap surface is 2.9:1, under WCAG's 3:1 non-text minimum, on two of six
 * measurements. The live check re-measures every run and holds 3:1 (scripts/check-part-thumbnails.mjs).
 */
const THUMB_TOKEN = '--text-dim';
const THUMB_FALLBACK = '#aab3cf';
/**
 * The thumbnail's camera: an angle around and above the part's front, one fixed pair for every
 * kind so the four thumbnails read as a comparable set.
 *
 * Not the viewport's opening angle: that is nearly face-on to a plate kind's design face (21° off),
 * and face-on can't tell a 60mm-thick wheel from a 3mm hubcap — same outline, and depth dominated by
 * the view's own tilt, leaving nothing to shade. Measured on the shipped thumbnails the two
 * silhouettes overlapped to within 4.5%; from 45°/30° (52° off the face) that becomes 13.2%, a bar
 * the live check holds (scripts/check-part-thumbnails.mjs). Shading by normal instead was rejected:
 * the parts share an *outline* and no shading model changes that.
 */
const THUMB_AZIMUTH_RAD = (45 * Math.PI) / 180;
const THUMB_ELEVATION_RAD = (30 * Math.PI) / 180;
/**
 * How dark the farthest surface goes, as a fraction of THUMB_TOKEN: form must read without losing
 * contrast against `--panel-2`. Sampled off rendered thumbnails: nearest 7.3:1, farthest 3.9-4.6:1
 * by depth span. (A review's 2.5:1 was the linear/sRGB bug below, not this constant.)
 *
 * 0.7 has headroom against the 3:1 floor now but not on the accent it was tuned against (hubcap
 * farthest 2.9:1). Lowering it costs far-end contrast first; re-run the live check if it moves.
 */
const NEAR_FAR_FLOOR = 0.7;

/**
 * Cache key: what the silhouette depends on. Filters on renderSilhouette()'s own condition,
 * `positions && loaded`, and that pairing is load-bearing: parts.ts sets `positions` before `loaded`
 * across an await, so a key counting a part the render skips could cache a thumbnail that never updates.
 */
export function thumbKey(): string | null {
  const kind = currentAssemblyKind();
  if (!kind) return null;
  const loaded = state.assembly.parts.filter((p) => p.positions && p.loaded);
  if (!loaded.length) return null;
  return [
    kind.id,
    currentVariantId() ?? '-',
    // A part's identity here is its mesh size and position — what a re-pack or variant swap changes.
    ...loaded.map((p) => `${p.id}:${p.positions!.length}:${p.pivotX},${p.pivotZ},${p.angleDeg}`),
  ].join('|');
}

let cacheKey: string | null = null;
let cacheCanvas: HTMLCanvasElement | null = null;

/**
 * Target to camera for the thumbnail: the fixed three-quarter angle above, applied to whichever way
 * the kind's front points once `displayQuaternionFor` has posed it.
 *
 * Fixed *relative to the part*: a kind with a displayFrame is turned so its front faces −Y, while a
 * plate-like kind is posed by "design face is a Y-plane" with its camera side at +Y
 * (scene/displayFrame.ts). One world vector would show one family its front and the other its back.
 */
export function thumbViewDir(kind: AssemblyKind | null | undefined): THREE.Vector3 {
  const front = new THREE.Vector3(0, kind?.displayFrame ? -1 : 1, 0);
  const up = new THREE.Vector3(0, 0, 1);
  const side = new THREE.Vector3().crossVectors(up, front);
  return front
    .multiplyScalar(Math.cos(THUMB_ELEVATION_RAD) * Math.cos(THUMB_AZIMUTH_RAD))
    .addScaledVector(side, Math.cos(THUMB_ELEVATION_RAD) * Math.sin(THUMB_AZIMUTH_RAD))
    .addScaledVector(up, Math.sin(THUMB_ELEVATION_RAD))
    .normalize();
}

/**
 * World matrix for one part, matching `asmPartTransformGroup` in the viewport: a duplicate is
 * pivot-rotated into position, a primary left alone. Without it the wheel's two Top halves overlap
 * and the silhouette lies about the part on screen.
 */
export function partMatrix(
  pivotX: number,
  pivotZ: number,
  angleDeg: number,
  dup: boolean,
): THREE.Matrix4 {
  if (!dup) return new THREE.Matrix4();
  return new THREE.Matrix4()
    .makeTranslation(pivotX, 0, pivotZ)
    .multiply(new THREE.Matrix4().makeRotationY((-angleDeg * Math.PI) / 180))
    .multiply(new THREE.Matrix4().makeTranslation(-pivotX, 0, -pivotZ));
}

/**
 * Fill one triangle into a nearest-depth buffer, by half-plane test over its pixel bounding box.
 *
 * Depth rather than a flat mask so the picture has form (a binary chair mask is a blue blob), at one
 * comparison per covered pixel. Depth needs a view with depth in it: face-on to a disc the whole
 * range came from the view's own tilt, which made the wheel and hubcap the same picture.
 *
 * At thumbnail scale almost every triangle covers under a pixel, so it's effectively a point plot
 * and the whole chair (368k) takes a few ms. The few large triangles are why it's a real
 * rasterization, not a bounding-box fill, which would square off every flat face.
 * `z` is distance toward the viewer, so nearer is larger.
 */
function fillTriangle(
  depth: Float32Array,
  w: number,
  h: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): void {
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)));
  if (x1 < x0 || y1 < y0) return;
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const put = (x: number, y: number, z: number): void => {
    const i = y * w + x;
    if (z > depth[i]) depth[i] = z;
  };
  if (area === 0) {
    // Degenerate after projection (edge-on sliver) but still outline: marked, not dropped, or silhouette edges get holes.
    put(
      Math.min(w - 1, Math.max(0, Math.round(ax))),
      Math.min(h - 1, Math.max(0, Math.round(ay))),
      Math.max(az, bz, cz),
    );
    return;
  }
  const inv = 1 / area;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5,
        py = y + 0.5;
      const u = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) * inv;
      const v = ((px - ax) * (cy - ay) - (py - ay) * (cx - ax)) * inv;
      if (u >= 0 && v >= 0 && u + v <= 1) put(x, y, az + u * (cz - az) + v * (bz - az));
    }
  }
}

/**
 * The current assembly's silhouette as a canvas, or null when no part has a mesh yet.
 * Orthographic on purpose: at 30px perspective buys nothing but a slight keystone on the chair.
 */
function renderSilhouette(): HTMLCanvasElement | null {
  const kind = currentAssemblyKind();
  const parts = state.assembly.parts.filter((p) => p.positions && p.loaded);
  if (!kind || !parts.length) return null;

  const q = displayQuaternionFor(kind);
  const dir = thumbViewDir(kind);
  // Same camera basis as fitDistance() in viewport.ts, so the thumbnail is the view the part opens at, not a second derived angle.
  const worldUp = new THREE.Vector3(0, 0, 1);
  const right = new THREE.Vector3().crossVectors(worldUp, dir);
  if (right.lengthSq() === 0) right.set(1, 0, 0);
  right.normalize();
  const up = new THREE.Vector3().crossVectors(dir, right).normalize();

  const { out: outPx, buffer: px } = thumbPixelSizes();
  const pts: Float32Array[] = [];
  let minU = Infinity,
    maxU = -Infinity,
    minV = Infinity,
    maxV = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  const v = new THREE.Vector3();
  for (const part of parts) {
    const m = partMatrix(part.pivotX, part.pivotZ, part.angleDeg, !!part.isDuplicateOf);
    const pos = part.positions!;
    const uvz = new Float32Array(pos.length);
    for (let i = 0; i < pos.length; i += 3) {
      v.set(pos[i], pos[i + 1], pos[i + 2])
        .applyMatrix4(m)
        .applyQuaternion(q);
      const u = v.dot(right),
        w2 = v.dot(up),
        z = v.dot(dir);
      uvz[i] = u;
      uvz[i + 1] = w2;
      uvz[i + 2] = z;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (w2 < minV) minV = w2;
      if (w2 > maxV) maxV = w2;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    pts.push(uvz);
  }
  const spanU = maxU - minU,
    spanV = maxV - minV;
  if (!(spanU > 0) || !(spanV > 0)) return null;
  const scale = (px * FILL) / Math.max(spanU, spanV);
  const offX = px / 2 - ((minU + maxU) / 2) * scale;
  // Screen y runs down; the projected v axis runs up.
  const offY = px / 2 + ((minV + maxV) / 2) * scale;

  const depth = new Float32Array(px * px).fill(-Infinity);
  for (const uvz of pts) {
    for (let k = 0; k < uvz.length; k += 9) {
      fillTriangle(
        depth,
        px,
        px,
        uvz[k] * scale + offX,
        offY - uvz[k + 1] * scale,
        uvz[k + 2],
        uvz[k + 3] * scale + offX,
        offY - uvz[k + 4] * scale,
        uvz[k + 5],
        uvz[k + 6] * scale + offX,
        offY - uvz[k + 7] * scale,
        uvz[k + 8],
      );
    }
  }

  const fill = getComputedStyle(document.documentElement).getPropertyValue(THUMB_TOKEN).trim();
  const big = document.createElement('canvas');
  big.width = px;
  big.height = px;
  const bctx = big.getContext('2d');
  if (!bctx) return null;
  const img = bctx.createImageData(px, px);
  // Read the token back through the 2D context, not THREE.Color: THREE converts sRGB to linear on
  // construction (three >= r155), right for a material and wrong for ImageData — the accent came out
  // as rgb(39,74,254) against a token of #6d93ff, darker, more saturated, 2.5:1 against the tile
  // instead of 5.6:1. Assigning to fillStyle also normalises any CSS colour form to #rrggbb.
  bctx.fillStyle = fill || THUMB_FALLBACK;
  const hex = String(bctx.fillStyle);
  const r8 = parseInt(hex.slice(1, 3), 16),
    g8 = parseInt(hex.slice(3, 5), 16),
    b8 = parseInt(hex.slice(5, 7), 16);
  // Depth to brightness, nearest at the full token, farthest at NEAR_FAR_FLOOR of it; one hue so it reads as chrome, not a tiny render.
  const spanZ = maxZ - minZ || 1;
  for (let i = 0; i < depth.length; i++) {
    // Uncovered pixels stay transparent but keep the fill RGB: at 0,0,0 the browser's downscale
    // blends every edge toward black (measured in the accent, #2546f1 against a token of #6d93ff, 2.3:1).
    img.data[i * 4] = r8;
    img.data[i * 4 + 1] = g8;
    img.data[i * 4 + 2] = b8;
    if (depth[i] === -Infinity) continue;
    const t = NEAR_FAR_FLOOR + (1 - NEAR_FAR_FLOOR) * ((depth[i] - minZ) / spanZ);
    img.data[i * 4] = Math.round(r8 * t);
    img.data[i * 4 + 1] = Math.round(g8 * t);
    img.data[i * 4 + 2] = Math.round(b8 * t);
    img.data[i * 4 + 3] = 255;
  }
  bctx.putImageData(img, 0, 0);

  const out = document.createElement('canvas');
  out.width = outPx;
  out.height = outPx;
  out.style.width = `${THUMB_CSS_PX}px`;
  out.style.height = `${THUMB_CSS_PX}px`;
  const octx = out.getContext('2d');
  if (!octx) return null;
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(big, 0, 0, outPx, outPx);
  drawEdge(octx, depth, px, outPx, r8, g8, b8);
  return out;
}

/**
 * Resolve the silhouette's boundary onto the device grid and outline it, over the downscaled fill.
 *
 * The fill comes through a supersampled buffer for smooth interior shading, but a boundary arriving
 * that way is a partial-alpha ramp whatever the sample count (the filter's footprint sets the width;
 * measured on shipped thumbnails, 2.1 device pixels at every ratio). At 30px a mark reads as sharp
 * when its boundary is defined, hence outlines.
 *
 * So the boundary is decided here at device resolution from the same supersamples: a device pixel
 * is in when half its samples are covered, and the outermost ring of in-pixels is painted at full
 * accent. Alpha is binary, so the transition is one pixel by construction.
 *
 * Tradeoff: a binary boundary steps where a ramp blends, acceptable because only the boundary is
 * binary and the shaded interior still arrives through the 4x downscale — a 1px contour on a smooth
 * form, not pixel art.
 */
function drawEdge(
  ctx: CanvasRenderingContext2D,
  depth: Float32Array,
  px: number,
  outPx: number,
  r8: number,
  g8: number,
  b8: number,
): void {
  const cov = new Uint8Array(outPx * outPx);
  const half = (SUPERSAMPLE * SUPERSAMPLE) / 2;
  for (let y = 0; y < outPx; y++) {
    for (let x = 0; x < outPx; x++) {
      let n = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        const row = (y * SUPERSAMPLE + sy) * px + x * SUPERSAMPLE;
        for (let sx = 0; sx < SUPERSAMPLE; sx++) if (depth[row + sx] !== -Infinity) n++;
      }
      cov[y * outPx + x] = n >= half ? 1 : 0;
    }
  }
  // Out of bounds counts as outside, so a silhouette running off the box is outlined along it.
  const inside = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < outPx && y < outPx && cov[y * outPx + x] === 1;

  const img = ctx.getImageData(0, 0, outPx, outPx);
  for (let y = 0; y < outPx; y++) {
    for (let x = 0; x < outPx; x++) {
      const i = (y * outPx + x) * 4;
      if (!inside(x, y)) {
        // Clearing the fill's own ramp makes the outline the boundary; left in, it's a soft halo outside a hard line.
        img.data[i + 3] = 0;
        continue;
      }
      img.data[i + 3] = 255;
      if (!inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1)) {
        img.data[i] = r8;
        img.data[i + 1] = g8;
        img.data[i + 2] = b8;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Put the current part's silhouette in `#shape-thumb`, or leave it empty until a mesh exists. Cached on what the picture depends on: the parts-changed hook fires several times while an assembly loads. */
export function refreshShapeThumb(): void {
  const el = $('#shape-thumb');
  if (!el) return;
  const key = thumbKey();
  if (!key) {
    el.innerHTML = '';
    cacheKey = null;
    return;
  }
  if (key !== cacheKey || !cacheCanvas) {
    cacheCanvas = renderSilhouette();
    cacheKey = cacheCanvas ? key : null;
  }
  el.innerHTML = '';
  if (cacheCanvas) el.appendChild(cacheCanvas);
}
