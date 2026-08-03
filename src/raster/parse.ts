import type { Loop, ParsedSVG, SVGShape } from '../types';
import { autoParams, measureImage } from './stats';
import { quantize } from './quantize';
import { traceLabelMap } from './trace';
import type { TracedComponent } from './trace';
import type { RasterImage, RasterOptions } from './types';

export interface RasterParseResult {
  parsed: ParsedSVG;
  /** The palette actually emitted — can be shorter than the requested color count. */
  palette: string[];
  /** Traced components, for the panel's live readout and the bench. */
  componentCount: number;
  /** True when the despeckle floor was raised to stay under MAX_COMPONENTS. */
  capped: boolean;
}

/**
 * How traced components become shapes.
 *
 * 'color' puts every component of one color in a single shape: few shapes, so the paint-order
 * boolean pass in regions.ts stays tiny, at the cost of many rings inside one shape — which is what
 * `shapeToFeature`'s containment resolution is quadratic in. 'component' inverts that trade.
 *
 * 'color' wins, measured rather than argued (scripts/bench-raster.ts): on a 512px photographic
 * source it totals ~830ms against ~1590ms for 'component', because the paint-order booleans scale
 * with shape count and dominate everything else. The quadratic risk 'color' runs toward never
 * materialises — despeckling holds the worst shape to ~23 rings, where `shapeToFeature` costs
 * ~5ms against a 30ms yield budget. 'component' is kept so the bench can keep re-checking that,
 * since the balance would shift if the despeckle floor were ever lowered a long way.
 */
export type ShapeGranularity = 'color' | 'component';

function shapesByColor(components: TracedComponent[], palette: string[]): SVGShape[] {
  const byLabel = new Map<number, { loops: Loop[]; area: number }>();
  for (const c of components) {
    const entry = byLabel.get(c.label);
    if (entry) {
      entry.loops.push(...c.loops);
      entry.area += c.area;
    } else byLabel.set(c.label, { loops: [...c.loops], area: c.area });
  }
  return [...byLabel.entries()]
    .sort((a, b) => b[1].area - a[1].area)
    .map(([label, entry], i) => ({ fill: palette[label], loops: entry.loops, order: i }));
}

function shapesByComponent(components: TracedComponent[], palette: string[]): SVGShape[] {
  return components.map((c, i) => ({ fill: palette[c.label], loops: c.loops, order: i }));
}

function bboxOf(shapes: SVGShape[]): ParsedSVG['bbox'] {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const s of shapes)
    for (const loop of s.loops)
      for (const p of loop) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
  return { minX, minY, maxX, maxY };
}

/**
 * Turn a decoded image into the same `ParsedSVG` the SVG parser produces — the whole point of the
 * raster path. One user unit is one working pixel, origin top-left, y down, which is exactly the
 * SVG convention, so every downstream y-flip and fit already applies unchanged.
 *
 * Throws when nothing usable comes out, matching `parseSVGDocument`: the artwork panel relies on a
 * failed load being a no-op that leaves whatever is already loaded alone.
 */
export function parseRasterImage(
  img: RasterImage,
  opts: RasterOptions,
  granularity: ShapeGranularity = 'color',
): RasterParseResult {
  const params = autoParams(measureImage(img), opts.detail);
  const map = quantize(img, opts.colors, params.blurRadius);
  if (!map.palette.length)
    throw new Error('No opaque pixels were found in this image — there is nothing to cut.');

  const { components, capped } = traceLabelMap(map, params);
  if (!components.length)
    throw new Error(
      'No color regions survived tracing this image — try raising Detail, or use a less noisy image.',
    );

  const shapes =
    granularity === 'component'
      ? shapesByComponent(components, map.palette)
      : shapesByColor(components, map.palette);

  return {
    parsed: {
      shapes,
      bbox: bboxOf(shapes),
      rawSVGCircle: null,
      // A raster carries no trustworthy physical size: the DPI tags in consumer PNG/JPEG files are
      // almost always a meaningless 72 or 96, and honoring one would size a phone photo at over a
      // metre. Leaving it null routes placement through the same meet-fit branch every SVG the app
      // ships already takes.
      userUnitMM: null,
      viewBox: { w: img.w, h: img.h },
      canvas: { w: img.w, h: img.h },
      origin: 'raster',
    },
    palette: map.palette,
    componentCount: components.length,
    capped,
  };
}
