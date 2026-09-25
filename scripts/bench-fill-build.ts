// What a whole Fill build costs at a given size: tiling, the per-color union, the clip to the face,
// the cutters and the Manifold cut, through buildAssemblyGeometry itself.
//
// Run with: node_modules/.bin/vite-node scripts/bench-fill-build.ts [pattern] [faceMM] [s,s] [shift]
//   pattern  a name under public/patterns (default zebra)
//   faceMM   side of the square design face on a 10mm-thick box part (default 240)
//   s        Scale values as fractions, so 0.2 is 20% (default 0.5,0.25,0.2,0.15)
//   shift    offset on both axes, in tiles (default 0). A centred fill always needs an odd number
//            of tiles a side; 0.5 gives the even counts.
//
// bench-tile-union.ts times the union alone. This is the number a user waits for, and the one
// FILL_POINT_BUDGET in src/geometry/patterns.ts is set against.
//
// `tiles` is tileCoverage's own count for this placement, taken by handing it the flat mapper's
// map with the face-centre translation and the mirrors left out: the fill anchors a tile's centre
// on the face's centre, and the face is symmetric about it, so neither moves the count. A refused
// fill says its own numbers, which is the check on that.
import * as THREE from 'three';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The same hex-only canvas oracle as bench-tile-union.ts: jsdom has no 2d canvas.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.DOMParser = dom.window.DOMParser;
g.HTMLCanvasElement = dom.window.HTMLCanvasElement;
dom.window.HTMLCanvasElement.prototype.getContext = function () {
  let value = '#000000';
  return {
    get fillStyle() {
      return value;
    },
    set fillStyle(s: string) {
      const str = String(s).trim().toLowerCase();
      if (/^#[0-9a-f]{6}$/.test(str)) value = str;
    },
  };
} as unknown as typeof dom.window.HTMLCanvasElement.prototype.getContext;

const { parseSVGDocument } = await import('../src/svg/parse');
const { computeNetRegionsByColor } = await import('../src/geometry/regions');
const { featureVertexCount, tileCoverage } = await import('../src/geometry/patterns');
const { buildAssemblyGeometry } = await import('../src/geometry/assembly');
const { WARNINGS, clearWarnings } = await import('../src/warnings');
type AssemblyPart = import('../src/types').AssemblyPart;

const pattern = process.argv[2] ?? 'zebra';
const face = Number(process.argv[3] ?? 240);
const scales = (process.argv[4] ?? '0.5,0.25,0.2,0.15').split(',').map(Number);
const shift = Number(process.argv[5] ?? 0);

const parsed = parseSVGDocument(
  readFileSync(path.join(REPO, 'public/patterns', `${pattern}.svg`), 'utf-8'),
);
const vb = parsed.viewBox;
if (!vb || parsed.userUnitMM == null)
  throw new Error(`${pattern}.svg needs a viewBox and a size in mm`);
const { byColor } = await computeNetRegionsByColor(parsed.shapes);
const perTile = Math.max(...Object.values(byColor).map(featureVertexCount));

const geo = new THREE.BoxGeometry(face, 10, face).toNonIndexed();
geo.translate(0, 5, 0);
const h = face / 2;
const part: AssemblyPart = {
  id: 1,
  name: 'bench box',
  roleId: 'role',
  positions: Float32Array.from(geo.attributes.position.array as Float32Array),
  patches: null,
  patchIdx: 0,
  boundaryLoops: [
    [
      [-h, 10, -h],
      [h, 10, -h],
      [h, 10, h],
      [-h, 10, h],
    ],
  ],
  patchNormal: [0, 1, 0],
  topZ: 10,
  baseDepth: 0,
  isDuplicateOf: null,
  pivotX: 0,
  pivotZ: 0,
  angleDeg: 0,
  loaded: true,
  cutThrough: false,
};

console.log(
  `${pattern}.svg on a ${face}mm face, ${perTile} points per tile in its busiest color\n`,
);
console.log('scale\ttiles\tpoints\t\tbuilt\tinlayTris\tms\twarnings');
for (const s of scales) {
  const m = parsed.userUnitMM * s;
  const off = shift * vb.w * m;
  const cx = vb.w / 2,
    cy = vb.h / 2;
  const grid = tileCoverage(
    (pt) => [(pt[0] - cx) * m + off, (pt[1] - cy) * m + off],
    { x: 0, y: 0, w: vb.w, h: vb.h },
    { minX: -h, minY: -h, maxX: h, maxY: h },
    0,
  );
  clearWarnings();
  const t0 = performance.now();
  const built = await buildAssemblyGeometry({
    artworks: [
      {
        parsed,
        scaleMult: s,
        maxScaleMult: 4,
        offX: off,
        offZ: off,
        flipX: false,
        flipY: false,
        rotationDeg: 0,
        mode: 'fill',
      },
    ],
    parts: [part],
    mergeGroups: [],
    colorSettings: {},
    globalDepth: 1,
    radius: 10,
    designFit: 'rect',
  });
  const ms = Math.round(performance.now() - t0);
  const inlays = Object.values(built?.partOutputs[0]?.inlaySoups ?? {});
  const tris = inlays.reduce((n, soup) => n + soup.length / 9, 0);
  const refused = WARNINGS.some((w) => /too detailed|too small to fill/.test(w.message));
  const msgs = WARNINGS.filter((w) => w.level === 'warn').map((w) => w.message.slice(0, 140));
  const tiles = grid?.count ?? NaN;
  console.log(
    [s, tiles, tiles * perTile, refused ? 'refused' : 'filled', tris, ms, msgs.join(' | ')].join(
      '\t',
    ),
  );
}
