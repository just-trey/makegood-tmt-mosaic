// @vitest-environment jsdom
import { describe, expect, it, beforeAll, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import type { AssemblyPart, AssemblyPartOutput } from '../src/types';

vi.mock('../src/app/rebuild', () => ({
  getLastAssemblyBuild: vi.fn(),
  getLastBuild: vi.fn(),
}));
vi.mock('../src/geometry/assembly', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/geometry/assembly')>()),
  asmPartFaceNormal: vi.fn(() => null),
}));
vi.mock('../src/export/threemf', () => ({
  build3MFCombined: vi.fn().mockResolvedValue({ blob: new Blob(), warnings: [] }),
}));
vi.mock('../src/export/placement', () => ({
  resolvePlacement: vi.fn(() => ({ verified: true, placement: {} })),
  placementNotice: vi.fn(() => null),
}));
vi.mock('../src/export/printers', () => ({
  getPrinter: vi.fn(() => ({
    label: 'Test Printer',
    slotsPerUnit: 4,
    slotsMax: 16,
    unitLabel: 'AMS unit',
  })),
  DEFAULT_PRINTER_ID: 'p1',
}));
vi.mock('../src/ui/overlay', () => ({
  showOverlay: vi.fn(),
  hideOverlay: vi.fn(),
}));
vi.mock('../src/analytics/track', () => ({
  track: vi.fn(),
}));

import { exportPrintReady3MF } from '../src/ui/exportPanel';
import {
  refreshSlotBudgetNotice,
  SLOT_MULTI_UNIT_NOTICE_SUFFIX,
  SLOT_OVER_MAX_WARNING_SUFFIX,
} from '../src/ui/slotBudget';
import { getPrinter } from '../src/export/printers';
import { getLastAssemblyBuild } from '../src/app/rebuild';
import { build3MFCombined } from '../src/export/threemf';
import { state } from '../src/state/store';
import { WARNINGS, clearWarnings } from '../src/warnings';

function boxPart(overrides: Partial<AssemblyPart> = {}): AssemblyPart {
  const geo = new THREE.BoxGeometry(40, 10, 40).toNonIndexed();
  geo.translate(0, 5, 0);
  return {
    id: 1,
    name: 'test part',
    roleId: 'role',
    positions: Float32Array.from(geo.attributes.position.array as Float32Array),
    patches: null,
    patchIdx: 0,
    boundaryLoop: [
      [-20, 10, -20],
      [20, 10, -20],
      [20, 10, 20],
      [-20, 10, 20],
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
  } as AssemblyPart;
}

function partOutput(overrides: Partial<AssemblyPartOutput> = {}): AssemblyPartOutput {
  return {
    part: boxPart(),
    bodySoup: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    inlaySoups: {},
    ...overrides,
  };
}

beforeAll(() => {
  global.URL.createObjectURL = vi.fn(() => 'blob:mock') as unknown as typeof URL.createObjectURL;
});

beforeEach(() => {
  vi.mocked(getLastAssemblyBuild).mockReset();
  vi.mocked(build3MFCombined).mockClear();
  // resets slotBudget's module-level "what's posted" memory, which would otherwise make the next
  // test's identical pill look like one the user had dismissed
  refreshSlotBudgetNotice(0);
  clearWarnings();
  vi.mocked(getPrinter).mockReturnValue({
    label: 'Test Printer',
    slotsPerUnit: 4,
    slotsMax: 16,
    unitLabel: 'AMS unit',
  } as ReturnType<typeof getPrinter>);
  document.body.innerHTML = '<div id="warnings"></div>';
  state.shapeKind = 'assembly';
  state.printerId = 'p1';
});

describe('exportPrintReady3MF — parts consumed entirely by their cut', () => {
  it('excludes a part with an empty bodySoup from the export and warns naming it', async () => {
    const good = partOutput({ part: boxPart({ name: 'Good Part' }) });
    const consumed = partOutput({
      part: boxPart({ name: 'Consumed Part' }),
      bodySoup: new Float32Array(0),
    });
    vi.mocked(getLastAssemblyBuild).mockReturnValue({
      partOutputs: [good, consumed],
      palette: [],
      viewSign: 1,
      detectedColors: [],
      baseAssigned: null,
    });

    await exportPrintReady3MF();

    const [, exportedParts] = vi.mocked(build3MFCombined).mock.calls[0];
    expect(exportedParts.map((p) => p.name)).toEqual(['Good Part']);

    expect(
      WARNINGS.some((w) => w.message.includes('Consumed Part') && /pocket cut/i.test(w.message)),
    ).toBe(true);
  });
});

function paletteOf(n: number): { hex: string; key: string; members: string[]; isMerge: boolean }[] {
  return Array.from({ length: n }, (_, i) => {
    const hex = `#00000${i}`;
    return { hex, key: hex, members: [hex], isMerge: false };
  });
}

const inlayTri = (): Float32Array => Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]);

