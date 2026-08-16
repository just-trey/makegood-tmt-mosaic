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
 * artwork is fitted rather than what the part looks like: three of the four kinds carry
 * `designFit: 'rect'`, so the footrest, hubcap and chair all showed the same rectangle. The design
 * system rules out a bigger glyph set ("don't hand-draw SVG icons", `design-system/README.md`
 * Iconography; convention 32 of docs/ui-conventions.md names a mesh-rendered thumbnail as the
 * in-system answer). A silhouette also cannot go stale: re-pack a part and the picture follows.
 */

/** Rendered box in CSS px, matching what the SVG glyphs occupied inside `.shape-thumb`. */
const THUMB_CSS_PX = 30;
/**
 * Supersampling factor for the silhouette mask before it is scaled into the box.
 *
 * What it buys is the *interior*: depth shading across a form arrives as a smooth gradient rather
 * than one flat value per device pixel. It no longer sets the boundary, which drawEdge() resolves
 * on the device grid, because a downscaled boundary ramps over roughly two device pixels whatever
 * the sample count.
 *
 * It multiplies the *device* pixel size, not the CSS one. Sized off CSS px it was a real 4x only
 * on a 1x display: at devicePixelRatio 1.5 the same 120px buffer landed on a 45px backing store, a
 * 2.67x downscale, and that extra softness is the whole difference. The backing store itself was
 * never undersized (45 = 30 x 1.5, drawn 1:1), so interpolation was not the problem.
 */
const SUPERSAMPLE = 4;
/**
 * Device pixels per CSS pixel, for the backing store and the buffer above. Unclamped: the cost is
 * a Float32Array of (30 x dpr x 4)^2 cached on `thumbKey()`, 129600 entries even at dpr 3, and
 * clamping it is the same undersized-backing-store bug above, moved to a rarer display.
 */
const dpr = (): number => (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) || 1;

/**
 * The two pixel sizes a render uses: the canvas backing store, and the mask buffer behind it.
 *
 * Exported so both can be asserted without a 2D canvas. The live check
 * (scripts/check-part-thumbnails.mjs) reads the backing store off the real page, but the buffer is
 * internal, and it is the size this whole path is about.
 */
export function thumbPixelSizes(ratio: number = dpr()): { out: number; buffer: number } {
  const out = Math.round(THUMB_CSS_PX * ratio);
  return { out, buffer: out * SUPERSAMPLE };
}
/** Fraction of the box the silhouette's longer axis fills, leaving the glyphs' own optical margin. */
const FILL = 0.86;
/**
 * The token the silhouette is painted in, and the hex to fall back to if it ever reads empty.
 *
 * Neutral, not `--accent`, and a decision rather than a default. Convention 19 of
 * docs/ui-conventions.md reserves the accent hue for selection, since blue is also a filament a
 * user owns, and this thumbnail sits beside the Part dropdown where an accent-filled picture reads
 * as "this one is selected" rather than "this is the part". The counter-argument (it is chrome
 * describing the part, not a selection affordance) was put to the maintainer and lost.
 *
 * It is also the more legible of the two, which was not expected. Both measured off rendered
 * pixels against the `--panel-2` tile, same camera and same edge treatment:
 *
 *   --text-dim  7.3:1 nearest (every kind), 3.9-4.6:1 farthest
 *   --accent    5.3:1 nearest, 2.9-3.5:1 farthest
 *
 * The accent's farthest surface on the hubcap is 2.9:1, under WCAG's 3:1 non-text minimum, on two
 * of six measurements. So the rule and the measurement agree rather than trading off.
 * The live check re-measures every run and holds the 3:1 bar (scripts/check-part-thumbnails.mjs).
 */
const THUMB_TOKEN = '--text-dim';
const THUMB_FALLBACK = '#aab3cf';
/**
 * The thumbnail's camera, as an angle around and above the part's front. One fixed pair for every
 * kind, which keeps four thumbnails comparable rather than four separately flattering portraits,
 * and is why every CAD tool's part thumbnails look alike.
 *
 * Deliberately not the angle the viewport opens at, which it used to be. That view is nearly
 * face-on to a plate kind's design face (21° off), and face-on cannot distinguish a 60mm-thick
 * wheel from a 3mm hubcap: same circular outline, and the depth range across it is dominated by
 * the view's own tilt, leaving nothing to shade. Measured on the shipped thumbnails, the two
 * silhouettes overlapped to within 4.5%. From 45°/30°, 52° off the face, a cylinder and a disc are
 * unmistakable and the same figure becomes 13.2%, a bar the live check can hold
 * (scripts/check-part-thumbnails.mjs).
 *
 * Shading by surface normal instead of depth was proposed and rejected: the two parts had the same
 * *outline*, and no shading model changes an outline. Angle was the only lever.
 */
const THUMB_AZIMUTH_RAD = (45 * Math.PI) / 180;
const THUMB_ELEVATION_RAD = (30 * Math.PI) / 180;
/**
 * How dark the farthest surface goes, as a fraction of THUMB_TOKEN. The shading must read as form
 * without dropping the silhouette's contrast against the `--panel-2` tile. Sampled off the
 * rendered thumbnails: nearest 7.3:1, farthest 3.9-4.6:1 depending on the kind's depth span. (The
 * 2.5:1 a review once measured was the linear/sRGB bug below, not this constant: the whole
 * silhouette was too dark, gradient and all.)
 *
 * 0.7 has headroom against the 3:1 floor now but did not on the accent it was tuned against, where
 * the hubcap's farthest surface came out at 2.9:1. Lowering it costs contrast at the far end
 * first, so the live check is the thing to re-run if it ever moves.
 */
const NEAR_FAR_FLOOR = 0.7;

