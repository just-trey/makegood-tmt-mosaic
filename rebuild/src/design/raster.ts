import { rgbToHex, rgbToLab } from './color';
import { ringsToMp, simplifyMp, type MultiPolygon, type Ring } from './poly';

export interface Quantized {
  /** Palette as #rrggbb, index = label. */
  palette: string[];
  /** Per pixel label, -1 for transparent. */
  labels: Int16Array;
  width: number;
  height: number;
}

/** True when the image looks like a photograph rather than flat art: many distinct colors. */
export function looksLikePhoto(rgba: Uint8ClampedArray, width: number, height: number): boolean {
  const seen = new Set<number>();
  const step = Math.max(1, Math.floor((width * height) / 20000));
  for (let i = 0; i < width * height; i += step) {
    const o = i * 4;
    if (rgba[o + 3] < 128) continue;
    seen.add(((rgba[o] >> 3) << 10) | ((rgba[o + 1] >> 3) << 5) | (rgba[o + 2] >> 3));
    if (seen.size > 600) return true;
  }
  return false;
}

function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/**
 * Reduce an image to `k` flat colors with k-means in Lab (so "similar" means similar to an eye,
 * not to a byte), seeded deterministically so the same image and slider give the same result.
 */
export function quantize(rgba: Uint8ClampedArray, width: number, height: number, k: number): Quantized {
  const n = width * height;
  const labs = new Float32Array(n * 3);
  const opaque = new Uint8Array(n);
  const samples: number[] = [];
  const rnd = seeded(12345);
  const sampleEvery = Math.max(1, Math.floor(n / 60000));
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (rgba[o + 3] < 128) continue;
    opaque[i] = 1;
    const lab = rgbToLab(rgba[o], rgba[o + 1], rgba[o + 2]);
    labs[i * 3] = lab[0];
    labs[i * 3 + 1] = lab[1];
    labs[i * 3 + 2] = lab[2];
    if (i % sampleEvery === 0) samples.push(i);
  }
  const labels = new Int16Array(n).fill(-1);
  if (samples.length === 0) return { palette: [], labels, width, height };
  k = Math.max(1, Math.min(k, 32, samples.length));
  // k-means++ seeding.
  const centers: number[][] = [];
  const first = samples[Math.floor(rnd() * samples.length)];
  centers.push([labs[first * 3], labs[first * 3 + 1], labs[first * 3 + 2]]);
  const d2 = new Float32Array(samples.length).fill(Infinity);
  while (centers.length < k) {
    const c = centers[centers.length - 1];
    let total = 0;
    for (let s = 0; s < samples.length; s++) {
      const i = samples[s] * 3;
      const d = (labs[i] - c[0]) ** 2 + (labs[i + 1] - c[1]) ** 2 + (labs[i + 2] - c[2]) ** 2;
      if (d < d2[s]) d2[s] = d;
      total += d2[s];
    }
    if (total === 0) break;
    let r = rnd() * total;
    let pick = samples[samples.length - 1];
    for (let s = 0; s < samples.length; s++) {
      r -= d2[s];
      if (r <= 0) {
        pick = samples[s];
        break;
      }
    }
    centers.push([labs[pick * 3], labs[pick * 3 + 1], labs[pick * 3 + 2]]);
  }
  const kk = centers.length;
  const sums = new Float64Array(kk * 3);
  const counts = new Int32Array(kk);
  const assign = (i: number): number => {
    const o = i * 3;
    let best = 0, bd = Infinity;
    for (let c = 0; c < kk; c++) {
      const d = (labs[o] - centers[c][0]) ** 2 + (labs[o + 1] - centers[c][1]) ** 2 + (labs[o + 2] - centers[c][2]) ** 2;
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  };
  for (let it = 0; it < 10; it++) {
    sums.fill(0);
    counts.fill(0);
    for (const i of samples) {
      const c = assign(i);
      sums[c * 3] += labs[i * 3];
      sums[c * 3 + 1] += labs[i * 3 + 1];
      sums[c * 3 + 2] += labs[i * 3 + 2];
      counts[c]++;
    }
    let moved = 0;
    for (let c = 0; c < kk; c++) {
      if (!counts[c]) continue;
      const nx = sums[c * 3] / counts[c], ny = sums[c * 3 + 1] / counts[c], nz = sums[c * 3 + 2] / counts[c];
      moved += Math.abs(nx - centers[c][0]) + Math.abs(ny - centers[c][1]) + Math.abs(nz - centers[c][2]);
      centers[c] = [nx, ny, nz];
    }
    if (moved < 0.05) break;
  }
  // Final assignment for every opaque pixel, then palette from the mean RGB of each label.
  const rgbSum = new Float64Array(kk * 3);
  const rgbCount = new Int32Array(kk);
  for (let i = 0; i < n; i++) {
    if (!opaque[i]) continue;
    const c = assign(i);
    labels[i] = c;
    const o = i * 4;
    rgbSum[c * 3] += rgba[o];
    rgbSum[c * 3 + 1] += rgba[o + 1];
    rgbSum[c * 3 + 2] += rgba[o + 2];
    rgbCount[c]++;
  }
  // Drop empty labels and renumber.
  const remap = new Int16Array(kk).fill(-1);
  const palette: string[] = [];
  for (let c = 0; c < kk; c++) {
    if (!rgbCount[c]) continue;
    remap[c] = palette.length;
    palette.push(rgbToHex(rgbSum[c * 3] / rgbCount[c], rgbSum[c * 3 + 1] / rgbCount[c], rgbSum[c * 3 + 2] / rgbCount[c]));
  }
  for (let i = 0; i < n; i++) if (labels[i] >= 0) labels[i] = remap[labels[i]];
  return { palette, labels, width, height };
}

