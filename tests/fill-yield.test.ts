import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

// One switch for the whole file: the failure test flips it to make the fill's cut-back fail the
// way polygon-clipping does, subject handed back whole.
const fault = vi.hoisted(() => ({ failYield: false }));
vi.mock('../src/geometry/regions', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/geometry/regions')>();
  return {
    ...real,
    differenceAllChecked: (
      ...args: Parameters<typeof real.differenceAllChecked>
    ): ReturnType<typeof real.differenceAllChecked> =>
      fault.failYield
        ? { feat: real.cleanFeature(args[0]), trimmed: false }
        : real.differenceAllChecked(...args),
  };
});

import {
  buildAssemblyGeometry,
  fillCoveredNotice,
  fillYieldFailedWarning,
  unprintableSpeckNotice,
  type ArtworkBuildInput,
  type AssemblyBuildInput,
} from '../src/geometry/assembly';
import {
  getManifold,
  manifoldDelete,
  soupToManifold,
  type ManifoldAPI,
} from '../src/geometry/manifold';
import type { AssemblyBuild, AssemblyPart, ParsedSVG } from '../src/types';
import { WARNINGS, clearWarnings } from '../src/warnings';

let wasm: ManifoldAPI;
beforeAll(async () => {
  wasm = await getManifold();
});

let nextId = 1;
/** A `size`-square, 10mm-tall box whose top face is the design face, centred on the origin. */
function box(size: number, overrides: Partial<AssemblyPart> = {}): AssemblyPart {
  const geo = new THREE.BoxGeometry(size, 10, size).toNonIndexed();
  geo.translate(0, 5, 0);
  const h = size / 2;
  return {
    id: nextId++,
    name: `box ${size}`,
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
    ...overrides,
  };
}

const rect = (x0: number, y0: number, x1: number, y1: number) => [
  [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
    { x: x0, y: y0 },
  ],
];

/** One period of a red pattern: a 4mm square centred in a 10mm tile, so squares sit at ±2 + 10k. */
function redTile(): ParsedSVG {
  return {
    shapes: [{ fill: '#ff0000', loops: rect(3, 3, 7, 7), order: 0 }],
    bbox: { minX: 3, minY: 3, maxX: 7, maxY: 7 },
    rawSVGCircle: null,
    userUnitMM: 1,
    viewBox: { w: 10, h: 10 },
  };
}

/**
 * A blue sticker drawn 1:1 in mm on a 100mm canvas, which rect placement centres on the face: the
 * rectangle given in face millimetres lands exactly there.
 */
function blueSticker(x0: number, z0: number, x1: number, z1: number): ParsedSVG {
  return {
    shapes: [{ fill: '#0000ff', loops: rect(x0 + 50, z0 + 50, x1 + 50, z1 + 50), order: 0 }],
    bbox: { minX: x0 + 50, minY: z0 + 50, maxX: x1 + 50, maxY: z1 + 50 },
    rawSVGCircle: null,
    userUnitMM: 1,
    viewBox: { w: 100, h: 100 },
    canvas: { w: 100, h: 100 },
  };
}

const art = (parsed: ParsedSVG, mode: 'fill' | 'sticker'): ArtworkBuildInput => ({
  parsed,
  name: mode === 'fill' ? 'pattern' : 'logo',
  zoneId: null,
  scaleMult: 1,
  maxScaleMult: 4,
  offX: 0,
  offZ: 0,
  flipX: false,
  flipY: false,
  rotationDeg: 0,
  mode,
});

const input = (artworks: ArtworkBuildInput[], parts: AssemblyPart[]): AssemblyBuildInput => ({
  artworks,
  parts,
  mergeGroups: [],
  colorSettings: {},
  globalDepth: 2,
  radius: 10,
  designFit: 'rect',
});

function volume(soup: Float32Array | undefined): number {
  if (!soup) return 0;
  const m = soupToManifold(wasm, soup);
  const v = m.volume();
  manifoldDelete(m);
  return v;
}

/** The volume a part's red and blue inlays share: two solids in one space in the export. */
function sharedVolume(built: AssemblyBuild, partIdx = 0): number {
  const idx = (hex: string) => built.palette.findIndex((c) => c.hex === hex);
  const soups = built.partOutputs[partIdx].inlaySoups;
  const red = soups[idx('#ff0000')];
  const blue = soups[idx('#0000ff')];
  if (!red || !blue) return 0;
  const a = soupToManifold(wasm, red);
  const b = soupToManifold(wasm, blue);
  const both = wasm.Manifold.intersection(a, b);
  const v = both.volume();
  [a, b, both].forEach(manifoldDelete);
  return v;
}

const inlayVolume = (built: AssemblyBuild, hex: string, partIdx = 0): number =>
  volume(built.partOutputs[partIdx].inlaySoups[built.palette.findIndex((c) => c.hex === hex)]);

const messages = (): string[] => WARNINGS.map((w) => w.message);

