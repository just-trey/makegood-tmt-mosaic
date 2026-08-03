import type { Lab } from '../color';
import { deltaE, labToHex, rgbToLab } from '../color';
import { ALPHA_THRESHOLD } from './decode';
import { BACKGROUND } from './types';
import type { LabelMap, RasterImage } from './types';

/** Bits per channel kept when histogramming. 5 => 32^3 = 32768 bins. */
const HIST_BITS = 5;
const HIST_LEVELS = 1 << HIST_BITS;
const HIST_SIZE = HIST_LEVELS * HIST_LEVELS * HIST_LEVELS;
const HIST_SHIFT = 8 - HIST_BITS;

export const MIN_COLORS = 2;
export const MAX_COLORS = 16;

/** Lloyd refinement stops here, or when no centroid moves further than LLOYD_EPSILON. */
const LLOYD_MAX_ITERS = 8;
const LLOYD_EPSILON = 0.5;

/**
 * Centroids closer than this in CIE76 are agglomerated after clustering.
 *
 * It is deliberately the same value as AUTO_MERGE_LEVELS' "Slight" stop (regions.ts): that slider
 * is the default, so a palette emitted with pairs below this cutoff would be silently re-merged the
 * instant it reached the color list, and the Colors slider would not mean what it says. Separating
 * here instead makes the two controls compose — Colors decides which regions exist, auto-merge
 * decides which of them share a filament slot.
 */
const PALETTE_SEPARATION_DE = 3;

interface Bin {
  lab: Lab;
  count: number;
  key: number;
}

/** Weighted mean of a Lab set — the centroid update, and the merge rule for agglomeration. */
function meanLab(bins: Bin[], from: number, to: number): Lab {
  let l = 0,
    a = 0,
    b = 0,
    n = 0;
  for (let i = from; i < to; i++) {
    const w = bins[i].count;
    l += bins[i].lab.l * w;
    a += bins[i].lab.a * w;
    b += bins[i].lab.b * w;
    n += w;
  }
  return n ? { l: l / n, a: a / n, b: b / n } : { l: 0, a: 0, b: 0 };
}

/**
 * Bucket the image at HIST_BITS per channel, carrying the true mean color of each bucket.
 *
 * Everything after this works on at most 32k weighted bins instead of up to 590k pixels, which is
 * both much faster and — because the weights ride along — arithmetically identical for the
 * weighted means that clustering is made of.
 */
function histogram(img: RasterImage): Bin[] {
  const counts = new Int32Array(HIST_SIZE);
  const sr = new Float64Array(HIST_SIZE);
  const sg = new Float64Array(HIST_SIZE);
  const sb = new Float64Array(HIST_SIZE);
  const { data } = img;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < ALPHA_THRESHOLD) continue;
    const r = data[i],
      g = data[i + 1],
      b = data[i + 2];
    const key =
      ((r >> HIST_SHIFT) << (HIST_BITS * 2)) | ((g >> HIST_SHIFT) << HIST_BITS) | (b >> HIST_SHIFT);
    counts[key]++;
    sr[key] += r;
    sg[key] += g;
    sb[key] += b;
  }
  const bins: Bin[] = [];
  for (let key = 0; key < HIST_SIZE; key++) {
    const n = counts[key];
    if (!n) continue;
    bins.push({ lab: rgbToLab(sr[key] / n, sg[key] / n, sb[key] / n), count: n, key });
  }
  return bins;
}

/**
 * Median cut in Lab, used to seed Lloyd rather than as the final answer: repeatedly split the box
 * with the largest weighted spread along its widest Lab axis, at the weighted median. Splitting in
 * Lab (not RGB) means the cut planes track perceptual difference, so the seeds land where a viewer
 * would say the distinct colors are.
 *
 * Deterministic — no random seeding anywhere in this file, so the same image always yields the same
 * palette and a test can assert one.
 */
