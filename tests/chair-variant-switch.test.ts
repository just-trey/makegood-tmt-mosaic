// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/app/scheduler', () => ({ scheduleRebuild: vi.fn() }));
vi.mock('../src/scene/viewport', () => ({ requestFrame: vi.fn() }));
vi.mock('../src/ui/overlay', () => ({ showOverlay: vi.fn(), hideOverlay: vi.fn() }));
vi.mock('../src/analytics/track', () => ({ track: vi.fn() }));

import { switchChairVariant } from '../src/assembly/parts';
import { track as trackMock } from '../src/analytics/track';
import { state } from '../src/state/store';
import type { AssemblyPart } from '../src/types';

// A minimal loaded part for one role — the caster/variant-reload tests only care about roleId.
function fakePart(id: number, roleId: string): AssemblyPart {
  return {
    id,
    name: roleId,
    roleId,
    positions: null,
    patches: null,
    patchIdx: 0,
    boundaryLoop: null,
    topZ: 0,
    baseDepth: 3,
    isDuplicateOf: null,
    pivotX: 0,
    pivotZ: 0,
    angleDeg: 0,
    loaded: true,
    cutThrough: false,
  };
}

beforeEach(() => {
  state.assembly.kindId = 'chair-body';
  state.assembly.variantId = 'standard';
  state.assembly.parts = [];
  state.assembly.library = [];
  vi.mocked(trackMock).mockClear();
});

afterEach(() => {
  state.assembly.kindId = null;
  state.assembly.variantId = null;
  state.assembly.parts = [];
  vi.unstubAllGlobals();
});

describe('switchChairVariant', () => {
  it('is a no-op when the target variant is already current', async () => {
    const confirmSpy = vi.fn();
    vi.stubGlobal('confirm', confirmSpy);

    await switchChairVariant('standard');

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(state.assembly.variantId).toBe('standard');
    expect(vi.mocked(trackMock)).not.toHaveBeenCalled();
  });

  it('is a no-op for a kind with no variants', async () => {
    state.assembly.kindId = 'wheel';
    const confirmSpy = vi.fn();
    vi.stubGlobal('confirm', confirmSpy);

    await switchChairVariant('kit');

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(state.assembly.variantId).toBe('standard'); // untouched
  });

  it('switches without confirming when no variant-dependent role is loaded yet', async () => {
    state.assembly.parts = [fakePart(1, 'handle-left')];
    const confirmSpy = vi.fn();
    vi.stubGlobal('confirm', confirmSpy);

    await switchChairVariant('kit');

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(state.assembly.variantId).toBe('kit');
    // the unrelated part survives; fresh (unloaded) caster-left/caster-right parts were added
    expect(state.assembly.parts.map((p) => p.roleId).sort()).toEqual([
      'caster-left',
      'caster-right',
      'handle-left',
    ]);
    expect(vi.mocked(trackMock)).toHaveBeenCalledWith('chair_variant_selected', { variant: 'kit' });
  });

  it('confirms and reloads only the caster roles when they are already loaded', async () => {
    state.assembly.parts = [
      fakePart(1, 'handle-left'),
      fakePart(2, 'caster-left'),
      fakePart(3, 'caster-right'),
    ];
    const originalCasterLeft = state.assembly.parts[1];
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );

    await switchChairVariant('kit');

    expect(state.assembly.variantId).toBe('kit');
    const roleIds = state.assembly.parts.map((p) => p.roleId).sort();
    expect(roleIds).toEqual(['caster-left', 'caster-right', 'handle-left']);
    // the caster parts were replaced (new part objects), not mutated in place
    expect(state.assembly.parts.find((p) => p.roleId === 'caster-left')).not.toBe(
      originalCasterLeft,
    );
    // the unrelated role was left alone
    expect(state.assembly.parts.find((p) => p.roleId === 'handle-left')).toBe(
      state.assembly.parts[0],
    );
  });

  it('cancelling the confirm leaves variant and parts untouched', async () => {
    const casterLeft = fakePart(2, 'caster-left');
    state.assembly.parts = [casterLeft];
    vi.stubGlobal(
      'confirm',
      vi.fn(() => false),
    );

    await switchChairVariant('kit');

    expect(state.assembly.variantId).toBe('standard');
    expect(state.assembly.parts).toEqual([casterLeft]);
    expect(vi.mocked(trackMock)).not.toHaveBeenCalled();
  });
});
