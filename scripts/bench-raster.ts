// Measures what a traced raster actually costs the region pipeline, and settles the two numbers
// the raster plan deliberately left to measurement: the working resolution (MAX_WORKING_EDGE) and
// whether shapes should be grouped per color or per connected component.
//
//   node_modules/.bin/vite-node scripts/bench-raster.ts [size...]
//
// The two costs pull in opposite directions and neither can be reasoned about from the other:
//
//   - `shapeToFeature` resolves hole-vs-solid by testing every ring in a shape against every other
//     ring, so it is O(rings² · len) *within one shape*. Grouping per color puts every ring of a
//     color in one shape and is the expensive case here. It also runs synchronously, before
//     computeNetRegionsByColor's first yield, so whatever it costs is frozen main thread.
//   - The paint-order pass runs ~3 polygon booleans per shape against a growing accumulator, so
//     grouping per component (hundreds of shapes) is the expensive case there. That pass is the
//     ~9s-on-135-paths hot spot recorded in docs/tech-debt.md.
//
// Synthetic images rather than real files on purpose: this bench is about the shape of the cost
// curve, and procedural sources let the ring count be pushed well past what a real image produces
// to find where each strategy breaks. Threshold calibration against real artwork is a separate job.
import { parseRasterImage } from '../src/raster/parse';
import type { ShapeGranularity } from '../src/raster/parse';
import { computeNetRegionsByColor, shapeToFeature } from '../src/geometry/regions';
import { DETAIL_DEFAULT } from '../src/raster/stats';
import type { RasterImage } from '../src/raster/types';
import type { SVGShape } from '../src/types';

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise — the closest a procedural source gets to a photograph's local structure. */
function valueNoise(
  w: number,
  h: number,
  cells: number,
  seed: number,
): (x: number, y: number) => number {
  const rng = mulberry32(seed);
  const g: number[] = [];
  for (let i = 0; i < (cells + 1) * (cells + 1); i++) g.push(rng());
  const at = (i: number, j: number) => g[Math.min(cells, j) * (cells + 1) + Math.min(cells, i)];
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (x, y) => {
    const fx = (x / w) * cells,
      fy = (y / h) * cells;
    const i = Math.floor(fx),
      j = Math.floor(fy);
    const tx = smooth(fx - i),
      ty = smooth(fy - j);
    const a = at(i, j) + (at(i + 1, j) - at(i, j)) * tx;
    const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * tx;
    return a + (b - a) * ty;
  };
}

function photoLike(w: number, h: number): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  const r = valueNoise(w, h, 14, 1);
  const g = valueNoise(w, h, 11, 2);
  const b = valueNoise(w, h, 9, 3);
  const grain = mulberry32(7);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const n = (grain() - 0.5) * 18;
      data[i] = r(x, y) * 255 + n;
      data[i + 1] = g(x, y) * 255 + n;
      data[i + 2] = b(x, y) * 255 + n;
      data[i + 3] = 255;
    }
  return { data, w, h };
}

function flatArtLike(w: number, h: number): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  const field = valueNoise(w, h, 5, 42);
  const palette = [
    [232, 62, 62],
    [46, 134, 222],
    [253, 203, 110],
    [39, 174, 96],
    [44, 62, 80],
  ];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const c = palette[Math.min(palette.length - 1, Math.floor(field(x, y) * palette.length))];
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  return { data, w, h };
}

function ringStats(shapes: SVGShape[]) {
  let rings = 0,
    points = 0,
    maxRings = 0;
  for (const s of shapes) {
    rings += s.loops.length;
    maxRings = Math.max(maxRings, s.loops.length);
    for (const l of s.loops) points += l.length;
  }
  return { rings, points, maxRings };
}

async function run(name: string, img: RasterImage, granularity: ShapeGranularity) {
  const t0 = performance.now();
  const { parsed, palette, componentCount, capped } = parseRasterImage(
    img,
    { colors: 8, detail: DETAIL_DEFAULT },
    granularity,
  );
  const traceMs = performance.now() - t0;

  const { rings, points, maxRings } = ringStats(parsed.shapes);

  const t1 = performance.now();
  for (const s of parsed.shapes) shapeToFeature(s);
  const stfMs = performance.now() - t1;

  const t2 = performance.now();
  await computeNetRegionsByColor(parsed.shapes, () => {});
  const regionsMs = performance.now() - t2;

  return {
    name,
    granularity,
    size: `${img.w}x${img.h}`,
    colors: palette.length,
    components: componentCount,
    shapes: parsed.shapes.length,
    rings,
    maxRings,
    points,
    capped,
    traceMs: +traceMs.toFixed(1),
    stfMs: +stfMs.toFixed(1),
    regionsMs: +regionsMs.toFixed(1),
    totalMs: +(traceMs + regionsMs).toFixed(1),
  };
}

const sizes = process.argv.slice(2).map(Number).filter(Boolean);
const rows = [];
for (const size of sizes.length ? sizes : [384, 512, 768]) {
  for (const [name, make] of [
    ['flat-art', flatArtLike],
    ['photo', photoLike],
  ] as const) {
    const img = make(size, size);
    for (const g of ['color', 'component'] as const) rows.push(await run(name, img, g));
  }
}
console.table(rows);
console.log(
  '\nYIELD_BUDGET_MS is 30. `stfMs` is synchronous main-thread time before the first yield;\n' +
    'anything near or above 30 there is a visible stall with a frozen progress curtain.',
);
