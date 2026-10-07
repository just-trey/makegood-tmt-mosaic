// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/app/scheduler', () => ({ scheduleRebuild: vi.fn() }));
vi.mock('../src/scene/viewport', () => ({ requestFrame: vi.fn() }));
vi.mock('../src/ui/overlay', () => ({ showOverlay: vi.fn(), hideOverlay: vi.fn() }));
vi.mock('../src/analytics/track', () => ({ track: vi.fn() }));
vi.mock('../src/ui/dialogs', () => ({ confirmDialog: vi.fn(), alertDialog: vi.fn() }));

import { asmLoadFullAssembly } from '../src/assembly/parts';
import { asmSwitchKindAndLoad } from '../src/assembly/switchKind';
import { state } from '../src/state/store';
import { confirmDialog } from '../src/ui/dialogs';
import { WARNINGS, clearWarnings } from '../src/warnings';

/** Binary STL: one 20x20 +Z face, enough for face detection. */
function stl(): ArrayBuffer {
  const tris = [
    [
      [0, 0, 10],
      [20, 0, 10],
      [20, 20, 10],
    ],
    [
      [0, 0, 10],
      [20, 20, 10],
      [0, 20, 10],
    ],
  ];
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  tris.forEach((tri, i) => {
    let o = 84 + i * 50 + 12;
    for (const v of tri)
      for (const c of v) {
        dv.setFloat32(o, c, true);
        o += 4;
      }
  });
  return buf;
}

let missing: Set<string>;
const missingNotices = () => WARNINGS.filter((w) => /export will be missing/.test(w.message));

beforeEach(() => {
  clearWarnings();
  missing = new Set(['stl/wheel-half.stl']);
  state.assembly.kindId = 'wheel';
  state.assembly.variantId = null;
  state.assembly.parts = [];
  state.assembly.library = [
    { id: 'wheel-half', name: 'Wheel', file: 'stl/wheel-half.stl' },
    { id: 'wheel-hub-cap', name: 'Cap', file: 'stl/wheel-hub-cap.stl' },
    { id: 'footrest', name: 'Footrest', file: 'stl/footrest.stl' },
  ];
  vi.mocked(confirmDialog).mockResolvedValue(true);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      missing.has(url)
        ? { ok: false, status: 404 }
        : { ok: true, status: 200, arrayBuffer: async () => stl() },
    ),
  );
});

describe('a part that failed to load', () => {
  it('leaves a standing warning naming it once the alert is gone', async () => {
    expect(await asmLoadFullAssembly()).toBe('failed');
    const w = missingNotices();
    expect(w).toHaveLength(1);
    expect(w[0].message).toContain('"Top"');
    expect(w[0].message).not.toContain('"Cap"');
  });

  it('clears when a later load succeeds', async () => {
    await asmLoadFullAssembly();
    missing.clear();
    expect(await asmLoadFullAssembly()).toBe('loaded');
    expect(missingNotices()).toHaveLength(0);
  });

  it('clears when the kind changes', async () => {
    await asmLoadFullAssembly();
    expect(await asmSwitchKindAndLoad('footrest', null)).toBe('loaded');
    expect(missingNotices()).toHaveLength(0);
  });

  it('survives a failed switch that puts the broken kind back', async () => {
    await asmLoadFullAssembly();
    missing.add('stl/footrest.stl');
    expect(await asmSwitchKindAndLoad('footrest', null)).toBe('failed');
    expect(state.assembly.kindId).toBe('wheel');
    expect(missingNotices()).toHaveLength(1);
  });

  it('is not left behind by a quiet load that was rolled back', async () => {
    missing.clear();
    await asmLoadFullAssembly();
    missing.add('stl/footrest.stl');
    expect(await asmSwitchKindAndLoad('footrest', null)).toBe('failed');
    expect(state.assembly.kindId).toBe('wheel');
    expect(missingNotices()).toHaveLength(0);
  });
});
