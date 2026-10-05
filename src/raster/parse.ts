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
  /** The colors the traced shapes paint with — can be fewer than requested, and fewer than the quantizer's palette. */
  palette: string[];
  /** How many colors labelled pixels and then painted nothing. Counted against the quantizer's palette, never `opts.colors`: an image with fewer colors than the slider asks lost nothing, and no Detail setting invents a color. */
  droppedColors: number;
  /**
   * Whether raising Detail lowers this trace's floor at all, measured: the floor at DETAIL_MAX
   * against the one it got. False when a placement's nozzle-width floor pins it (Detail never scales
   * that half) and at DETAIL_MAX itself — every case where "raise Detail" isn't an instruction.
   */
  detailLowersFloor: boolean;
  /** Which lever is left when Detail has none: see FloorReason. */
  floorReason: FloorReason;
  /** Traced components, for the panel's live readout and the bench. */
  componentCount: number;
  /** True when the despeckle floor was raised to stay under MAX_COMPONENTS. */
  capped: boolean;
  /** The floor the trace applied — above `despeckleFloorPx`'s answer when capped. */
  floorPx: number;
}

/**
 * How traced components become shapes.
 *
 * 'color' puts every component of one color in one shape: few shapes, so regions.ts's paint-order
 * boolean pass stays tiny, at the cost of many rings in one shape (what `shapeToFeature`'s
 * containment resolution is quadratic in). 'component' inverts the trade.
 *
 * 'color' wins, measured (scripts/bench-raster.ts): on a 512px photographic source ~830ms against
 * ~1590ms, since the booleans scale with shape count. The quadratic risk never materialises —
 * despeckling holds the worst shape to ~23 rings, where `shapeToFeature` costs ~5ms against a 30ms
 * budget. 'component' stays so the bench keeps re-checking that if the floor is ever lowered a long way.
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
 * Everything a trace takes from its placement: the floor it runs at and the floor it would get at
 * DETAIL_MAX. `mmPerPixel` reaches parseRasterImage only through these, so two placements giving
 * the same pair trace identically (see `placedFloors`).
 */
function tracePlan(img: RasterImage, detail: number, mmPerPixel: number) {
  // Measured at decode time at a fixed reference size and carried on the image (RasterImage.edgeDensity). Re-measuring would read the *working* image, whose size varies with that statistic, and shift every threshold.
  const stats =
    img.edgeDensity === undefined ? measureImage(img) : { edgeDensity: img.edgeDensity };
  // Whether the detail pass enlarged this image, which decides the compensating blur. Read off the
  // working size: an image too small to be enlarged gave up no downscale filtering and mustn't be blurred.
  const ranDetailPass = Math.max(img.w, img.h) > MEASURE_EDGE;
  const params = autoParams(stats, detail, ranDetailPass);
  const floor = despeckleFloorPx(params, img.w, img.h, stats, detail, mmPerPixel);
  // What the dropped-color remedy is worth, asked directly rather than inferred from which floor
  // binds: the floor at DETAIL_MAX against the one got. A nozzle floor pinning it and the slider
  // being at its end are the same answer. Compared against `floor` (asked for), never the `floorPx`
  // returned: a cap raise puts that above `floor` alone, and a capped trace at DETAIL_MAX would claim Detail has room.
  const maxParams = autoParams(stats, DETAIL_MAX, ranDetailPass);
  const floorAtMax = despeckleFloorPx(maxParams, img.w, img.h, stats, DETAIL_MAX, mmPerPixel);

  // The empty-trace remedy comes off the same measurement. 'printable' needs both halves: Detail
  // has no room on this floor, *and* the placement holds it above the fraction at DETAIL_MAX.
  // `floor > fracFloorPx` read a nozzle floor tying the fraction as 'noise' with the floor pinned at
  // 2 and Detail unable to move it. With no placement the second half fails and 'noise' stands.
  const floorReason: FloorReason =
    floorAtMax >= floor && floorAtMax > fracFloorPx(maxParams, img.w, img.h)
      ? 'printable'
      : 'noise';
  return { params, floor, floorAtMax, floorReason };
}

