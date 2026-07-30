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
  getPrinter: vi.fn(() => ({})),
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
