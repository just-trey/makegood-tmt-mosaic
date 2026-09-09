import { mapMp, unionAll, type MultiPolygon } from '../design/poly';
import { traceRegion, type Quantized } from '../design/raster';
import { toLocalMesh } from '../geometry/frame';
import type { PieceMesh, SurfaceInput } from '../geometry/inlay';
import { HeightSampler } from '../geometry/raycast';
import { escapeXml } from '../lib/xml';

/** Which piece is in front at every cell of the surface, on a grid in local mm. */
export interface SurfaceMap {
  labels: Int16Array;
  heights: Float32Array;
  w: number;
  h: number;
  minU: number;
  minV: number;
  cell: number;
  pieceIds: string[];
}

export function buildSurfaceMap(surface: SurfaceInput, pieces: PieceMesh[], cell = 1): SurfaceMap {
  const b = surface.bounds;
  const w = Math.max(1, Math.ceil((b.maxX - b.minX) / cell));
  const h = Math.max(1, Math.ceil((b.maxY - b.minY) / cell));
  const labels = new Int16Array(w * h).fill(-1);
  const heights = new Float32Array(w * h).fill(-Infinity);
  const pieceIds: string[] = [];
  for (const id of surface.def.pieces) {
    const piece = pieces.find((p) => p.id === id);
    if (!piece) continue;
    const label = pieceIds.length;
    pieceIds.push(id);
    const sampler = new HeightSampler(toLocalMesh(surface.frame, piece.mesh));
    for (let j = 0; j < h; j++) {
      const v = b.minY + (j + 0.5) * cell;
      for (let i = 0; i < w; i++) {
        const z = sampler.top(b.minX + (i + 0.5) * cell, v);
        if (z !== null && z > heights[j * w + i]) {
          heights[j * w + i] = z;
          labels[j * w + i] = label;
        }
      }
    }
  }
  return { labels, heights, w, h, minU: b.minX, minV: b.minY, cell, pieceIds };
}

export function pieceAt(map: SurfaceMap, u: number, v: number): string | null {
  const i = Math.floor((u - map.minU) / map.cell);
  const j = Math.floor((v - map.minV) / map.cell);
  if (i < 0 || j < 0 || i >= map.w || j >= map.h) return null;
  const l = map.labels[j * map.w + i];
  return l < 0 ? null : map.pieceIds[l];
}

/** Outline of each piece as seen from the surface, in local mm (v up). */
export function pieceOutlines(map: SurfaceMap): Map<string, MultiPolygon> {
  const q: Quantized = { palette: [], labels: map.labels, width: map.w, height: map.h };
  const out = new Map<string, MultiPolygon>();
  map.pieceIds.forEach((id, label) => {
    const mp = traceRegion(q, label, { cornerPx: 0.7, smoothPasses: 1 });
    // Cell coords are y-down rows; row j sits at v = minV + j*cell, so no flip is needed here.
    out.set(id, mapMp(mp, ([x, y]) => [map.minU + x * map.cell, map.minV + y * map.cell]));
  });
  return out;
}

function pathD(mp: MultiPolygon, toSvg: (u: number, v: number) => [number, number]): string {
  const parts: string[] = [];
  for (const poly of mp)
    for (const ring of poly) {
      parts.push(ring.map(([u, v], i) => (i ? 'L' : 'M') + toSvg(u, v).map((n) => n.toFixed(2)).join(' ')).join(''), 'Z');
    }
  return parts.join('');
}

/**
 * A true-size SVG of the design surface: every piece it spans as a light shape, the outer edge
 * solid, the joins between pieces dashed, each piece named. Loaded back, its own size lands it
 * 1:1 on the surface.
 */
export function templateSvg(map: SurfaceMap, pieceNames: Map<string, string>, surfaceName: string): string {
  const outlines = pieceOutlines(map);
  const W = map.w * map.cell;
  const H = map.h * map.cell;
  const toSvg = (u: number, v: number): [number, number] => [u - map.minU, H - (v - map.minV)];
  const shapes: string[] = [];
  const labels: string[] = [];
  const all: MultiPolygon[] = [];
  for (const [id, mp] of outlines) {
    if (mp.length === 0) continue;
    all.push(mp);
    shapes.push(`<path id="${escapeXml(id)}" d="${pathD(mp, toSvg)}" fill="#eef1f5" stroke="#5b6470" stroke-width="0.35" stroke-dasharray="2.5 1.5" fill-rule="evenodd"/>`);
    let best = mp[0];
    for (const poly of mp) if (poly[0].length > best[0].length) best = poly;
    let cx = 0, cy = 0;
    for (const p of best[0]) {
      cx += p[0];
      cy += p[1];
    }
    const c = toSvg(cx / best[0].length, cy / best[0].length);
    labels.push(`<text x="${c[0].toFixed(1)}" y="${c[1].toFixed(1)}" font-family="Helvetica, Arial, sans-serif" font-size="6" text-anchor="middle" fill="#5b6470">${escapeXml(pieceNames.get(id) ?? id)}</text>`);
  }
  let outer = '';
  try {
    outer = `<path d="${pathD(unionAll(all), toSvg)}" fill="none" stroke="#1f2933" stroke-width="0.6" fill-rule="evenodd"/>`;
  } catch {
    outer = '';
  }
  const c = toSvg(0, 0);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(2)}mm" height="${H.toFixed(2)}mm" viewBox="0 0 ${W.toFixed(2)} ${H.toFixed(2)}">`,
    `<title>${escapeXml(surfaceName)} template, true size. Keep this document size when you save.</title>`,
    `<g id="template">${shapes.join('')}${outer}`,
    `<path d="M${(c[0] - 4).toFixed(1)} ${c[1].toFixed(1)}H${(c[0] + 4).toFixed(1)}M${c[0].toFixed(1)} ${(c[1] - 4).toFixed(1)}V${(c[1] + 4).toFixed(1)}" stroke="#1f2933" stroke-width="0.3" fill="none"/>`,
    `${labels.join('')}</g>`,
    `<text x="2" y="${(H - 2).toFixed(1)}" font-family="Helvetica, Arial, sans-serif" font-size="4" fill="#5b6470">${escapeXml(surfaceName)} · ${W.toFixed(0)} × ${H.toFixed(0)} mm · dashed lines are joins between printed pieces · delete this layer before loading</text>`,
    `</svg>`,
  ].join('\n');
}