function medianCutSeeds(bins: Bin[], k: number): Lab[] {
  const boxes: { from: number; to: number }[] = [{ from: 0, to: bins.length }];
  const axisOf = (box: { from: number; to: number }): keyof Lab => {
    let minL = Infinity,
      maxL = -Infinity,
      minA = Infinity,
      maxA = -Infinity,
      minB = Infinity,
      maxB = -Infinity;
    for (let i = box.from; i < box.to; i++) {
      const { l, a, b } = bins[i].lab;
      if (l < minL) minL = l;
      if (l > maxL) maxL = l;
      if (a < minA) minA = a;
      if (a > maxA) maxA = a;
      if (b < minB) minB = b;
      if (b > maxB) maxB = b;
    }
    const dl = maxL - minL,
      da = maxA - minA,
      db = maxB - minB;
    return dl >= da && dl >= db ? 'l' : da >= db ? 'a' : 'b';
  };
  const spreadOf = (box: { from: number; to: number }): number => {
    const axis = axisOf(box);
    let min = Infinity,
      max = -Infinity,
      n = 0;
    for (let i = box.from; i < box.to; i++) {
      const v = bins[i].lab[axis];
      if (v < min) min = v;
      if (v > max) max = v;
      n += bins[i].count;
    }
    return box.to - box.from > 1 ? (max - min) * n : 0;
  };

  while (boxes.length < k) {
    let best = -1,
      bestSpread = 0;
    for (let i = 0; i < boxes.length; i++) {
      const s = spreadOf(boxes[i]);
      if (s > bestSpread) {
        bestSpread = s;
        best = i;
      }
    }
    if (best < 0) break; // every box is a single bin — the image has fewer distinct colors than k
    const box = boxes[best];
    const axis = axisOf(box);
    const slice = bins.slice(box.from, box.to).sort((p, q) => p.lab[axis] - q.lab[axis]);
    for (let i = 0; i < slice.length; i++) bins[box.from + i] = slice[i];
    const half = slice.reduce((s, x) => s + x.count, 0) / 2;
    let acc = 0,
      cut = box.from;
    for (let i = box.from; i < box.to - 1; i++) {
      acc += bins[i].count;
      cut = i + 1;
      if (acc >= half) break;
    }
    boxes.splice(best, 1, { from: box.from, to: cut }, { from: cut, to: box.to });
  }
  return boxes.map((b) => meanLab(bins, b.from, b.to));
}

