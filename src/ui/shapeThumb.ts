import * as THREE from 'three';
import { state } from '../state/store';
import { currentAssemblyKind, currentVariantId } from '../assembly/kinds';
import { displayQuaternionFor } from '../scene/displayFrame';
import type { AssemblyKind } from '../types';
import { $ } from './dom';

/**
 * The part thumbnail beside the Part dropdown, drawn from the part's own mesh.
 *
 * It used to be one of five hand-authored SVG glyphs picked by `designFit`, which describes how
 * artwork is fitted rather than what the part looks like — three of the four kinds carry
 * `designFit: 'rect'`, so the footrest, the hubcap and the chair all showed the same rectangle.
 * The design system rules out fixing that with a bigger glyph set ("don't hand-draw SVG icons",
 * `design-system/README.md` → Iconography; convention 32 of docs/ui-conventions.md says the same
 * and names a mesh-rendered thumbnail as the in-system answer). A silhouette is also the only
 * version that cannot go stale: re-pack a part and the picture follows.
 */

/** Rendered box in CSS px — matches what the SVG glyphs occupied inside `.shape-thumb`. */
const THUMB_CSS_PX = 30;
/**
 * Supersampling factor for the silhouette mask before it is scaled into the box. Rasterizing at
 * the final size gives a hard-edged, visibly stepped outline at 30px; 4x costs a browser downscale
 * and is what makes the edge read as a part rather than as pixel art.
 *
 * It multiplies the *device* pixel size, not the CSS one. Sized off CSS px it was a real 4x only
 * on a 1x display: at devicePixelRatio 1.5 the same 120px buffer landed on a 45px backing store,
 * a 2.67x downscale, and the extra softness that buys is the whole difference — the backing store
 * itself was never undersized (45 = 30 x 1.5, drawn 1:1), so interpolation was not the problem.
 */
const SUPERSAMPLE = 4;
/**
 * Device pixels per CSS pixel, for both the backing store and the buffer above. Unclamped: the
 * cost is a Float32Array of (30 x dpr x 4)^2 that is cached on `thumbKey()`, 129600 entries even
 * at dpr 3, and clamping it is the same undersized-backing-store bug this comment describes,
 * just moved to a rarer display.
 */
const dpr = (): number => (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) || 1;

/**
 * The two pixel sizes a render uses: the canvas backing store, and the mask buffer behind it.
 *
 * Exported so both can be asserted without a 2D canvas — the live check
 * (scripts/check-part-thumbnails.mjs) can read the backing store off the real page, but the
 * buffer is internal, and it is the size this whole path is about.
 */
export function thumbPixelSizes(ratio: number = dpr()): { out: number; buffer: number } {
  const out = Math.round(THUMB_CSS_PX * ratio);
  return { out, buffer: out * SUPERSAMPLE };
}
/** Fraction of the box the silhouette's longer axis fills, leaving the glyphs' own optical margin. */
const FILL = 0.86;
/**
 * The thumbnail's camera, as an angle around and above the part's front. One fixed pair for every
 * kind, which is what keeps four thumbnails comparable to each other rather than four separately
 * flattering portraits — and is why every CAD tool's part thumbnails look alike.
 *
 * It is deliberately not the angle the viewport opens at, which it used to be. That view is nearly
 * face-on to a plate kind's design face (21° off it), and face-on is exactly the view that cannot
 * distinguish a 60mm-thick wheel from a 3mm hubcap: the outline is the same circle, and the depth
 * range across it is dominated by the view's own tilt, so there is nothing left for shading to
 * shade. Measured on the shipped thumbnails, the two silhouettes overlapped to within 4.5%. From
 * 45°/30° — 52° off the face — a cylinder and a disc are unmistakable, and the same 4.5% becomes
 * 13.2%, a number the live check can hold a bar against (scripts/check-part-thumbnails.mjs).
 *
 * The alternative on the table was shading by surface normal instead of by depth. It was not the
 * fix: the two parts had the same *outline*, and no shading model changes an outline. Angle was
 * the only lever that could.
 */
const THUMB_AZIMUTH_RAD = (45 * Math.PI) / 180;
const THUMB_ELEVATION_RAD = (30 * Math.PI) / 180;
/**
 * How dark the farthest surface goes, as a fraction of the accent. The shading has to read as form
 * without dropping the silhouette's contrast against the `--panel-2` tile behind it. Sampled off
 * the rendered thumbnails: nearest 5.2:1, farthest 3.4:1. (The 2.5:1 a review measured before this
 * was the linear/sRGB bug below, not this constant — the whole silhouette was too dark, gradient
 * and all.)
 */
const NEAR_FAR_FLOOR = 0.7;

/**
 * Cache key: what the silhouette actually depends on.
 *
 * Filters on the same condition renderSilhouette() does, `positions && loaded`, and that pairing
 * is load-bearing — parts.ts sets `positions` before `loaded` across an await, so a key that
 * counted a part the render skips could cache a thumbnail that never updates again.
 */
