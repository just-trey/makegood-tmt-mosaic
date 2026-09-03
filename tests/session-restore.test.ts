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

import {
  applyRestoredSession,
  loadSavedSession,
  type PersistedSession,
} from '../src/state/persist';
import { asmLoadFullAssembly } from '../src/assembly/parts';
import { firstOfferedKind } from '../src/assembly/kinds';
import { getPrinter } from '../src/export/printers';
import { state } from '../src/state/store';
import { confirmDialog } from '../src/ui/dialogs';
import { WARNINGS, clearWarnings, warn } from '../src/warnings';

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
    printerId: 'snapmaker-u1',
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

  // getPrinter() falls back to the default when the id is unknown, so adopting the saved value
  // verbatim left `#p-printer` blank while the export used a bed the picker did not name — and the
  // bed is what every verified placement is checked against.
  // Seven single-field corruptions used to pass the gate and throw part-way through, leaving the
  // app unable to build until F5. Rejecting them was the first fix and was wrong: a session written
  // by an older build, before one of these fields existed, is not corrupt and still holds the
  // user's artwork. It is repaired to the same "nothing set" the app boots with.
  it('restores a session that predates the container fields instead of discarding it', async () => {
    const legacy = session();
    for (const k of ['colorSettings', 'keptApart', 'mergeGroups', 'baseColorMembers', 'assembly'])
      delete (legacy as unknown as Record<string, unknown>)[k];

    localStorage.setItem(
      'tmt-mosaic:session:v1',
      JSON.stringify({ ...legacy, version: 1, savedAt: Date.now() }),
    );
    const loaded = loadSavedSession()!;
    expect(loaded, 'a session missing containers must still load').not.toBeNull();

    await expect(applyRestoredSession(loaded)).resolves.toBeUndefined();

    // the artwork is the point — that is the work the user would otherwise have lost
    expect(state.artworks).toHaveLength(1);
    expect(state.colorSettings).toEqual({});
    expect(state.keptApart).toEqual([]);
  });

  // The field refuses 0 and negatives, but a session saved by an earlier build can carry either,
  // and a reload walked straight past the guard. Zero makes every cut fail while Export stays
  // green; a negative builds as if positive.
  // 0.2 is below the field's own floor but above zero, which is what a looser guard let through:
  // the field then snapped itself to its default while state kept 0.2.
  it.each([0, -50, 0.2])('ignores a saved design radius of %d', async (asmRadius) => {
    const before = state.asmRadius;

    await applyRestoredSession(session({ asmRadius }));

    expect(state.asmRadius).toBe(before);
  });

  // isPersistedSession checks four fields and repairSessionContainers repairs containers, never
  // scalars, so a session missing this reached colorList's `shownDepth.toFixed(2)` and threw
  // part-way through the restore.
  it('ignores a saved depth that is not a number', async () => {
    const before = state.globalDepth;
    const bad = session();
    delete (bad as unknown as Record<string, unknown>).globalDepth;

    await expect(applyRestoredSession(bad)).resolves.toBeUndefined();

    expect(state.globalDepth).toBe(before);
  });

  it('restores a design radius that is a real one', async () => {
    await applyRestoredSession(session({ asmRadius: 120 }));

    expect(state.asmRadius).toBe(120);
  });

  it('coerces an unknown printer id to one that exists', async () => {
    await applyRestoredSession(session({ printerId: 'no-such-printer' }));

    expect(state.printerId).not.toBe('no-such-printer');
    expect(getPrinter(state.printerId).id).toBe(state.printerId);
  });

  it('restores depth, printer and color grouping', async () => {
    await applyRestoredSession(session());

    expect(state.globalDepth).toBe(1.5);
    expect(state.recessBg).toBe(true);
    // A real id, and deliberately not the default, so this proves the saved value was adopted
    // rather than the fallback happening to match.
    expect(state.printerId).toBe('snapmaker-u1');
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

  // The parts list is NOT empty this early: the boot's own auto-load has already filled it. That
  // is why this asserts the list is empty *at the moment asmLoadFullAssembly is called*, rather
  // than that no confirm fired — the confirm lives inside that function, which is mocked here, so
  // "confirmDialog was not called" passes whatever the caller does and guards nothing.
  //
  // Cancelling that confirm returned without touching the scene while `kindId` and the dropdown
  // had already moved, so the export wrote the previous kind's parts under the restored kind's
  // filename. Measured: a restored footrest session exported `mosaic-footrest.3mf` holding the
  // wheel's Top/Bottom/Cap.
  it('clears the parts the boot loaded before asking for the restored kind, so no confirm can fire', async () => {
    let partsWhenLoadRan: number | undefined;
    vi.mocked(asmLoadFullAssembly).mockImplementation(async () => {
      partsWhenLoadRan = state.assembly.parts.length;
    });
    state.assembly.parts = [
      { id: 1, name: 'Top' },
      { id: 2, name: 'Bottom' },
    ] as unknown as typeof state.assembly.parts;

    await applyRestoredSession(
      session({ shapeKind: 'assembly', assembly: { kindId: 'footrest', variantId: null } }),
    );

    expect(partsWhenLoadRan).toBe(0);
    expect(confirmDialog).not.toHaveBeenCalled();
  });

  // The Part dropdown offers assembly kinds and nothing else, so a saved value it cannot show
  // would leave the select blank and the next switch away from it one-way. Loading the fallback's
  // parts is left to restoreBanner's own setShapeKind.
  it('falls back to the first offered kind when the saved kind has since been retired', async () => {
    await applyRestoredSession(
      session({
        shapeKind: 'assembly',
        assembly: { kindId: 'kind-that-no-longer-exists', variantId: null },
      }),
    );

    expect(state.shapeKind).toBe('assembly');
    expect(state.assembly.kindId).toBe(firstOfferedKind().id);
    expect(asmLoadFullAssembly).not.toHaveBeenCalled();
  });

  it('falls back the same way for a session saved in a flat mode', async () => {
    await applyRestoredSession(session({ shapeKind: 'rect' }));

    expect(state.shapeKind).toBe('assembly');
    expect(state.assembly.kindId).toBe(firstOfferedKind().id);
    expect(asmLoadFullAssembly).not.toHaveBeenCalled();
  });

  // maybeAutoLoadAssembly no-ops while any part is present, so leaving the previous kind's parts
  // in place would name the fallback kind in the dropdown while the scene and the export still
  // held the other one's. Reachable by switching part, then accepting the still-open banner.
  // setArtworkZone re-applies the saved zoneId against the part actually loaded. On the fallback
  // that part is a different kind, so an instance keeps a binding no mapper matches — and
  // geometry/assembly.ts drops such an instance from the cut entirely, with nothing said and (on a
  // part with a single design face) no dropdown to re-target it.
  it('does not re-apply zone bindings that named the kind it did not restore onto', async () => {
    await applyRestoredSession(
      session({
        shapeKind: 'assembly',
        assembly: { kindId: 'kind-that-no-longer-exists', variantId: null },
        artworks: [{ ...session().artworks[0], zoneId: 'left' }],
      }),
    );

    expect(state.assembly.kindId).toBe(firstOfferedKind().id);
    expect(state.artworks.map((a) => a.zone)).toEqual([null]);
  });

  // The same silent loss as the test above, reached from the other direction: the right kind loads,
  // but a re-bake has since renamed or dropped one of its zones. geometry/assembly.ts matches
  // instances to mappers by zoneId, so a binding naming a zone nobody offers is cut nowhere and
  // says nothing — and the dropdown shows no selection rather than a wrong one, so there is not
  // even a visible symptom to chase. Sending it to All zones cuts something the user can see.
  it('re-points a design off a zone the loaded parts no longer offer, and says so', async () => {
    vi.mocked(asmLoadFullAssembly).mockImplementation(async () => {
      state.assembly.parts = [
        {
          id: 7,
          name: 'Chair wheel mount (left)',
          zones: [{ id: 'left', name: 'Left side' }],
        },
      ] as unknown as typeof state.assembly.parts;
    });
    const [art] = session().artworks;

    await applyRestoredSession(
      session({
        shapeKind: 'assembly',
        assembly: { kindId: 'chair-body', variantId: null },
        artworks: [
          { ...art, id: 'a-live', zoneId: 'left' },
          { ...art, id: 'a-retired', zoneId: 'seat' },
        ],
      }),
    );

    expect(state.artworks.find((a) => a.zone?.zoneId === 'left')).toBeDefined();
    expect(state.artworks.filter((a) => a.zone === null)).toHaveLength(1);
    expect(state.artworks.some((a) => a.zone?.zoneId === 'seat')).toBe(false);
    expect(WARNINGS.some((w) => /^1 design was on a zone/.test(w.message))).toBe(true);
  });

  // Counted over what actually restored. An instance whose source could not be rebuilt is filtered
  // out before this runs and has its own warning, so counting it would name designs that are not in
  // state for the user to go and look at.
  it('does not count a design whose source failed to restore', async () => {
    class FailingImage {
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;
      set src(_v: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal('Image', FailingImage);
    vi.mocked(asmLoadFullAssembly).mockImplementation(async () => {
      state.assembly.parts = [
        { id: 7, name: 'Mount', zones: [{ id: 'left', name: 'Left side' }] },
      ] as unknown as typeof state.assembly.parts;
    });
    const base = session();
    const [art] = base.artworks;

    await applyRestoredSession(
      session({
        shapeKind: 'assembly',
        assembly: { kindId: 'chair-body', variantId: null },
        sources: [
          ...base.sources,
          {
            id: 'r1',
            kind: 'raster',
            name: 'photo.png',
            svgText: '',
            raster: { png: 'data:image/png;base64,NOTVALID', colors: 4, detail: 50 },
          },
        ],
        artworks: [
          { ...art, id: 'a-kept', zoneId: 'seat' },
          { ...art, id: 'a-lost', sourceId: 'r1', zoneId: 'seat' },
        ],
      }),
    );

    expect(state.artworks.map((a) => a.id)).toEqual(['a-kept']);
    expect(WARNINGS.some((w) => /^1 design was on a zone/.test(w.message))).toBe(true);
    expect(WARNINGS.some((w) => /^2 designs were on zones/.test(w.message))).toBe(false);
  });

  // asmLoadFullAssembly returns without loading while the parts manifest is in flight, and
  // loadPartsLibrary calls back through maybeAutoLoadAssembly when it lands. Reading the empty zone
  // list that leaves as "every zone was retired" would discard every binding before the deferred
  // load could arrive — a total wipe, on a supported path, from a check meant to prevent a loss.
  it('keeps zone bindings when no zones are offered yet, and says nothing', async () => {
    vi.mocked(asmLoadFullAssembly).mockImplementation(async () => {});
    const [art] = session().artworks;

    await applyRestoredSession(
      session({
        shapeKind: 'assembly',
        assembly: { kindId: 'chair-body', variantId: null },
        artworks: [{ ...art, id: 'a-live', zoneId: 'left' }],
      }),
    );

    expect(state.artworks[0].zone?.zoneId).toBe('left');
    expect(WARNINGS.some((w) => /no longer has/.test(w.message))).toBe(false);
  });

  it('drops the parts already loaded, so the fallback kind can auto-load its own', async () => {
    state.assembly.parts = [{ id: 1, name: 'Footrest' }] as unknown as typeof state.assembly.parts;

    await applyRestoredSession(session({ shapeKind: 'rect' }));

    expect(state.assembly.parts).toEqual([]);
    expect(state.assembly.variantId).toBeNull();
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

  // applyRestoredSessionInner used to assign its scalar fields straight into `state` before this
  // loop ran, so a source that fails to parse here — the common real-world case, an older SVG a
  // newer parser rejects — left the printer (and everything else assigned alongside it) on the
  // saved session's values while every source and artwork stayed on the pre-restore ones.
  it('leaves state exactly as it was when a source fails to parse part-way through', async () => {
    state.printerId = 'bambu-x1c';
    state.disc = { diameter: 42, thickness: 3 };
    state.asmRadius = 130;
    state.baseColorKey = '#111111';
    state.keptApart = ['#222222'];
    const before = {
      printerId: state.printerId,
      disc: { ...state.disc },
      asmRadius: state.asmRadius,
      baseColorKey: state.baseColorKey,
      keptApart: [...state.keptApart],
    };

    const bad = session({
      // Different from `before` on every field captured above, so a leak from any of them shows.
      printerId: 'snapmaker-u1',
      disc: { diameter: 999, thickness: 999 },
      asmRadius: 999,
      baseColorKey: '#ff0000',
      keptApart: ['#00ff00'],
      sources: [{ id: 's1', kind: 'upload', name: 'a.svg', svgText: null as unknown as string }],
    });

    await expect(applyRestoredSession(bad)).rejects.toBeTruthy();

    expect(state.printerId).toBe(before.printerId);
    expect(state.disc).toEqual(before.disc);
    expect(state.asmRadius).toBe(before.asmRadius);
    expect(state.baseColorKey).toBe(before.baseColorKey);
    expect(state.keptApart).toEqual(before.keptApart);
  });
});

describe('applyRestoredSession: a raster restore failure survives a later SVG source', () => {
  // The per-image restore-failure warning is pushed while the loop is on the raster source,
  // *before* the SVG source after it is reached. If parsing that SVG source clears warnings
  // (parseSVGDocument used to), the one notice this failure exists to show is gone by the time
  // the restore finishes — the exact partial-failure case the warning is for.
  it('keeps the raster restore-failure warning once a later SVG source has parsed', async () => {
    class FailingImage {
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;
      set src(_v: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal('Image', FailingImage);
    clearWarnings();

    await applyRestoredSession(
      session({
        sources: [
          {
            id: 'r1',
            kind: 'raster',
            name: 'photo.png',
            svgText: '',
            raster: { png: 'data:image/png;base64,NOTVALID', colors: 4, detail: 50 },
          },
          { id: 's1', kind: 'upload', name: 'a.svg', svgText: SQUARE_SVG },
        ],
        artworks: [
          {
            id: 'a1',
            sourceId: 's1',
            zoneId: null,
            offsetU: 0,
            offsetV: 0,
            scalePct: 100,
            rotationDeg: 0,
            flipX: false,
            flipY: false,
            mode: 'sticker',
          },
        ],
        activeArtworkId: 'a1',
      }),
    );

    expect(WARNINGS.some((w) => w.key === 'r1' && /could not be restored/i.test(w.message))).toBe(
      true,
    );
  });
});

describe('applyRestoredSession: a warning standing from before the restore', () => {
  // A restore swaps `state.sources` wholesale (restoreArtworkPool), so a per-image notice tied to
  // an old source id (a capped/traced notice, or a leftover "could not be restored" from a
  // previous restore attempt) outlives every source it could still describe once this one commits.
  // Nothing else clears it: a rebuild only drops build-scoped warnings (clearBuildWarnings), and
  // this loop's own per-source warn()/notice() calls only ever add.
  it('does not survive a restore that replaces every source', async () => {
    clearWarnings();
    warn('a notice about a source this restore is about to replace', 'stale-source-id');

    await applyRestoredSession(session());

    expect(WARNINGS.some((w) => w.key === 'stale-source-id')).toBe(false);
  });
});