function nearest(centroids: Lab[], lab: Lab): number {
  let best = 0,
    bestD = Infinity;
  for (let c = 0; c < centroids.length; c++) {
    const d = deltaE(centroids[c], lab);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/** One Lloyd pass: assign bins to their nearest centroid, then recompute weighted means. */
function lloyd(bins: Bin[], centroids: Lab[], assign: Int32Array): number {
  for (let i = 0; i < bins.length; i++) assign[i] = nearest(centroids, bins[i].lab);
  let moved = 0;
  for (let c = 0; c < centroids.length; c++) {
    let l = 0,
      a = 0,
      b = 0,
      n = 0;
    for (let i = 0; i < bins.length; i++) {
      if (assign[i] !== c) continue;
      const w = bins[i].count;
      l += bins[i].lab.l * w;
      a += bins[i].lab.a * w;
      b += bins[i].lab.b * w;
      n += w;
    }
    if (!n) continue;
    const next = { l: l / n, a: a / n, b: b / n };
    moved = Math.max(moved, deltaE(centroids[c], next));
    centroids[c] = next;
  }
  return moved;
}

/**
 * Collapse centroid pairs closer than PALETTE_SEPARATION_DE, repeatedly, until the palette is
 * separated. Weighted so the survivor sits where the pixels actually are, not halfway between a
 * huge cluster and a tiny one.
 */
function separate(centroids: Lab[], weights: number[]): void {
  for (;;) {
    let bi = -1,
      bj = -1,
      bd = PALETTE_SEPARATION_DE;
    for (let i = 0; i < centroids.length; i++)
      for (let j = i + 1; j < centroids.length; j++) {
        const d = deltaE(centroids[i], centroids[j]);
        if (d < bd) {
          bd = d;
          bi = i;
          bj = j;
        }
      }
    if (bi < 0) return;
    const wi = weights[bi] || 1,
      wj = weights[bj] || 1;
    const t = wj / (wi + wj);
    centroids[bi] = {
      l: centroids[bi].l + (centroids[bj].l - centroids[bi].l) * t,
      a: centroids[bi].a + (centroids[bj].a - centroids[bi].a) * t,
      b: centroids[bi].b + (centroids[bj].b - centroids[bi].b) * t,
    };
    weights[bi] = wi + wj;
    centroids.splice(bj, 1);
    weights.splice(bj, 1);
  }
}

/** Separable box blur over RGB, skipping transparent pixels. Denoises a photo before clustering. */
export function boxBlur(img: RasterImage, radius: number): RasterImage {
  if (radius <= 0) return img;
  const { w, h } = img;
  const src = img.data;
  const tmp = new Uint8ClampedArray(src.length);
  const out = new Uint8ClampedArray(src.length);
  const pass = (from: Uint8ClampedArray, to: Uint8ClampedArray, horizontal: boolean) => {
    const outer = horizontal ? h : w;
    const inner = horizontal ? w : h;
    for (let o = 0; o < outer; o++) {
      for (let i = 0; i < inner; i++) {
        let r = 0,
          g = 0,
          b = 0,
          n = 0;
        for (let d = -radius; d <= radius; d++) {
          const j = i + d;
          if (j < 0 || j >= inner) continue;
          const idx = (horizontal ? o * w + j : j * w + o) * 4;
          if (from[idx + 3] < ALPHA_THRESHOLD) continue;
          r += from[idx];
          g += from[idx + 1];
          b += from[idx + 2];
          n++;
        }
        const idx = (horizontal ? o * w + i : i * w + o) * 4;
        to[idx] = n ? r / n : from[idx];
        to[idx + 1] = n ? g / n : from[idx + 1];
        to[idx + 2] = n ? b / n : from[idx + 2];
        to[idx + 3] = from[idx + 3];
      }
    }
  };
  pass(src, tmp, true);
  pass(tmp, out, false);
  return { data: out, w, h };
}

/**
 * Reduce an image to at most `colors` flat colors, as a per-pixel label grid.
 *
 * Clustering happens in CIELAB via median-cut seeding plus Lloyd refinement, then the palette is
 * ΔE-separated (see PALETTE_SEPARATION_DE). The returned palette can be shorter than `colors` —
 * an image with three distinct colors returns three however high the slider goes, which is the
 * honest answer and is what the panel's live readout reports.
 */
export function quantize(img: RasterImage, colors: number, blurRadius = 0): LabelMap {
  const work = boxBlur(img, blurRadius);
  const k = Math.max(MIN_COLORS, Math.min(MAX_COLORS, Math.round(colors)));
  const bins = histogram(work);
  const labels = new Int16Array(work.w * work.h).fill(BACKGROUND);
  if (!bins.length) return { labels, w: work.w, h: work.h, palette: [] };

  const centroids = medianCutSeeds(bins, Math.min(k, bins.length));
  const assign = new Int32Array(bins.length);
  for (let it = 0; it < LLOYD_MAX_ITERS; it++) {
    if (lloyd(bins, centroids, assign) < LLOYD_EPSILON) break;
  }

  const weights = centroids.map((_, c) =>
    bins.reduce((s, bin, i) => (assign[i] === c ? s + bin.count : s), 0),
  );
  // Drop centroids that ended up owning nothing before separating — an empty cluster has no
  // position worth merging toward, and would otherwise pull a real one off its pixels.
  for (let c = centroids.length - 1; c >= 0; c--)
    if (!weights[c]) {
      centroids.splice(c, 1);
      weights.splice(c, 1);
    }
  separate(centroids, weights);
  lloyd(bins, centroids, assign);

  // One lookup per populated bin, then a single pass over the pixels.
  const binToCluster = new Int32Array(HIST_SIZE).fill(BACKGROUND);
  for (let i = 0; i < bins.length; i++) binToCluster[bins[i].key] = nearest(centroids, bins[i].lab);

  const { data } = work;
  for (let p = 0, i = 0; i < data.length; i += 4, p++) {
    if (data[i + 3] < ALPHA_THRESHOLD) continue;
    const key =
      ((data[i] >> HIST_SHIFT) << (HIST_BITS * 2)) |
      ((data[i + 1] >> HIST_SHIFT) << HIST_BITS) |
      (data[i + 2] >> HIST_SHIFT);
    labels[p] = binToCluster[key];
  }

  return { labels, w: work.w, h: work.h, palette: centroids.map(labToHex) };
}
