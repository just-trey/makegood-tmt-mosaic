import type { Loop, ParsedSVG, SVGShape } from '../types';
import { autoParams, despeckleFloorPx, DETAIL_MAX, fracFloorPx, measureImage } from './stats';
import { MEASURE_EDGE } from './decode';
import { quantize } from './quantize';
import { traceLabelMap } from './trace';
import type { TracedComponent } from './trace';
import { BACKGROUND } from './types';
import type { RasterImage, RasterOptions } from './types';

export interface RasterParseResult {
  parsed: ParsedSVG;
  /** The colors the traced shapes actually paint with — can be shorter than the requested count,
   * and shorter than the quantizer's own palette. */
  palette: string[];
  /**
   * How many colors labelled pixels and then painted nothing. Counted against the quantizer's
   * palette, never against `opts.colors`: an image with fewer colors than the slider asks for lost
   * nothing, and no Detail setting invents a color it never had.
   */
  droppedColors: number;
  /**
   * Whether raising Detail lowers the floor this trace ran under at all, measured rather than
   * inferred: the floor the same image would get at DETAIL_MAX, against the one it got. False when
   * a placement's nozzle-width floor pins it (Detail never scales that half) and false at
   * DETAIL_MAX itself, which is every case where "raise Detail" is not an instruction.
   */
  detailLowersFloor: boolean;
  /** Traced components, for the panel's live readout and the bench. */
  componentCount: number;
  /** True when the despeckle floor was raised to stay under MAX_COMPONENTS. */
  capped: boolean;
  /** The floor the trace actually applied, which is above `despeckleFloorPx`'s answer when capped. */
  floorPx: number;
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
    throw new Error('No opaque pixels were found in this image. There is nothing to cut.');

  const floor = despeckleFloorPx(params, img.w, img.h, stats, opts.detail, opts.mmPerPixel ?? 0);
  const { components, capped, floorPx } = traceLabelMap(map, params, floor);
  // What the dropped-color notice's remedy is worth here, asked directly rather than inferred from
  // which floor binds: the floor this image would get at DETAIL_MAX, against the one it got. A
  // placement's nozzle floor pinning it and the slider already being at its end are the same answer.
  //
  // Read off `floor`, the floor asked for, never the `floorPx` the trace came back with: a cap
  // raise puts that one above `floor` on its own, so a capped trace at DETAIL_MAX would come back
  // claiming Detail has room it does not have.
  const maxParams = autoParams(stats, DETAIL_MAX, ranDetailPass);
  const floorAtMax = despeckleFloorPx(
    maxParams,
    img.w,
    img.h,
    stats,
    DETAIL_MAX,
    opts.mmPerPixel ?? 0,
  );
  const detailLowersFloor = floorAtMax < floor;

  // The empty-trace remedy comes off the same measurement, so it stops pointing at Detail wherever
  // the placed size is the real answer. 'printable' needs both halves: Detail has no room left on
  // this floor, *and* the placement is what holds it above the fraction at DETAIL_MAX. Asking
  // `floor > fracFloorPx` instead read a nozzle floor that ties the fraction rather than exceeding
  // it as 'noise', with the floor pinned at 2 and Detail unable to move it. With no placement the
  // second half fails and 'noise' stands: no part size is the answer there, and a cleaner source is.
  const floorReason: FloorReason =
    !detailLowersFloor && floorAtMax > fracFloorPx(maxParams, img.w, img.h) ? 'printable' : 'noise';
  if (!components.length) throw new EmptyTraceError(opts.name ?? 'this image', floorReason);

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

  // Only the colors that labelled pixels and then painted none of them. A centroid can win a
  // cluster from the source histogram and label nothing at all, because assignment is resolved
  // against the *blurred* copy (see quantize): that color never had pieces to lose, so counting it
  // would put a "raise Detail" notice on a loss no Detail setting can undo.
  const labelled = new Set<number>();
  for (const label of map.labels) if (label !== BACKGROUND) labelled.add(label);
  let droppedColors = 0;
  for (const label of labelled) if (!painted.has(map.palette[label])) droppedColors++;

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
    droppedColors,
    detailLowersFloor,
    componentCount: components.length,
    capped,
    floorPx,
  };
}

