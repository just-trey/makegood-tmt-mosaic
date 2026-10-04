// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

/**
 * The rebuild re-traces an image whose placed size has moved its despeckle floor. Driven through
 * the real rebuildAssemblyScene, with the CSG producer and the scene stubbed as in
 * tests/rebuild-scene.test.ts; the scheduler is stubbed so each test says whether its pass settled.
 */
let settled = false;

vi.mock('../src/app/scheduler', () => ({
  scheduleRebuild: vi.fn(),
  rebuildSettled: vi.fn(() => settled),
}));
vi.mock('../src/scene/viewport', () => ({
  newModelGroup: vi.fn(() => new THREE.Group()),
  getModelGroup: vi.fn(() => new THREE.Group()),
  invalidate: vi.fn(),
  setPreferredViewDir: vi.fn(),
  refreshModelShadows: vi.fn(),
  frameModelIfPending: vi.fn(),
  requestFrame: vi.fn(),
  syncToModelGroup: vi.fn(),
  addSceneOverlay: vi.fn(),
}));
vi.mock('../src/geometry/assembly', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/geometry/assembly')>()),
  buildAssemblyGeometry: vi.fn(async () => null),
}));
vi.mock('../src/ui/colorList', () => ({ renderColorList: vi.fn() }));
vi.mock('../src/ui/partPanel', () => ({ renderBaseColorSwatches: vi.fn() }));
vi.mock('../src/ui/warningsView', () => ({ renderWarnings: vi.fn() }));
vi.mock('../src/ui/artworkListPanel', () => ({ renderArtworkList: vi.fn() }));
vi.mock('../src/state/persist', () => ({ schedulePersist: vi.fn() }));
vi.mock('../src/scene/designGizmo', () => ({
  refreshGizmo: vi.fn(),
  isGizmoDragging: () => false,
  tokenColor: (_name: string, fallback: number) => fallback,
}));
vi.mock('../src/scene/zonePick', () => ({ refreshZonePickMeshes: vi.fn() }));
vi.mock('../src/assembly/parts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/assembly/parts')>()),
  asmRebuildGeneratedParts: vi.fn(async () => true),
}));
vi.mock('../src/raster/parse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/raster/parse')>();
  return { ...actual, parseRasterImage: vi.fn(actual.parseRasterImage) };
});
vi.mock('../src/ui/dom', () => ({ $: (sel: string) => document.querySelector(sel) }));

import { rebuildCurrent } from '../src/app/rebuild';
import { scheduleRebuild } from '../src/app/scheduler';
import { asmRebuildGeneratedParts } from '../src/assembly/parts';
import { clearArtwork, loadArtworkSource, rasterMmPerPixel } from '../src/state/artwork';
import { state } from '../src/state/store';
import { parseRasterImage, rasterColorLossKey } from '../src/raster/parse';
import { DETAIL_DEFAULT } from '../src/raster/stats';
import { clearWarnings, notice, WARNINGS } from '../src/warnings';
import type { AssemblyPart, DesignSource, RasterState } from '../src/types';
import type { RasterImage } from '../src/raster/types';

/**
 * Blue and green bands under one-pixel red specks (tests/raster-parse.test.ts's `sprinkled`).
 * 128px across 32mm is 0.25mm a pixel, a nozzle floor of 3px², so the red goes; across 220mm the
 * floor is 1px², the no-op, and the red prints. Without the backdrop the bands are transparent
 * but for one 6x6 blue block, so a small enough placement leaves nothing at all.
 */
function sprinkled(w = 128, backdrop = true): RasterImage {
  const data = new Uint8ClampedArray(w * w * 4);
  for (let p = 0; p < w * w; p++) {
    const x = p % w,
      y = (p / w) | 0;
    const i = p * 4;
    const red = (x * 5 + y * 3) % 17 === 0 && x % 2 === 1 && y % 2 === 1;
    const n = red ? 0xff0000 : x < w / 2 ? 0x0000ff : 0x00c000;
    data[i] = (n >> 16) & 255;
    data[i + 1] = (n >> 8) & 255;
    data[i + 2] = n & 255;
    const block = x >= 10 && x < 16 && y >= 10 && y < 16;
    data[i + 3] = backdrop || red || block ? 255 : 0;
  }
  return { data, w, h: w };
}

/** The hubcap's generated disc, as the design face `memoLargestDesignFace` reads it. */
function hubcap(diameterMm: number): AssemblyPart {
  const r = diameterMm / 2;
  return {
    id: 1,
    name: 'hubcap',
    roleId: 'hubcap',
    positions: new Float32Array([0, 0, 0, 10, 0, 0, 10, 0, 10]),
    patches: [{ normal: [0, 1, 0], offset: 0, area: 100, triIndices: [0] }],
    patchIdx: 0,
    boundaryLoops: [
      [
        [-r, 0, -r],
        [r, 0, -r],
        [r, 0, r],
        [-r, 0, r],
      ],
    ],
    topZ: 0,
    baseDepth: 3,
    isDuplicateOf: null,
    pivotX: 0,
    pivotZ: 0,
    angleDeg: 0,
    loaded: true,
    cutThrough: false,
  } as unknown as AssemblyPart;
}

