import * as THREE from 'three';
import { state } from '../state/store';
import { currentAssemblyKind, currentVariantId } from '../assembly/kinds';
import { assemblyViewDir, displayQuaternionFor } from '../scene/displayFrame';
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
 * the final size gives a hard-edged, visibly stepped outline at 30px; 4x costs a 120px buffer and
 * a browser downscale, and is what makes the edge read as a part rather than as pixel art.
 */
const SUPERSAMPLE = 4;
/** Fraction of the box the silhouette's longer axis fills, leaving the glyphs' own optical margin. */
const FILL = 0.86;
/** How dark the farthest surface goes, as a fraction of the accent. Below ~0.4 it reads as a hole. */
const NEAR_FAR_FLOOR = 0.45;

/** Cache key: what the silhouette actually depends on. */
function thumbKey(): string | null {
  const kind = currentAssemblyKind();
  if (!kind) return null;
  const loaded = state.assembly.parts.filter((p) => p.positions);
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
 * World matrix for one part, matching what `asmPartTransformGroup` builds in the viewport: a
 * duplicate is pivot-rotated into its real position, a primary is left alone. Without this the
 * wheel's two Top halves would draw on top of each other and the silhouette would be a lie about
 * a part the user is looking at.
 */
function partMatrix(pivotX: number, pivotZ: number, angleDeg: number, dup: boolean): THREE.Matrix4 {
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
 * What it does NOT do, measured on the shipped thumbnails: separate the wheel from the hubcap.
 * Both are discs seen nearly face-on, so their depth range is dominated by the view's own tilt
 * rather than by any feature, and the hub boss and the mounting clips are a few millimetres
 * against a 220–280mm diameter — under a pixel of gradient. Telling those two apart needs surface
 * normals, not depth. See docs/tech-debt.md.
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
 * The current assembly's silhouette as a canvas, from the same viewpoint the viewport opens at, or
 * null when no part has a mesh yet.
 *
 * Orthographic rather than perspective on purpose: this is an icon at 30px, and a perspective
 * projection at that size buys nothing but a slight keystone on the chair.
 */
function renderSilhouette(): HTMLCanvasElement | null {
  const kind = currentAssemblyKind();
  const parts = state.assembly.parts.filter((p) => p.positions && p.loaded);
  if (!kind || !parts.length) return null;

  const q = displayQuaternionFor(kind);
  const dir = assemblyViewDir(kind, 1).normalize();
  // The camera's own basis, same construction as fitDistance() in viewport.ts, so the thumbnail is
  // the view the part opens at rather than a second, differently-derived angle.
  const worldUp = new THREE.Vector3(0, 0, 1);
  const right = new THREE.Vector3().crossVectors(worldUp, dir);
  if (right.lengthSq() === 0) right.set(1, 0, 0);
  right.normalize();
  const up = new THREE.Vector3().crossVectors(dir, right).normalize();

  const px = THUMB_CSS_PX * SUPERSAMPLE;
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
  const rgb = new THREE.Color(accent || '#6d93ff');
  const big = document.createElement('canvas');
  big.width = px;
  big.height = px;
  const bctx = big.getContext('2d');
  if (!bctx) return null;
  const img = bctx.createImageData(px, px);
  const r8 = Math.round(rgb.r * 255),
    g8 = Math.round(rgb.g * 255),
    b8 = Math.round(rgb.b * 255);
  // Depth to brightness, nearest at full accent and farthest at NEAR_FAR_FLOOR of it. One hue
  // throughout, so the thumbnail still reads as accent chrome rather than as a tiny render.
  const spanZ = maxZ - minZ || 1;
  for (let i = 0; i < depth.length; i++) {
    if (depth[i] === -Infinity) continue;
    const t = NEAR_FAR_FLOOR + (1 - NEAR_FAR_FLOOR) * ((depth[i] - minZ) / spanZ);
    img.data[i * 4] = Math.round(r8 * t);
    img.data[i * 4 + 1] = Math.round(g8 * t);
    img.data[i * 4 + 2] = Math.round(b8 * t);
    img.data[i * 4 + 3] = 255;
  }
  bctx.putImageData(img, 0, 0);

  const dpr = Math.min(devicePixelRatio || 1, 2);
  const out = document.createElement('canvas');
  out.width = Math.round(THUMB_CSS_PX * dpr);
  out.height = Math.round(THUMB_CSS_PX * dpr);
  out.style.width = `${THUMB_CSS_PX}px`;
  out.style.height = `${THUMB_CSS_PX}px`;
  const octx = out.getContext('2d');
  if (!octx) return null;
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(big, 0, 0, out.width, out.height);
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
  if (state.shapeKind !== 'assembly') {
    el.innerHTML = '';
    cacheKey = null;
    return;
  }
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