function buildWithPalette(n: number): void {
  // every palette color carries an inlay: a color with none is dropped from the materials
  const inlaySoups = Object.fromEntries(Array.from({ length: n }, (_, i) => [i, inlayTri()]));
  vi.mocked(getLastAssemblyBuild).mockReturnValue({
    partOutputs: [partOutput({ inlaySoups })],
    palette: paletteOf(n),
    viewSign: 1,
    detectedColors: [],
    baseAssigned: null,
  });
}

describe('exportPrintReady3MF — filament slot budget', () => {
  const slotNotices = (): { message: string; level: string }[] =>
    WARNINGS.filter(
      (w) =>
        w.message.endsWith(SLOT_MULTI_UNIT_NOTICE_SUFFIX) ||
        w.message.endsWith(SLOT_OVER_MAX_WARNING_SUFFIX),
    );

  // the tiers themselves are tests/slotBudget.test.ts's job; what matters here is that the export
  // path feeds it the *export's* material count (body + every palette color that actually cut an
  // inlay somewhere), not the color list's
  it('posts the pill against the export’s own material count', async () => {
    buildWithPalette(4); // + the body's own slot = 5, past one unit's 4

    await exportPrintReady3MF();

    expect(slotNotices()).toHaveLength(1);
    expect(slotNotices()[0].level).toBe('info');
    expect(slotNotices()[0].message).toContain('5 filament slots needed');
  });

  it('re-evaluates rather than leaving the previous export’s pill up', async () => {
    buildWithPalette(16); // 17 slots, past the 16 max
    await exportPrintReady3MF();
    expect(slotNotices()[0].level).toBe('warn');

    buildWithPalette(2); // 3 slots, fits a single unit
    await exportPrintReady3MF();

    expect(slotNotices()).toEqual([]);
  });
});

describe('exportPrintReady3MF — palette colors with no inlay on any part', () => {
  it('drops them from the materials and remaps the remaining inlays', async () => {
    // the phantom-slot defect: a color clipped off every part shipped as a filament_colour entry
    // nothing referenced, so the exported project asked for filaments that print nothing
    vi.mocked(getLastAssemblyBuild).mockReturnValue({
      partOutputs: [partOutput({ inlaySoups: { 1: inlayTri() } })],
      palette: paletteOf(3), // colors 0 and 2 never landed anywhere
      viewSign: 1,
      detectedColors: [],
      baseAssigned: null,
    });

    await exportPrintReady3MF();

    const [materials, exportedParts] = vi.mocked(build3MFCombined).mock.calls[0];
    expect(materials).toHaveLength(2); // Body + the one color with an inlay
    expect(materials[1].color).toBe('#000001');
    const subs = exportedParts[0].subs;
    expect(subs.map((s) => s.matIndex)).toEqual([0, 1]); // Body, then the one real inlay
  });

  it('drops a color whose only inlay sits on a part the export excludes', async () => {
    // a part consumed by its own cut is dropped with its inlays, so a color living only there
    // must not become a material either
    vi.mocked(getLastAssemblyBuild).mockReturnValue({
      partOutputs: [
        partOutput({ bodySoup: new Float32Array(0), inlaySoups: { 0: inlayTri() } }),
        partOutput({ inlaySoups: { 1: inlayTri() } }),
      ],
      palette: paletteOf(2),
      viewSign: 1,
      detectedColors: [],
      baseAssigned: null,
    });

    await exportPrintReady3MF();

    const [materials] = vi.mocked(build3MFCombined).mock.calls[0];
    expect(materials).toHaveLength(2); // Body + the surviving part's color
    expect(materials[1].color).toBe('#000001');
  });

  it('does not count them toward the filament slot pill', async () => {
    vi.mocked(getPrinter).mockReturnValue({
      label: 'Test Printer',
      slotsPerUnit: 4,
      slotsMax: 16,
      unitLabel: 'AMS unit',
    } as ReturnType<typeof getPrinter>);
    // 6 palette colors, only 2 with inlays: 3 materials with the body, well inside one unit
    vi.mocked(getLastAssemblyBuild).mockReturnValue({
      partOutputs: [partOutput({ inlaySoups: { 0: inlayTri(), 3: inlayTri() } })],
      palette: paletteOf(6),
      viewSign: 1,
      detectedColors: [],
      baseAssigned: null,
    });

    await exportPrintReady3MF();

    expect(
      WARNINGS.filter(
        (w) =>
          w.message.endsWith(SLOT_MULTI_UNIT_NOTICE_SUFFIX) ||
          w.message.endsWith(SLOT_OVER_MAX_WARNING_SUFFIX),
      ),
    ).toEqual([]);
  });
});