/** The two floors a trace at this placement would run under, cheap enough for every rebuild (no quantize, no trace). Equal answers mean identical traces — how a resize decides to re-trace (state/artwork.ts `retraceMovedSources`). */
export function placedFloors(
  img: RasterImage,
  detail: number,
  mmPerPixel = 0,
): { floor: number; floorAtMax: number } {
  const { floor, floorAtMax } = tracePlan(img, detail, mmPerPixel);
  return { floor, floorAtMax };
}

/**
 * Turn a decoded image into the same `ParsedSVG` the SVG parser produces. One user unit is one
 * working pixel, origin top-left, y down — the SVG convention, so every downstream y-flip and fit
 * applies unchanged. Throws when nothing usable comes out, like `parseSVGDocument`: the artwork
 * panel relies on a failed load leaving what's loaded alone.
 */
export function parseRasterImage(
  img: RasterImage,
  opts: RasterOptions,
  granularity: ShapeGranularity = 'color',
): RasterParseResult {
  const { params, floor, floorAtMax, floorReason } = tracePlan(
    img,
    opts.detail,
    opts.mmPerPixel ?? 0,
  );
  const map = quantize(img, opts.colors, params.blurRadius);
  if (!map.palette.length)
    throw new Error('No opaque pixels were found in this image. There is nothing to cut.');

  const { components, raises, floorPx } = traceLabelMap(map, params, floor);
  const detailLowersFloor = floorAtMax < floor;
  if (!components.length) throw new EmptyTraceError(opts.name ?? 'this image', floorReason);

  const shapes =
    granularity === 'component'
      ? shapesByComponent(components, map.palette)
      : shapesByColor(components, map.palette);

  // The quantizer's palette narrowed to what survived tracing. A color can win a cluster and paint
  // nothing (despeckled away, absorbed by the cap, collapsed into a neighbour); counting it reads
  // "3 colors · 2 regions", fails the smoke's `shown === traced`, and lets remapSettingsToPalette
  // carry a depth onto a hex nothing paints. Palette entries are ΔE-separated, so none share a hex.
  const painted = new Set(shapes.map((s) => s.fill));
  const palette = map.palette.filter((hex) => painted.has(hex));

  // Only colors that labelled pixels and then painted none. A centroid can win a cluster from the
  // source histogram and label nothing, since assignment resolves against the *blurred* copy (see
  // quantize) — it had no pieces to lose, and counting it would raise a "raise Detail" notice no Detail setting can undo.
  const labelled = new Set<number>();
  for (const label of map.labels) if (label !== BACKGROUND) labelled.add(label);
  let droppedColors = 0;
  for (const label of labelled) if (!painted.has(map.palette[label])) droppedColors++;

  return {
    parsed: {
      shapes,
      bbox: bboxOf(shapes),
      rawSVGCircle: null,
      // A raster has no trustworthy physical size: DPI tags are almost always a meaningless 72 or 96
      // and honoring one would size a phone photo at over a metre. Null routes placement through the
      // meet-fit branch every shipped SVG already takes.
      userUnitMM: null,
      viewBox: { w: img.w, h: img.h },
      canvas: { w: img.w, h: img.h },
      origin: 'raster',
    },
    palette,
    droppedColors,
    detailLowersFloor,
    floorReason,
    componentCount: components.length,
    capped: raises > 0,
    floorPx,
  };
}

/**
 * The capped notice, named for the image it is about, so the pill says which once several are loaded.
 * Every notice()/dismissNotice() call for it is keyed by the source's id (warnings.ts Notice.key),
 * not this text: two sources can share a filename, and keying by the rendered string would let one
 * land on the wrong side of the capped/traced split or cross-retract the other's notice.
 *
 * Both suggestions lower the component count. Detail is the counter-intuitive one: `autoParams`
 * scales the despeckle floor by 4^((50-detail)/50), so *raising* Detail quarters the floor and lets
 * through four times the specks — the opposite of what this notice asks.
 *
 * Lives here, not in the panel, because session restore re-traces and must say the same thing: a
 * design that comes back simplified unannounced reads as the app quietly changing it.
 */
export function rasterCappedMessage(name: string, dropped = 0): string {
  return (
    `Some detail in "${name}" was too fine to print and was merged into its surroundings` +
    // Here, not a second notice whose "raise Detail" contradicts this one. No recovery promised: while capped, the cap sets the floor, not Detail.
    (dropped > 0 ? `, including ${dropped === 1 ? '1 color' : `${dropped} colors`}` : '') +
    '. Lower Colors, or lower Detail, for a cleaner result.'
  );
}