export function thumbKey(): string | null {
  const kind = currentAssemblyKind();
  if (!kind) return null;
  const loaded = state.assembly.parts.filter((p) => p.positions && p.loaded);
  if (!loaded.length) return null;
  return [
    kind.id,
    currentVariantId() ?? '-',
    // A part's identity for this purpose is its mesh size and where it sits, which is what a
    // re-pack or a variant swap changes.
    ...loaded.map((p) => `${p.id}:${p.positions!.length}:${p.pivotX},${p.pivotZ},${p.angleDeg}`),
  ].join('|');
}

let cacheKey: string | null = null;
let cacheCanvas: HTMLCanvasElement | null = null;

/**
 * Target → camera for the thumbnail: the fixed three-quarter angle above, applied to whichever way
 * the kind's front points once `displayQuaternionFor` has posed it.
 *
 * "A single fixed angle" has to mean fixed *relative to the part*, because the two families of
 * kind are already posed by different conventions and neither is negotiable here: a kind with a
 * displayFrame has been turned so its front faces −Y, while a plate-like kind is posed by the
 * "design face is a Y-plane" rule and its camera side is +Y (scene/displayFrame.ts). One world
 * vector for both would show one family its front and the other its back — the hub face of the
 * wheel, say, seen from behind. Same angle off the front for everyone is the thing that makes four
 * thumbnails read as one set.
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
 * World matrix for one part, matching what `asmPartTransformGroup` builds in the viewport: a
 * duplicate is pivot-rotated into its real position, a primary is left alone. Without this the
 * wheel's two Top halves would draw on top of each other and the silhouette would be a lie about
 * a part the user is looking at.
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
 * Depth rather than a flat silhouette so the picture has some form: a binary mask of the chair is
 * a blue blob, and the shading is what makes the seat read as a seat. It costs one comparison per
 * covered pixel.
 *
 * Depth needs a view with depth in it to be worth anything: face-on to a disc the whole range came
 * from the view's own tilt, which is why the wheel and the hubcap used to be the same picture. The
 * three-quarter camera above is what gives this something to shade.
 *
 * At thumbnail scale almost every triangle of a real part covers less than a pixel, so this is
 * effectively a point plot per triangle and the whole chair (368k) is a few milliseconds. The few
 * large triangles are the reason it is a real rasterization and not a bounding-box fill, which
 * would square off every flat face's silhouette.
 *
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
    // Degenerate after projection (an edge-on sliver). Still part of the outline, so mark its
    // pixel rather than dropping it — dropped slivers punch holes along every silhouette edge.
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
 *
 * Orthographic rather than perspective on purpose: this is an icon at 30px, and a perspective
 * projection at that size buys nothing but a slight keystone on the chair.
 */
function renderSilhouette(): HTMLCanvasElement | null {
  const kind = currentAssemblyKind();
  const parts = state.assembly.parts.filter((p) => p.positions && p.loaded);
  if (!kind || !parts.length) return null;

  const q = displayQuaternionFor(kind);
  const dir = thumbViewDir(kind);
  // The camera's own basis, same construction as fitDistance() in viewport.ts, so the thumbnail is
  // the view the part opens at rather than a second, differently-derived angle.
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

  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const big = document.createElement('canvas');
  big.width = px;
  big.height = px;
  const bctx = big.getContext('2d');
  if (!bctx) return null;
  const img = bctx.createImageData(px, px);
  // Read the accent back through the 2D context rather than through THREE.Color. THREE converts
  // sRGB to linear on construction (three >= r155 colour management), which is right for a
  // material and wrong for ImageData: `--accent` #6d93ff came out as rgb(39,74,254) — darker and
  // far more saturated than the token, and 2.5:1 against the tile instead of the 5.6:1 the token
  // itself gets. Assigning to fillStyle also normalises any CSS colour form to #rrggbb.
  bctx.fillStyle = accent || '#6d93ff';
  const hex = String(bctx.fillStyle);
  const r8 = parseInt(hex.slice(1, 3), 16),
    g8 = parseInt(hex.slice(3, 5), 16),
    b8 = parseInt(hex.slice(5, 7), 16);
  // Depth to brightness, nearest at full accent and farthest at NEAR_FAR_FLOOR of it. One hue
  // throughout, so the thumbnail still reads as accent chrome rather than as a tiny render.
  const spanZ = maxZ - minZ || 1;
  for (let i = 0; i < depth.length; i++) {
    // Uncovered pixels stay transparent but keep the accent RGB. Leaving them at 0,0,0 makes the
    // browser's downscale blend every edge toward black, which darkens and over-saturates the
    // whole silhouette — sampled off the rendered thumbnail at #2546f1 against an accent of
    // #6d93ff, and only 2.3:1 against the tile behind it.
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
  return out;
}

/**
 * Put the current part's silhouette in `#shape-thumb`, or leave the box empty until a mesh exists.
 *
 * Cached on what the picture depends on, because it is called from the parts-changed hook, which
 * fires several times while an assembly loads.
 */
export function refreshShapeThumb(): void {
  const el = $('#shape-thumb');
  if (!el) return;
  // Not our box to touch outside assembly mode: the flat kinds keep their glyph, which
  // setShapeThumb has already painted. Clearing here instead emptied it whenever a part finished
  // loading after the user had switched away — start a 13-part chair, pick Disc, and the next
  // per-part notification wiped the disc.
  if (state.shapeKind !== 'assembly') return;
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
