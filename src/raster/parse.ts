import type { Loop, ParsedSVG, SVGShape } from '../types';
import { autoParams, despeckleFloorPx, measureImage, FRINGE_WIDTH_PX } from './stats';
import { MEASURE_EDGE } from './decode';
import { quantize } from './quantize';
import { traceLabelMap } from './trace';
import type { TracedComponent } from './trace';
import type { RasterImage, RasterOptions } from './types';

export interface RasterParseResult {
  parsed: ParsedSVG;
  /** The colors the traced shapes actually paint with — can be shorter than the requested count,
   * and shorter than the quantizer's own palette. */
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
  // Measured at decode time, at a fixed reference size, and carried on the image — see
  // RasterImage.edgeDensity. Re-measuring here would read the *working* image, whose size now
  // varies with that very statistic, and quietly shift every threshold that depends on it.
  const stats =
    img.edgeDensity === undefined ? measureImage(img) : { edgeDensity: img.edgeDensity };
  // Whether the detail pass actually enlarged this image, which is what decides the compensating
  // blur. Read off the working size rather than passed down: the size is the fact, and an image too
  // small to be enlarged gave up no downscale filtering and must not be blurred for it.
  const ranDetailPass = Math.max(img.w, img.h) > MEASURE_EDGE;
  const params = autoParams(stats, opts.detail, ranDetailPass);
  const map = quantize(img, opts.colors, params.blurRadius);
  if (!map.palette.length)
    throw new Error('No opaque pixels were found in this image — there is nothing to cut.');

  const floor = despeckleFloorPx(params, img.w, img.h, stats, opts.detail, opts.mmPerPixel ?? 0);
  const { components, capped } = traceLabelMap(
    map,
    params,
    floor,
    ranDetailPass ? FRINGE_WIDTH_PX : 0,
  );
  if (!components.length)
    throw new Error(
      'No color regions survived tracing this image — try raising Detail, or use a less noisy image.',
    );

  const shapes =
    granularity === 'component'
      ? shapesByComponent(components, map.palette)
      : shapesByColor(components, map.palette);

  // The quantizer's palette, narrowed to what survived tracing. A colour can win a cluster and then
  // paint nothing at all — every component of it despeckled away, absorbed by the component cap, or
  // collapsed into a neighbour — and counting it anyway makes the panel read "3 colors · 2 regions",
  // makes the smoke's `shown === traced` check fail against a colour list that only has the two, and
  // lets remapSettingsToPalette carry a depth onto a hex nothing paints (where the prune then drops
  // it). Palette entries are ΔE-separated by construction, so no two share a hex and this can't
  // collapse two live entries into one.
  const painted = new Set(shapes.map((s) => s.fill));
  const palette = map.palette.filter((hex) => painted.has(hex));

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
    palette,
    componentCount: components.length,
    capped,
  };
}

/**
 * The capped notice, named for the image it is about.
 *
 * Per image rather than one shared string, because notices dedupe by message and the list panel
 * retracts this one by exact text: with a single message, re-quantizing an *uncapped* image pulled
 * down a still-true notice belonging to a different, capped one. The filename is what tells the two
 * apart in the pill, too, once more than one image is loaded.
 *
 * Both suggestions lower the component count. Detail is the counter-intuitive one: `autoParams`
 * scales the despeckle floor by 4^((50-detail)/50), so *raising* Detail quarters the floor and lets
 * through four times the specks — the opposite of what this notice is asking for.
 *
 * Lives here rather than in the panel that first showed it because session restore re-traces and
 * has to say the same thing: a design that comes back simplified with nothing said reads as the
 * app having quietly changed it.
 */
export function rasterCappedMessage(name: string): string {
  return (
    `Some detail in "${name}" was too fine to print and was merged into its surroundings. ` +
    'Lower Colors, or lower Detail, for a cleaner result.'
  );
}

/**
 * Shown once a photo has traced without hitting the cap above. An SVG is already flat color;
 * a photo has to be quantized and traced to get there, so it never comes out as sharp.
 *
 * Same shape as rasterCappedMessage: filename-keyed and mutually exclusive with it per source,
 * so a row shows exactly one status line once it has traced.
 */
export function rasterTracedMessage(name: string): string {
  return `"${name}" was traced from a photo. An SVG would come out cleaner.`;
}