/**
 * Shown once a photo has traced without hitting the cap. An SVG is already flat color; a photo must
 * be quantized and traced, so it never comes out as sharp. Same shape as rasterCappedMessage: keyed
 * by source id and mutually exclusive with it, so a row shows one status line.
 */
export function rasterTracedMessage(name: string): string {
  return `"${name}" was traced from a photo. An SVG would come out cleaner.`;
}

/**
 * Shown when tracing painted nothing with colors the quantizer found, so the readout comes back
 * under the Colors slider unexplained.
 *
 * Raising Detail is the whole message, and rasterLostColors only raises it where true: the
 * fractional floor is the one autoParams scales (4^((50-detail)/50)). Opposite to rasterCappedMessage,
 * hence mutually exclusive. It doesn't claim the pieces are unprintable — under that floor they
 * usually are printable; NOZZLE_MM is the only floor that claims otherwise, and Detail never scales it.
 */
export function rasterColorLossMessage(name: string, dropped: number): string {
  return (
    `${dropped === 1 ? '1 color' : `${dropped} colors`} in "${name}" ` +
    `${dropped === 1 ? 'was' : 'were'} dropped. Raise Detail to keep more.`
  );
}

/** The notice key for rasterColorLossMessage — deliberately not the bare source id the capped/traced pair uses: this one stands *beside* the traced notice, and a shared key would make push() skip the second and dismissNotice() retract the wrong one. */
export function rasterColorLossKey(sourceId: string): string {
  return `${sourceId}:colors`;
}

/** The dropped-color notice for a trace whose floor the placement pins (the nozzle-width floor, which Detail never scales). A bigger design or part is the one lever, and a resize re-traces (app/rebuild.ts), so the color does come back. The printability claim is true here. */
export function rasterSizeColorLossMessage(name: string, dropped: number): string {
  return (
    `${dropped === 1 ? '1 color' : `${dropped} colors`} in "${name}" ` +
    `${dropped === 1 ? 'was' : 'were'} too small to print at this size. ` +
    'Make the design or the part bigger to keep more.'
  );
}

/** The dropped-color notice once Detail can't lower the floor and no placement pins it. No remedy: a bigger size can still lower a flat-art floor there, but no measured rule says when. */
export function rasterFullDetailColorLossMessage(name: string, dropped: number): string {
  return (
    `${dropped === 1 ? '1 color' : `${dropped} colors`} in "${name}" ` +
    `${dropped === 1 ? 'was' : 'were'} dropped. ` +
    `${dropped === 1 ? 'Its' : 'Their'} pieces are too small to trace, even at full Detail.`
  );
}

/**
 * Whether a finished trace should raise rasterColorLossMessage — not simply `droppedColors > 0`: only
 * where raising Detail is an answer the user can give. A capped trace names the color in
 * rasterCappedMessage (opposite remedy); a floor Detail can't lower gets rasterSizeColorLossMessage
 * where the placement pins it, else rasterFullDetailColorLossMessage.
 */
export function rasterLostColors(
  result: Pick<RasterParseResult, 'capped' | 'droppedColors' | 'detailLowersFloor'>,
): boolean {
  return !result.capped && result.detailLowersFloor && result.droppedColors > 0;
}

/** The text for the rasterColorLossKey notice after this trace, or null to retract it. */
export function rasterColorLossNotice(
  name: string,
  result: Pick<RasterParseResult, 'capped' | 'droppedColors' | 'detailLowersFloor' | 'floorReason'>,
): string | null {
  if (result.capped || result.droppedColors === 0) return null;
  if (rasterLostColors(result)) return rasterColorLossMessage(name, result.droppedColors);
  if (result.floorReason === 'printable')
    return rasterSizeColorLossMessage(name, result.droppedColors);
  return rasterFullDetailColorLossMessage(name, result.droppedColors);
}

/** Which remedy an emptied trace gets. 'printable': the placement holds the floor up even at DETAIL_MAX, so only a bigger part or design moves it. 'noise': Detail still has room, or no placement to blame. Measured in parseRasterImage, not inferred from which floor binds now (see rasterEmptyTraceMessage). */
export type FloorReason = 'printable' | 'noise';

/** The empty-trace message: 'printable' offers the size the design is placed at, 'noise' offers Detail and a cleaner source. The arm is measured — see FloorReason. */
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