describe('a Fill under a Sticker', () => {
  // The sticker covers x,z in [-9, 9]: the whole centre square, a 1 x 4mm strip of the four beside
  // it and a 1mm corner of the four diagonal ones, so 16 + 16 + 4 = 36mm² of red sits under blue.
  const sticker = () => blueSticker(-9, -9, 9, 9);

  it.each([
    ['fill first', [art(redTile(), 'fill'), art(sticker(), 'sticker')]],
    ['sticker first', [art(sticker(), 'sticker'), art(redTile(), 'fill')]],
  ])(
    'exports no two inlays in the same space, whichever is listed first (%s)',
    { timeout: 60000 },
    async (_order, artworks) => {
      clearWarnings();
      const alone = (await buildAssemblyGeometry(input([art(redTile(), 'fill')], [box(40)])))!;
      const built = (await buildAssemblyGeometry(input(artworks, [box(40)])))!;
      expect(sharedVolume(built)).toBeLessThan(1e-6);
      // What went is exactly what the sticker covers, and the sticker keeps all of its own.
      expect(inlayVolume(alone, '#ff0000') - inlayVolume(built, '#ff0000')).toBeCloseTo(36 * 2, 3);
      expect(inlayVolume(built, '#0000ff')).toBeCloseTo(18 * 18 * 2, 3);
      expect(messages()).toEqual([]);
    },
  );

  it('says so when the sticker hides a fill color on every part', { timeout: 60000 }, async () => {
    clearWarnings();
    const built = (await buildAssemblyGeometry(
      input([art(redTile(), 'fill'), art(blueSticker(-30, -30, 30, 30), 'sticker')], [box(40)]),
    ))!;
    expect(inlayVolume(built, '#ff0000')).toBe(0);
    expect(inlayVolume(built, '#0000ff')).toBeCloseTo(40 * 40 * 2, 3);
    expect(messages()).toEqual([fillCoveredNotice('#ff0000')]);
  });

  it('says it is hidden, not off the part, on a cut-through part', { timeout: 60000 }, async () => {
    clearWarnings();
    // 60mm from the centre on each side reaches every tile the fill lays past the 40mm box.
    await buildAssemblyGeometry(
      input(
        [art(redTile(), 'fill'), art(blueSticker(-60, -60, 60, 60), 'sticker')],
        [box(40, { cutThrough: true, cutThroughDepth: 2 })],
      ),
    );
    expect(messages()).toEqual([fillCoveredNotice('#ff0000')]);
  });

  it('says nothing when the color it hides on one part prints on another', async () => {
    clearWarnings();
    // The same 60mm sticker hides all of the 40mm box and only the middle of the 80mm one.
    const built = (await buildAssemblyGeometry(
      input(
        [art(redTile(), 'fill'), art(blueSticker(-30, -30, 30, 30), 'sticker')],
        [box(40), box(80)],
      ),
    ))!;
    expect(inlayVolume(built, '#ff0000', 1)).toBeGreaterThan(0);
    expect(messages()).toEqual([]);
  }, 60000);

  it('says only that the detail is too fine when a sliver is all a part keeps', async () => {
    clearWarnings();
    // The 40mm box is hidden outright. On the 62mm one the sticker stops 0.02mm short of its edge,
    // so each clipped square keeps a tip of at most 0.12mm²: the color reached that face and was
    // too small to print there, which is not the same as being hidden everywhere.
    await buildAssemblyGeometry(
      input(
        [art(redTile(), 'fill'), art(blueSticker(-30.98, -30.98, 30.98, 30.98), 'sticker')],
        [box(40), box(62)],
      ),
    );
    expect(messages()).toEqual([unprintableSpeckNotice('#ff0000', 'box 62')]);
  }, 60000);

  it('keeps the fill and names the color when cutting it back fails', async () => {
    clearWarnings();
    fault.failYield = true;
    try {
      const built = (await buildAssemblyGeometry(
        input([art(redTile(), 'fill'), art(blueSticker(-9, -9, 9, 9), 'sticker')], [box(40)]),
      ))!;
      // The overlap this exists to prevent comes back, which is what the warning says.
      expect(sharedVolume(built)).toBeCloseTo(36 * 2, 3);
      expect(inlayVolume(built, '#0000ff')).toBeCloseTo(18 * 18 * 2, 3);
      expect(messages()).toEqual([fillYieldFailedWarning('#ff0000', 'pattern', 'box 40')]);
    } finally {
      fault.failYield = false;
    }
  }, 60000);

  // A cut-through part has no boundary to clip to, so its fill still reaches past the mesh. Here a
  // strip of sticker leaves the tip of one square, 0.03 x 4mm, outside the 40mm box: too small to
  // print, and not on the part either, so naming it as detail on the part would be false.
  it('names no specks off a cut-through part', { timeout: 60000 }, async () => {
    clearWarnings();
    const built = (await buildAssemblyGeometry(
      input(
        [art(redTile(), 'fill'), art(blueSticker(-30, -3, 21.97, 3), 'sticker')],
        [box(40, { cutThrough: true, cutThroughDepth: 2 })],
      ),
    ))!;
    expect(inlayVolume(built, '#ff0000')).toBeGreaterThan(0);
    expect(messages()).toEqual([]);
  });
});