/**
 * The capped notice, named for the image it is about.
 *
 * Per image rather than one shared string, so the pill names which image it's about once more
 * than one is loaded. Every notice()/dismissNotice() call for this message is keyed by the
 * source's id (warnings.ts's Notice.key), not by this text — two sources can share a filename,
 * and keying by the rendered string would let one land on the wrong side of the capped/traced
 * split or cross-retract the other's still-true notice.
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
 * Same shape as rasterCappedMessage: keyed by source id, mutually exclusive with it per source,
 * so a row shows exactly one status line once it has traced.
 */
export function rasterTracedMessage(name: string): string {
  return `"${name}" was traced from a photo. An SVG would come out cleaner.`;
}

/**
 * Shown when tracing painted nothing with colors the quantizer had found, so the readout comes back
 * under the Colors slider with nothing saying why.
 *
 * Raising Detail is the whole message, and rasterLostColors only raises it where that is the true
 * answer: the fractional floor is the one autoParams scales, by 4^((50-detail)/50). It is also the
 * opposite of what rasterCappedMessage asks for, which is why the two are mutually exclusive.
 *
 * It makes no claim about the pieces being unprintable. Under that floor they usually are printable
 * — NOZZLE_MM is the only floor that claims otherwise, and the one Detail deliberately never scales.
 */
export function rasterColorLossMessage(name: string, dropped: number): string {
  return (
    `${dropped === 1 ? '1 color' : `${dropped} colors`} in "${name}" ` +
    `${dropped === 1 ? 'was' : 'were'} dropped. Raise Detail to keep more.`
  );
}

/**
 * The notice key for rasterColorLossMessage, deliberately not the bare source id the capped/traced
 * pair uses: this one stands *beside* the traced notice, and sharing their key would make push()
 * skip whichever arrived second and dismissNotice() retract the wrong one.
 */
export function rasterColorLossKey(sourceId: string): string {
  return `${sourceId}:colors`;
}

/**
 * Whether a finished trace should raise rasterColorLossMessage. Not simply `droppedColors > 0`: it
 * only fires where raising Detail is an answer the user can actually give.
 *
 * Two cases where it is not: a capped trace already carries rasterCappedMessage, whose remedy is
 * the opposite one, and a trace whose floor Detail cannot lower — a placement's nozzle-width floor
 * pinning it, or the slider already at DETAIL_MAX. Both stay silent about the color they dropped,
 * which docs/tech-debt.md carries.
 */
export function rasterLostColors(
  result: Pick<RasterParseResult, 'capped' | 'droppedColors' | 'detailLowersFloor'>,
): boolean {
  return !result.capped && result.detailLowersFloor && result.droppedColors > 0;
}

/**
 * Which remedy an emptied trace gets. 'printable' means the placement holds the floor up even at
 * DETAIL_MAX, so only a bigger part or design moves it; 'noise' means Detail still has room, or
 * there is no placement to blame. Measured in parseRasterImage, never inferred from which floor
 * binds now — see rasterEmptyTraceMessage.
 */
export type FloorReason = 'printable' | 'noise';

/**
 * The empty-trace message for either cause: 'printable' offers the only lever left, the size the
 * design is placed at; 'noise' offers Detail, which scales the fractional floor, and a cleaner
 * source. Which arm a trace gets is measured rather than inferred — see FloorReason.
 */
export function rasterEmptyTraceMessage(name: string, reason: FloorReason): string {
  return reason === 'printable'
    ? `Nothing in "${name}" is big enough to print at this size. Make the design or the part bigger.`
    : `No color regions survived tracing "${name}". Try raising Detail, or use a less noisy image.`;
}

/** Thrown by parseRasterImage when the despeckle floor removes every component. */
export class EmptyTraceError extends Error {
  readonly reason: FloorReason;
  constructor(name: string, reason: FloorReason) {
    super(rasterEmptyTraceMessage(name, reason));
    this.name = 'EmptyTraceError';
    this.reason = reason;
  }
}