/**
 * Reassign connected blobs smaller than `minPixels` to the label most common around their edge,
 * so a speck the nozzle could never print melts into what surrounds it instead of costing a
 * slot or a warning. Transparent stays transparent.
 */
export function despeckle(q: Quantized, minPixels: number): number {
  const { width: w, height: h, labels } = q;
  if (minPixels <= 1) return 0;
  const n = w * h;
  let removed = 0;
  for (let pass = 0; pass < 3; pass++) {
    const comp = new Int32Array(n).fill(-1);
    const sizes: number[] = [];
    const stack: number[] = [];
    let changed = 0;
    for (let start = 0; start < n; start++) {
      if (comp[start] >= 0 || labels[start] < 0) continue;
      const id = sizes.length;
      const lab = labels[start];
      const members: number[] = [];
      stack.push(start);
      comp[start] = id;
      while (stack.length) {
        const i = stack.pop()!;
        members.push(i);
        const x = i % w, y = (i - x) / w;
        const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
        for (const j of nb) if (j >= 0 && comp[j] < 0 && labels[j] === lab) {
          comp[j] = id;
          stack.push(j);
        }
      }
      sizes.push(members.length);
      if (members.length >= minPixels) continue;
      // Majority label around the blob's border.
      const votes = new Map<number, number>();
      for (const i of members) {
        const x = i % w, y = (i - x) / w;
        const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
        for (const j of nb) if (j >= 0 && labels[j] !== lab && labels[j] >= 0) votes.set(labels[j], (votes.get(labels[j]) ?? 0) + 1);
      }
      let best = -1, bv = 0;
      for (const [l, v] of votes) if (v > bv) {
        bv = v;
        best = l;
      }
      if (best < 0) continue;
      for (const i of members) labels[i] = best;
      removed++;
      changed++;
    }
    if (!changed) break;
  }
  return removed;
}

/** Closed loops around every pixel of `label`, in pixel corner coordinates (y down). */
export function traceLabel(q: Quantized, label: number): Ring[] {
  const { width: w, height: h, labels } = q;
  const W = w + 1;
  // Directed boundary edges keyed by start vertex; a vertex has at most two (a pinch point).
  const next = new Map<number, number[]>();
  const add = (a: number, b: number) => {
    const l = next.get(a);
    if (l) l.push(b);
    else next.set(a, [b]);
  };
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? -2 : labels[y * w + x]);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (labels[y * w + x] !== label) continue;
      const tl = y * W + x, tr = tl + 1, bl = tl + W, br = bl + 1;
      if (at(x, y - 1) !== label) add(tl, tr);
      if (at(x + 1, y) !== label) add(tr, br);
      if (at(x, y + 1) !== label) add(br, bl);
      if (at(x - 1, y) !== label) add(bl, tl);
    }
  const rings: Ring[] = [];
  for (const [start, outs] of next) {
    while (outs.length) {
      const ring: Ring = [];
      let v = start;
      let prev = -1;
      for (;;) {
        ring.push([v % W, Math.floor(v / W)]);
        const cand = next.get(v);
        if (!cand || cand.length === 0) break;
        let pick = 0;
        if (cand.length > 1 && prev >= 0) {
          // At a pinch, turn right (keep the tighter loop) so touching corners separate cleanly.
          const dx = v % W - (prev % W), dy = Math.floor(v / W) - Math.floor(prev / W);
          for (let i = 0; i < cand.length; i++) {
            const ex = cand[i] % W - (v % W), ey = Math.floor(cand[i] / W) - Math.floor(v / W);
            if (dx * ey - dy * ex > 0) pick = i;
          }
        }
        const nv = cand[pick];
        cand.splice(pick, 1);
        prev = v;
        v = nv;
        if (v === start) break;
      }
      if (ring.length >= 4) rings.push(collinearFree(ring));
      if (!next.get(start)?.length) break;
    }
  }
  return rings;
}

function collinearFree(r: Ring): Ring {
  const out: Ring = [];
  for (let i = 0; i < r.length; i++) {
    const p = r[(i + r.length - 1) % r.length], c = r[i], n = r[(i + 1) % r.length];
    if ((c[0] - p[0]) * (n[1] - c[1]) - (c[1] - p[1]) * (n[0] - c[0]) !== 0) out.push(c);
  }
  return out;
}

function chaikin(r: Ring): Ring {
  const out: Ring = [];
  for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length];
    out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
  }
  return out;
}

export interface TraceOptions {
  /** Douglas-Peucker tolerance in px for the staircase edge, then the smoothed curve. */
  cornerPx?: number;
  smoothPasses?: number;
}

/** Vector regions for one label, in pixel units, holes resolved. */
export function traceRegion(q: Quantized, label: number, opts: TraceOptions = {}): MultiPolygon {
  const corner = opts.cornerPx ?? 1.0;
  const passes = opts.smoothPasses ?? 1;
  const rings = traceLabel(q, label).map((r) => {
    let s = simplifyMp([[r]], corner)[0]?.[0] ?? r;
    for (let i = 0; i < passes; i++) s = chaikin(s);
    return s;
  });
  const mp = ringsToMp(rings, 'evenodd');
  return simplifyMp(mp, 0.15);
}
