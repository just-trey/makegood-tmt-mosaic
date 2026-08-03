// @vitest-environment jsdom
import { describe, expect, it, beforeAll, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import type { AssemblyPart, AssemblyPartOutput } from '../src/types';

vi.mock('../src/app/rebuild', () => ({
  getLastAssemblyBuild: vi.fn(),
  getLastBuild: vi.fn(),
}));
vi.mock('../src/geometry/assembly', () => ({
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
  getPrinter: vi.fn(() => ({ label: 'Test Printer', amsSlotsPerUnit: 4, amsSlotsMax: 16 })),
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
import { SLOT_MULTI_UNIT_NOTICE_SUFFIX, SLOT_OVER_MAX_WARNING_SUFFIX } from '../src/ui/slotBudget';
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
  clearWarnings();
  vi.mocked(getPrinter).mockReturnValue({
    label: 'Test Printer',
    amsSlotsPerUnit: 4,
    amsSlotsMax: 16,
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

function buildWithPalette(n: number): void {
  vi.mocked(getLastAssemblyBuild).mockReturnValue({
    partOutputs: [partOutput()],
    palette: paletteOf(n),
    viewSign: 1,
    detectedColors: [],
    baseAssigned: null,
  });
}

describe('exportPrintReady3MF — AMS slot budget', () => {
  const slotNotices = (): { message: string; level: string }[] =>
    WARNINGS.filter(
      (w) =>
        w.message.endsWith(SLOT_MULTI_UNIT_NOTICE_SUFFIX) ||
        w.message.endsWith(SLOT_OVER_MAX_WARNING_SUFFIX),
    );

  // the tiers themselves are tests/slotBudget.test.ts's job; what matters here is that the export
  // path feeds it the *export's* material count (body + every palette entry), not the color list's
  it('posts the pill against the export’s own material count', async () => {
    buildWithPalette(4); // + the body's own slot = 5, past one unit's 4

    await exportPrintReady3MF();

    expect(slotNotices()).toHaveLength(1);
    expect(slotNotices()[0].level).toBe('info');
    expect(slotNotices()[0].message).toContain('5 AMS slots needed');
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