function loadAt(diameterMm: number, backdrop = true): DesignSource & { raster: RasterState } {
  state.assembly.parts = [hubcap(diameterMm)];
  const image = sprinkled(128, backdrop);
  const opts = { colors: 4, detail: DETAIL_DEFAULT, mmPerPixel: rasterMmPerPixel(image) };
  const result = parseRasterImage(image, opts);
  loadArtworkSource(result.parsed, 'photo.png', 'raster', 'sticker', '', {
    image,
    ...opts,
    palette: result.palette,
    regions: result.componentCount,
  });
  return state.sources[state.sources.length - 1] as DesignSource & { raster: RasterState };
}

beforeEach(() => {
  document.body.innerHTML = '<span id="stat-tris"></span><button id="btn-export"></button>';
  clearArtwork();
  clearWarnings();
  settled = false;
  vi.mocked(scheduleRebuild).mockClear();
  state.assembly.kindId = 'hubcap';
  state.hubcapSilhouette = false;
  state.scalePct = 100;
});

describe('re-tracing after a resize', () => {
  it('re-reads the floor once a resize from 32mm to 220mm has settled', async () => {
    const source = loadAt(32);
    expect(source.raster.mmPerPixel).toBeCloseTo(0.25, 6);
    expect(source.raster.palette).toHaveLength(2);
    const loaded = source.parsed;

    state.assembly.parts = [hubcap(220)];

    // Mid-burst: build with the trace it has and ask for a settled pass, rather than paying for a
    // trace per step of a drag or a held spinner.
    await rebuildCurrent();
    expect(source.parsed).toBe(loaded);
    expect(scheduleRebuild).toHaveBeenCalledWith('typed');

    settled = true;
    await rebuildCurrent();
    expect(source.raster.mmPerPixel).toBeCloseTo(220 / 128, 6);
    expect(source.parsed).not.toBe(loaded);
    expect(source.raster.palette).toHaveLength(3);
  });

  it('leaves a trace alone when the resize did not move its floor', async () => {
    const source = loadAt(220);
    const loaded = source.parsed;
    state.assembly.parts = [hubcap(221)];
    settled = true;

    await rebuildCurrent();

    expect(source.parsed).toBe(loaded);
    expect(scheduleRebuild).not.toHaveBeenCalled();
  });

  it('waits out a placement it cannot read, rather than tracing without one', async () => {
    const source = loadAt(32);
    const loaded = source.parsed;
    // The parts are reloading: no design face, so no size to trace at.
    state.assembly.parts = [];
    settled = true;

    await rebuildCurrent();

    expect(source.parsed).toBe(loaded);
    expect(source.raster.mmPerPixel).toBeCloseTo(0.25, 6);
    expect(scheduleRebuild).not.toHaveBeenCalled();
  });

  it('retracts a dropped-color notice the re-trace answered', async () => {
    const source = loadAt(32);
    notice('1 color in "photo.png" was dropped.', rasterColorLossKey(source.id));
    state.assembly.parts = [hubcap(220)];
    settled = true;

    await rebuildCurrent();

    expect(WARNINGS.find((w) => w.key === rasterColorLossKey(source.id))).toBeUndefined();
    expect(WARNINGS.find((w) => w.key === source.id)?.level).toBe('info');
  });

  it('keeps the old trace, and says why, when the new size leaves nothing to print', async () => {
    const source = loadAt(220, false);
    const loaded = source.parsed;
    notice('"photo.png" was traced from a photo.', source.id);
    state.assembly.parts = [hubcap(2)];
    settled = true;

    await rebuildCurrent();

    expect(source.parsed).toBe(loaded);
    const failed = () => WARNINGS.find((w) => w.key === `${source.id}:retrace`);
    expect(failed()?.level).toBe('warn');
    expect(failed()?.message).toMatch(/bigger/);
    // The kept trace keeps what it said about itself.
    expect(WARNINGS.find((w) => w.key === source.id)?.level).toBe('info');

    // Not re-run on every later pass: the same floors would throw the same way.
    vi.mocked(parseRasterImage).mockClear();
    await rebuildCurrent();
    expect(parseRasterImage).not.toHaveBeenCalled();
    expect(failed()).toBeDefined();

    // Back at the size it was traced for, the failure no longer describes anything on screen.
    state.assembly.parts = [hubcap(220)];
    await rebuildCurrent();
    expect(failed()).toBeUndefined();
    expect(source.parsed).toBe(loaded);
    expect(vi.mocked(scheduleRebuild)).not.toHaveBeenCalled();
  });

  it('cuts a hubcap shaped to the artwork before reading its size, then again to the new trace', async () => {
    const source = loadAt(32);
    const loaded = source.parsed;
    state.hubcapSilhouette = true;
    const seen: unknown[] = [];
    vi.mocked(asmRebuildGeneratedParts).mockImplementation(async () => {
      seen.push(source.parsed);
      return true;
    });
    state.assembly.parts = [hubcap(220)];
    settled = true;

    await rebuildCurrent();

    expect(source.parsed).not.toBe(loaded);
    expect(seen).toEqual([loaded, source.parsed]);
  });
});
