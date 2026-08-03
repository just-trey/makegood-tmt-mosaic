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
  getPrinter: vi.fn(() => ({ label: 'Test Printer', amsSlotCapacity: 4 })),
  DEFAULT_PRINTER_ID: 'p1',
}));
vi.mock('../src/ui/overlay', () => ({
  showOverlay: vi.fn(),
  hideOverlay: vi.fn(),
}));
vi.mock('../src/analytics/track', () => ({
  track: vi.fn(),
}));

import { exportPrintReady3MF, SLOT_CAPACITY_WARNING_SUFFIX } from '../src/ui/exportPanel';
import { getLastAssemblyBuild } from '../src/app/rebuild';
import { build3MFCombined } from '../src/export/threemf';
import { state } from '../src/state/store';
import { WARNINGS, clearWarnings, clearBuildWarnings } from '../src/warnings';

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

describe('exportPrintReady3MF — AMS slot capacity', () => {
  const capacityWarnings = (): string[] =>
    WARNINGS.filter((w) => w.message.endsWith(SLOT_CAPACITY_WARNING_SUFFIX)).map((w) => w.message);

  it('warns when the export needs more slots than a single AMS holds', async () => {
    buildWithPalette(4); // + the body's own slot = 5, against a capacity of 4

    await exportPrintReady3MF();

    expect(capacityWarnings()).toHaveLength(1);
    expect(capacityWarnings()[0]).toContain('5 AMS slots needed');
    expect(capacityWarnings()[0]).toContain('Test Printer');
  });

  it('stays quiet when the export fits, and clears a previous export’s warning', async () => {
    buildWithPalette(4);
    await exportPrintReady3MF();
    expect(capacityWarnings()).toHaveLength(1);

    buildWithPalette(2); // 3 slots, fits
    await exportPrintReady3MF();

    expect(capacityWarnings()).toEqual([]);
  });

  it('is build-scoped, so acting on it (merging colors down) drops the pill', async () => {
    buildWithPalette(4);
    await exportPrintReady3MF();
    expect(capacityWarnings()).toHaveLength(1);

    clearBuildWarnings();

    expect(capacityWarnings()).toEqual([]);
  });
});
