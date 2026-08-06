// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/app/scheduler', () => ({ scheduleRebuild: vi.fn() }));
vi.mock('../src/scene/viewport', () => ({ requestFrame: vi.fn() }));
vi.mock('../src/ui/overlay', () => ({ showOverlay: vi.fn(), hideOverlay: vi.fn() }));
vi.mock('../src/analytics/track', () => ({ track: vi.fn() }));
vi.mock('../src/ui/dialogs', () => ({ confirmDialog: vi.fn(), alertDialog: vi.fn() }));
vi.mock('../src/assembly/parts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/assembly/parts')>();
  return { ...actual, asmLoadFullAssembly: vi.fn(async () => {}) };
});

import { applyRestoredSession, type PersistedSession } from '../src/state/persist';
import { asmLoadFullAssembly } from '../src/assembly/parts';
import { state } from '../src/state/store';
import { confirmDialog } from '../src/ui/dialogs';

/**
 * svg/parse.ts normalizes every CSS color through a canvas 2D context. jsdom has no canvas, so
 * without this every fill resolves to black and the restored settings get pruned as "not in the
 * live palette" — which would make these tests pass for the wrong reason. The fixture SVG uses
 * plain #rrggbb, so echoing the assignment back is all the oracle has to do.
 */
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => {
    let fillStyle = '#000000';
    return {
      get fillStyle() {
        return fillStyle;
      },
      set fillStyle(v: string) {
        fillStyle = v;
      },
    };
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

/** Three colors, so a restored merge group, multi-member base and keptApart pin all have live
 * hexes to survive the palette prune — anything not in the design is dropped, by design. */
const SQUARE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 10">' +
  '<rect x="0" y="0" width="10" height="10" fill="#ff0000"/>' +
  '<rect x="10" y="0" width="10" height="10" fill="#ee0000"/>' +
  '<rect x="20" y="0" width="10" height="10" fill="#00ff00"/></svg>';

function session(over: Partial<PersistedSession> = {}): PersistedSession {
  return {
    version: 1,
    savedAt: Date.now(),
    shapeKind: 'disc',
    disc: { diameter: 90, thickness: 5 },
    rect: { width: 100, height: 70, thickness: 3 },
    round: { width: 100, height: 70, corner: 12, thickness: 3 },
    stlPlate: { width: 120, height: 80, thickness: 6, faceZ: 2 },
    marginPct: 7,
    scalePct: 120,
    offsetX: 1,
    offsetY: -2,
    flipX: true,
    flipY: false,
    rotationDeg: 45,
    globalDepth: 1.5,
    recessBg: true,
    printerId: 'p-saved',
    asmRadius: 140,
    assembly: { kindId: null, variantId: null },
    baseFilamentId: 'blue',
    autoMergeLevel: 2,
    baseColorKey: '#ff0000',
    baseColorMembers: ['#ff0000', '#ee0000'],
    mergeGroups: [['#ff0000', '#ee0000']],
    colorSettings: { '#ff0000': { depth: 2.5 } },
    explicitDepths: true,
    keptApart: ['#00ff00'],
    sources: [{ id: 's1', kind: 'upload', name: 'a.svg', svgText: SQUARE_SVG }],
    artworks: [
      {
        id: 'a1',
        sourceId: 's1',
        zoneId: null,
        offsetU: 3,
        offsetV: 4,
        scalePct: 110,
        rotationDeg: 15,
        flipX: false,
        flipY: true,
        mode: 'sticker',
      },
    ],
    activeArtworkId: 'a1',
    ...over,
  } as PersistedSession;
}

beforeEach(() => {
  state.shapeKind = 'disc';
  state.assembly.kindId = null;
  state.assembly.variantId = null;
  state.assembly.parts = [];
  state.sources = [];
  state.artworks = [];
  state.activeArtworkId = null;
  vi.mocked(asmLoadFullAssembly).mockClear();
  vi.mocked(confirmDialog).mockReset();
});

afterEach(() => {
  state.assembly.kindId = null;
  state.shapeKind = 'disc';
});

describe('applyRestoredSession: the settings the user had', () => {
  it('restores every base-shape dimension', async () => {
    await applyRestoredSession(session());

    expect(state.disc).toEqual({ diameter: 90, thickness: 5 });
    expect(state.rect).toEqual({ width: 100, height: 70, thickness: 3 });
    expect(state.round).toEqual({ width: 100, height: 70, corner: 12, thickness: 3 });
    expect(state.stlPlate).toEqual({ width: 120, height: 80, thickness: 6, faceZ: 2 });
    expect(state.marginPct).toBe(7);
  });

  it('lets the active artwork’s own placement win over the session’s global fit fields', async () => {
    // setActiveArtwork pushes the instance's placement into the global fit inputs, and it runs
    // last — so these come back from the artwork (110/3/4/15), not the session (120/1/-2/45).
    await applyRestoredSession(session());

    expect(state.scalePct).toBe(110);
    expect(state.offsetX).toBe(3);
    expect(state.offsetY).toBe(4);
    expect(state.rotationDeg).toBe(15);
    expect(state.flipX).toBe(false);
    expect(state.flipY).toBe(true);
  });

  it('keeps the session’s own fit fields when there is no artwork to override them', async () => {
    await applyRestoredSession(session({ artworks: [], activeArtworkId: null }));

    expect(state.scalePct).toBe(120);
    expect(state.offsetX).toBe(1);
    expect(state.offsetY).toBe(-2);
    expect(state.rotationDeg).toBe(45);
    expect(state.flipX).toBe(true);
  });

  it('restores depth, printer and color grouping', async () => {
    await applyRestoredSession(session());

    expect(state.globalDepth).toBe(1.5);
    expect(state.recessBg).toBe(true);
    expect(state.printerId).toBe('p-saved');
    expect(state.asmRadius).toBe(140);
    expect(state.baseFilamentId).toBe('blue');
    expect(state.autoMergeLevel).toBe(2);
    expect(state.baseColorKey).toBe('#ff0000');
    expect(state.baseColorMembers).toEqual(['#ff0000', '#ee0000']);
    expect(state.mergeGroups).toEqual([['#ff0000', '#ee0000']]);
    expect(state.keptApart).toEqual(['#00ff00']);
  });

  it('keeps deliberate depth overrides from a session that marked them explicit', async () => {
    await applyRestoredSession(session({ explicitDepths: true }));

    expect(state.colorSettings).toEqual({ '#ff0000': { depth: 2.5 } });
  });

  it('drops machine-written depths from a session saved before that guarantee', async () => {
    // Such a session omits the flag entirely (it is typed `?: true`). Restoring its depths
    // verbatim re-pins the global Depth field — see restoredColorSettings.
    await applyRestoredSession(session({ explicitDepths: undefined }));

    expect(state.colorSettings).toEqual({});
  });

  it('prunes saved color settings whose hex is no longer in the restored design', async () => {
    // The design is pure #ff0000; a base member and a depth for a color it no longer contains
    // must not survive, or that hex is silently excluded from cutting the next time it appears.
    await applyRestoredSession(
      session({
        colorSettings: { '#ff0000': { depth: 2.5 }, '#123456': { depth: 3 } },
        baseColorMembers: ['#ff0000', '#123456'],
        mergeGroups: [['#ff0000', '#123456']],
        keptApart: ['#123456'],
      }),
    );

    expect(Object.keys(state.colorSettings)).toEqual(['#ff0000']);
    expect(state.baseColorMembers).toEqual(['#ff0000']);
    expect(state.keptApart).toEqual([]);
    // a merge group with only one surviving member is no longer a group
    expect(state.mergeGroups).toEqual([]);
  });

  it('clears the base entirely when none of its members survive the prune', async () => {
    await applyRestoredSession(session({ baseColorKey: '#123456', baseColorMembers: ['#123456'] }));

    expect(state.baseColorMembers).toEqual([]);
    expect(state.baseColorKey).toBeNull();
  });
});

describe('applyRestoredSession: the artwork', () => {
  it('re-parses each source’s saved SVG text rather than trusting stored geometry', async () => {
    await applyRestoredSession(session());

    expect(state.sources).toHaveLength(1);
    expect(state.sources[0].id).toBe('s1');
    expect(state.sources[0].parsed).not.toBeNull();
    expect(state.sources[0].parsed!.shapes.length).toBeGreaterThan(0);
  });

  it('restores each instance’s placement and makes the saved one active', async () => {
    await applyRestoredSession(session());

    expect(state.artworks).toHaveLength(1);
    expect(state.artworks[0]).toMatchObject({
      id: 'a1',
      sourceId: 's1',
      offsetU: 3,
      offsetV: 4,
      scalePct: 110,
      rotationDeg: 15,
      flipX: false,
      flipY: true,
    });
    expect(state.activeArtworkId).toBe('a1');
  });
});

describe('applyRestoredSession: assembly mode', () => {
  it('reloads the saved kind and variant, then its parts', async () => {
    await applyRestoredSession(
      session({
        shapeKind: 'assembly',
        assembly: { kindId: 'chair-body', variantId: 'kit' },
      }),
    );

    expect(state.shapeKind).toBe('assembly');
    expect(state.assembly.kindId).toBe('chair-body');
    expect(state.assembly.variantId).toBe('kit');
    expect(asmLoadFullAssembly).toHaveBeenCalledTimes(1);
  });

  it('never asks the user to confirm — the parts list is empty this early in the session', async () => {
    await applyRestoredSession(
      session({ shapeKind: 'assembly', assembly: { kindId: 'wheel', variantId: null } }),
    );

    expect(confirmDialog).not.toHaveBeenCalled();
  });

  it('falls back to a flat mode when the saved kind has since been retired', async () => {
    await applyRestoredSession(
      session({
        shapeKind: 'assembly',
        assembly: { kindId: 'kind-that-no-longer-exists', variantId: null },
      }),
    );

    expect(state.shapeKind).toBe('disc');
    expect(asmLoadFullAssembly).not.toHaveBeenCalled();
  });

  it('does not load parts for a session that was in a flat mode', async () => {
    await applyRestoredSession(session({ shapeKind: 'rect' }));

    expect(state.shapeKind).toBe('rect');
    expect(asmLoadFullAssembly).not.toHaveBeenCalled();
  });
});

describe('applyRestoredSession: failure handling', () => {
  it('clears the restoring flag even when the restore throws', async () => {
    // an unparseable source blows up inside the inner restore
    const bad = session({
      sources: [{ id: 's1', kind: 'upload', name: 'a.svg', svgText: null as unknown as string }],
    });

    await expect(applyRestoredSession(bad)).rejects.toBeTruthy();

    // the flag is internal, so prove it indirectly: a subsequent good restore still works
    await expect(applyRestoredSession(session())).resolves.toBeUndefined();
    expect(state.activeArtworkId).toBe('a1');
  });
});