/**
 * Cache key: what the silhouette actually depends on.
 *
 * Filters on the same condition renderSilhouette() does, `positions && loaded`, and that pairing
 * is load-bearing: parts.ts sets `positions` before `loaded` across an await, so a key counting a
 * part the render skips could cache a thumbnail that never updates again.
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
 * Target to camera for the thumbnail: the fixed three-quarter angle above, applied to whichever
 * way the kind's front points once `displayQuaternionFor` has posed it.
 *
 * "A single fixed angle" must mean fixed *relative to the part*, because the two families of kind
 * are posed by different conventions and neither is negotiable: a kind with a displayFrame is
 * turned so its front faces −Y, while a plate-like kind is posed by the "design face is a Y-plane"
 * rule with its camera side at +Y (scene/displayFrame.ts). One world vector for both would show
 * one family its front and the other its back. Same angle off the front for everyone is what makes
 * four thumbnails read as one set.
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
 * duplicate is pivot-rotated into its real position, a primary left alone. Without it the wheel's
 * two Top halves draw on top of each other, and the silhouette lies about the part on screen.
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
 * Depth rather than a flat silhouette, so the picture has form: a binary mask of the chair is a
 * blue blob, and shading is what makes the seat read as a seat. Costs one comparison per covered
 * pixel.
 *
 * Depth needs a view with depth in it: face-on to a disc the whole range came from the view's own
 * tilt, which is why the wheel and hubcap used to be the same picture. The three-quarter camera
 * above is what gives this something to shade.
 *
 * At thumbnail scale almost every triangle covers less than a pixel, so this is effectively a
 * point plot per triangle and the whole chair (368k) takes a few milliseconds. The few large
 * triangles are why it is a real rasterization and not a bounding-box fill, which would square off
 * every flat face's silhouette.
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
    // pixel rather than dropping it: dropped slivers punch holes along every silhouette edge.
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

  const fill = getComputedStyle(document.documentElement).getPropertyValue(THUMB_TOKEN).trim();
  const big = document.createElement('canvas');
  big.width = px;
  big.height = px;
  const bctx = big.getContext('2d');
  if (!bctx) return null;
  const img = bctx.createImageData(px, px);
  // Read the token back through the 2D context, not THREE.Color. THREE converts sRGB to linear on
  // construction (three >= r155 colour management), right for a material and wrong for ImageData:
  // the accent this used to draw in came out as rgb(39,74,254) against a token of #6d93ff, darker
  // and far more saturated, at 2.5:1 against the tile instead of 5.6:1. Assigning to fillStyle
  // also normalises any CSS colour form to #rrggbb.
  bctx.fillStyle = fill || THUMB_FALLBACK;
  const hex = String(bctx.fillStyle);
  const r8 = parseInt(hex.slice(1, 3), 16),
    g8 = parseInt(hex.slice(3, 5), 16),
    b8 = parseInt(hex.slice(5, 7), 16);
  // Depth to brightness, nearest at the full token and farthest at NEAR_FAR_FLOOR of it. One hue
  // throughout, so the thumbnail reads as chrome rather than a tiny render.
  const spanZ = maxZ - minZ || 1;
  for (let i = 0; i < depth.length; i++) {
    // Uncovered pixels stay transparent but keep the fill RGB. At 0,0,0 the browser's downscale
    // blends every edge toward black, darkening and over-saturating the whole silhouette: measured
    // when this drew in the accent, at #2546f1 against a token of #6d93ff, 2.3:1 against the tile.
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
 * The fill must come through a supersampled buffer, which is what gives the interior its smooth
 * depth shading, but a boundary arriving the same way is a ramp of partial alpha whatever the
 * sample count: the downscale filter's footprint sets its width, not the sampling. Measured on the
 * shipped thumbnails it ramped over 2.1 device pixels at every ratio. At 30px a mark reads as
 * sharp when its boundary is defined, which is why icons are outlined.
 *
 * So the boundary is decided here at device resolution, from the same supersamples the fill was
 * averaged from: a device pixel is in when half its samples are covered, and the outermost ring of
 * in-pixels is painted at full accent. Alpha is binary, so the transition is one pixel wide by
 * construction rather than by tuning.
 *
 * The tradeoff is real and was why the supersample went in: a binary boundary steps where a ramped
 * one blends. It is acceptable because only the boundary is binary, the shaded interior still
 * arriving through the 4x downscale, so the steps are a 1px contour on a smooth form rather than
 * the whole silhouette as pixel art.
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
  // Out of bounds counts as outside, so a silhouette running off the edge of the box is outlined
  // along it rather than left open.
  const inside = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < outPx && y < outPx && cov[y * outPx + x] === 1;

  const img = ctx.getImageData(0, 0, outPx, outPx);
  for (let y = 0; y < outPx; y++) {
    for (let x = 0; x < outPx; x++) {
      const i = (y * outPx + x) * 4;
      if (!inside(x, y)) {
        // Clearing the fill's own ramp is what makes the outline the boundary. Left in place it
        // reads as a soft halo outside a hard line: the ramp with a line drawn on it, no sharper.
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

/**
 * Put the current part's silhouette in `#shape-thumb`, or leave the box empty until a mesh exists.
 *
 * Cached on what the picture depends on, because it is called from the parts-changed hook, which
 * fires several times while an assembly loads.
 */
export function refreshShapeThumb(): void {
  const el = $('#shape-thumb');
  if (!el) return;
  // Not our box to touch outside assembly mode: flat kinds keep the glyph setShapeThumb painted.
  // Clearing here emptied it whenever a part finished loading after the user switched away. Start
  // a 13-part chair, pick Disc, and the next per-part notification wiped the disc.
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
