import { decodeImage } from '../design/decode';
import type { DesignSource } from '../design/placement';
import { mapMp, mpArea } from '../design/poly';
import { despeckle, quantize, traceRegion } from '../design/raster';
import { resolveRegions, type ColorRegion } from '../design/regions';
import { parseSvg } from '../design/svg';
import type { DesignState } from './state';

/** A picture with no size of its own is shown at this long edge before Scale is applied. */
export const IMAGE_NATURAL_MM = 100;

const cache = new Map<string, { key: string; source: Promise<DesignSource> }>();

function keyOf(d: DesignState): string {
  if (d.kind === 'svg') return 'svg:' + (d.svgText?.length ?? 0) + ':' + hash(d.svgText ?? '');
  const mmPerPx = mmPerPxFor(d);
  return `img:${hash(d.imageDataUrl ?? '')}:${d.imageSettings.colors}:${d.imageSettings.detail}:${mmPerPx.toFixed(4)}`;
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += Math.max(1, Math.floor(s.length / 200000))) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36) + ':' + s.length;
}

/** Smallest speck worth tracing, in mm, from the Detail slider: 3mm at 0, a nozzle-and-a-half at 1. */
export function minFeatureMm(detail: number): number {
  return 3 - Math.max(0, Math.min(1, detail)) * (3 - 0.6);
}

function mmPerPxFor(d: DesignState): number {
  // Placed size decides what a speck is, so the trace keys on the scale in coarse steps.
  const scale = Math.max(0.05, Math.round(d.placement.scale * 4) / 4);
  return scale;
}

export function getSource(d: DesignState): Promise<DesignSource> {
  const key = keyOf(d);
  const hit = cache.get(d.id);
  if (hit && hit.key === key) return hit.source;
  const source = d.kind === 'svg' ? svgSource(d) : imageSource(d);
  cache.set(d.id, { key, source });
  return source;
}

export function dropSource(id: string): void {
  cache.delete(id);
}

async function svgSource(d: DesignState): Promise<DesignSource> {
  const parsed = parseSvg(d.svgText ?? '');
  const r = resolveRegions(parsed.shapes);
  return { id: d.id, name: d.name, kind: 'svg', widthMm: parsed.widthMm, heightMm: parsed.heightMm, regions: r.regions, warnings: [...parsed.warnings, ...r.warnings] };
}

export interface ImageTraceInfo {
  colorsFound: number;
  regions: number;
  photo: boolean;
  specksRemoved: number;
}

const traceInfo = new Map<string, ImageTraceInfo>();
export function lastTraceInfo(id: string): ImageTraceInfo | undefined {
  return traceInfo.get(id);
}

async function imageSource(d: DesignState): Promise<DesignSource> {
  const warnings: string[] = [];
  const img = await decodeImage(d.imageDataUrl ?? '');
  const naturalMmPerPx = IMAGE_NATURAL_MM / Math.max(img.width, img.height);
  const placedMmPerPx = naturalMmPerPx * mmPerPxFor(d);
  const q = quantize(img.rgba, img.width, img.height, d.imageSettings.colors);
  if (q.palette.length === 0) return { id: d.id, name: d.name, kind: 'image', widthMm: img.width * naturalMmPerPx, heightMm: img.height * naturalMmPerPx, regions: [], warnings: ['The image is fully transparent, so there is nothing to cut.'] };
  const feature = minFeatureMm(d.imageSettings.detail);
  const minPixels = Math.max(2, Math.round((feature / placedMmPerPx) ** 2));
  const removed = despeckle(q, minPixels);
  const regions: ColorRegion[] = [];
  let regionCount = 0;
  const px = naturalMmPerPx;
  for (let label = 0; label < q.palette.length; label++) {
    let any = false;
    for (let i = 0; i < q.labels.length; i++)
      if (q.labels[i] === label) {
        any = true;
        break;
      }
    if (!any) continue;
    try {
      const mp = traceRegion(q, label, { cornerPx: img.photo ? 1.2 : 0.9, smoothPasses: 1 });
      const mm = mapMp(mp, ([x, y]) => [x * px, y * px]);
      const area = mpArea(mm);
      if (area <= 0) continue;
      regionCount += mm.length;
      regions.push({ color: q.palette[label], region: mm, areaMm2: area });
    } catch {
      warnings.push(`One traced color (${q.palette[label]}) couldn't be turned into shapes and was left out. Lower Detail and try again.`);
    }
  }
  if (regionCount > 4000) warnings.push(`${d.name} traced to ${regionCount} separate shapes. That is very busy for a print; lower Detail or Colors to simplify it.`);
  traceInfo.set(d.id, { colorsFound: regions.length, regions: regionCount, photo: img.photo, specksRemoved: removed });
  return { id: d.id, name: d.name, kind: 'image', widthMm: img.width * px, heightMm: img.height * px, regions, warnings };
}
