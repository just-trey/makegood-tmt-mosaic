// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';

vi.mock('../src/app/scheduler', () => ({ scheduleRebuild: vi.fn() }));
vi.mock('../src/scene/viewport', () => ({ requestFrame: vi.fn() }));
vi.mock('../src/ui/overlay', () => ({ showOverlay: vi.fn(), hideOverlay: vi.fn() }));
vi.mock('../src/analytics/track', () => ({ track: vi.fn() }));
vi.mock('../src/ui/dialogs', () => ({ confirmDialog: vi.fn(), alertDialog: vi.fn() }));

import {
  asmAddDuplicate,
  asmCreateRolePart,
  asmLoadFullAssembly,
  asmLoadLibraryEntryIntoPart,
  asmLoadPartBuffer,
  asmRemovePart,
  loadPartsLibrary,
  maybeAutoLoadAssembly,
  onAssemblyPartsChanged,
} from '../src/assembly/parts';
import { ASSEMBLY_KINDS } from '../src/assembly/kinds';
import { state } from '../src/state/store';
import { alertDialog, confirmDialog } from '../src/ui/dialogs';
import { scheduleRebuild } from '../src/app/scheduler';
import type { AssemblyPart, AssemblyRole, LibraryEntry } from '../src/types';

/** Binary STL of the given triangles — the format asmLoadPartBuffer parses for a .stl name. */
function binarySTL(tris: number[][][]): ArrayBuffer {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  tris.forEach((tri, i) => {
    let o = 84 + i * 50;
    for (let k = 0; k < 3; k++) dv.setFloat32(o + k * 4, 0, true); // normal (recomputed from winding)
    o += 12;
    for (const v of tri) {
      for (const c of v) {
        dv.setFloat32(o, c, true);
        o += 4;
      }
    }
  });
  return buf;
}

/** 20×20 facing +Z at z=10 — area 400, the largest patch in every mesh below. */
const BIG_PLUS_Z: number[][][] = [
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
/** 10×10 facing -Z at z=0 — area 100. */
const SMALL_MINUS_Z: number[][][] = [
  [
    [0, 0, 0],
    [10, 10, 0],
    [10, 0, 0],
  ],
  [
    [0, 0, 0],
    [0, 10, 0],
    [10, 10, 0],
  ],
];
/** 10×10 facing +Y at y=10 — area 100, the normal the footrest role prefers. */
const SMALL_PLUS_Y: number[][][] = [
  [
    [0, 10, 0],
    [0, 10, 10],
    [10, 10, 10],
  ],
  [
    [0, 10, 0],
    [10, 10, 10],
    [10, 10, 0],
  ],
];

/** A large +Z face and a smaller -Z face — two patches, area-ranked. */
const twoFacedMesh = (): ArrayBuffer => binarySTL([...BIG_PLUS_Z, ...SMALL_MINUS_Z]);
/** A large +Z face and a smaller +Y face, so "largest" and "preferred" disagree. */
const preferableFaceMesh = (): ArrayBuffer => binarySTL([...BIG_PLUS_Z, ...SMALL_PLUS_Y]);

const role = (over: Partial<AssemblyRole> = {}): AssemblyRole =>
  ({ id: 'r1', name: 'Part', ...over }) as AssemblyRole;

/** Everything the `wheel` kind needs present before it will auto-load. */
const wheelLibrary = (): LibraryEntry[] =>
  ['wheel-half', 'wheel-hub-cap'].map((id) => ({ id, name: id, file: `stl/${id}.stl` }));

function loadedPart(over: Partial<AssemblyPart> = {}): AssemblyPart {
  const p = asmCreateRolePart(role());
  Object.assign(p, {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    vertices: new Float32Array([0, 0, 0]),
    loaded: true,
    ...over,
  });
  return p;
}

beforeEach(() => {
  state.shapeKind = 'assembly';
  state.assembly.kindId = 'wheel';
  state.assembly.variantId = null;
  state.assembly.parts = [];
  state.assembly.library = [];
  state.assembly.nextPartId = 1;
  onAssemblyPartsChanged(() => {});
  vi.mocked(scheduleRebuild).mockClear();
  vi.mocked(alertDialog).mockClear().mockResolvedValue(undefined);
  vi.mocked(confirmDialog).mockReset();
});

afterEach(() => {
  state.assembly.kindId = null;
  state.assembly.parts = [];
  state.shapeKind = 'disc';
  vi.unstubAllGlobals();
});

describe('asmCreateRolePart', () => {
  it('hands out increasing ids and pushes onto the parts list', () => {
    const a = asmCreateRolePart(role());
    const b = asmCreateRolePart(role());

    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(state.assembly.parts).toEqual([a, b]);
  });

  it('carries the role’s cut-through settings onto the part', () => {
    const p = asmCreateRolePart(role({ cutThrough: true, cutThroughDepth: 3 }));

    expect(p.cutThrough).toBe(true);
    expect(p.cutThroughDepth).toBe(3);
  });

  it('defaults a role with no cut-through flag to a recessed part', () => {
    const p = asmCreateRolePart(role());

    expect(p.cutThrough).toBe(false);
    expect(p.cutThroughDepth).toBeUndefined();
  });
});

describe('onAssemblyPartsChanged', () => {
  it('fires the registered listener when a part is added or removed', () => {
    const src = loadedPart();
    const spy = vi.fn();
    onAssemblyPartsChanged(spy);

    const dup = asmAddDuplicate(src.id)!;
    expect(spy).toHaveBeenCalledTimes(1);

    asmRemovePart(dup.id);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('asmAddDuplicate', () => {
  it('shares the source’s geometry instead of re-parsing it', () => {
    const src = loadedPart();

    const dup = asmAddDuplicate(src.id)!;

    // same reference, deliberately — a rotated copy is the same mesh at another angle
    expect(dup.positions).toBe(src.positions);
    expect(dup.vertices).toBe(src.vertices);
    expect(dup.loaded).toBe(true);
  });

  it('records what it is a copy of, and gets its own id', () => {
    const src = loadedPart();

    const dup = asmAddDuplicate(src.id)!;

    expect(dup.isDuplicateOf).toBe(src.id);
    expect(dup.id).not.toBe(src.id);
    expect(src.isDuplicateOf).toBeNull();
  });

  it('starts every copy at the default pose, not the source’s', () => {
    const src = loadedPart({ pivotX: 5, pivotZ: 7, angleDeg: 33 });

    const dup = asmAddDuplicate(src.id)!;

    expect(dup.pivotX).toBe(0);
    expect(dup.pivotZ).toBe(0);
    expect(dup.angleDeg).toBe(180);
  });

  it('names the copy from the role when given a name, and derives one otherwise', () => {
    const src = loadedPart();
    src.name = 'Wheel Top';

    expect(asmAddDuplicate(src.id, 'Second Top')!.name).toBe('Second Top');
    expect(asmAddDuplicate(src.id)!.name).toBe('Wheel Top (rotated copy)');
  });

  it('returns null for an id that is not in the parts list', () => {
    expect(asmAddDuplicate(999)).toBeNull();
    expect(state.assembly.parts).toHaveLength(0);
  });
});

describe('asmRemovePart', () => {
  it('takes the part’s rotated copies with it', () => {
    const src = loadedPart();
    asmAddDuplicate(src.id);
    asmAddDuplicate(src.id);
    const other = loadedPart();

    asmRemovePart(src.id);

    expect(state.assembly.parts).toEqual([other]);
  });

  it('removing a copy leaves the source and its siblings alone', () => {
    const src = loadedPart();
    const a = asmAddDuplicate(src.id)!;
    const b = asmAddDuplicate(src.id)!;

    asmRemovePart(a.id);

    expect(state.assembly.parts.map((p) => p.id)).toEqual([src.id, b.id]);
  });

  it('schedules a rebuild, since the removed part was in the last one', () => {
    const src = loadedPart();

    asmRemovePart(src.id);

    expect(scheduleRebuild).toHaveBeenCalled();
  });
});

/**
 * Display shading reads a mesh's vertex index instead of rehashing every corner, but only where
 * the sharing that index claims can be trusted. Our packed parts are welded, so honouring their
 * claim exactly is strictly better than the fallback's 0.01mm bucketing. A dropped 3MF is not
 * necessarily welded — one converted from an STL carries a vertex per corner and claims no sharing
 * at all — and honouring *that* renders it fully faceted where it used to come out smooth.
 *
 * So the index is kept for a library load and dropped for an upload. Both cases here, because the
 * two differ by one flag set by the caller and nothing about the rendered result would say which
 * branch ran.
 */
describe('which loaded meshes are trusted to state their own vertex sharing', () => {
  /** A two-triangle 3MF sharing an edge, in the single-inlined-<object> shape load3MF reads. */
  async function packed3MF(): Promise<ArrayBuffer> {
    const verts = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
    ];
    const tris = [
      [0, 1, 2],
      [1, 3, 2],
    ];
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
      `<resources><object id="1" type="model"><mesh><vertices>` +
      verts.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('') +
      `</vertices><triangles>` +
      tris.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('') +
      `</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
    const zip = new JSZip();
    zip.file('3D/3dmodel.model', xml);
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    return buf;
  }

  it('keeps the index of a 3MF loaded from the library', async () => {
    state.assembly.kindId = 'wheel';
    const part = asmCreateRolePart(role({ id: 'wheel-half' }));

    await asmLoadPartBuffer(part, await packed3MF(), 'wheel-half.3mf');

    expect(part.indexed).toBeDefined();
    expect(part.indexed!.indices.length * 3).toBe(part.positions!.length);
  });

  it('drops the index of an STL, which records no sharing at all', async () => {
    state.assembly.kindId = 'wheel';
    const part = asmCreateRolePart(role({ id: 'wheel-half' }));

    await asmLoadPartBuffer(part, twoFacedMesh(), 'p.stl');

    expect(part.indexed).toBeUndefined();
  });
});

/**
 * The preference is read off the *registered kind's* role, matched by the part's roleId — not off
 * whatever role object created the part. So these drive real kinds: `wheel` states no preference,
 * `footrest` prefers the +Y (seat-side) face over its larger flat back.
 */
describe('the design face a freshly loaded part starts on', () => {
  it('defaults to the largest flat patch when the role states no preference', async () => {
    state.assembly.kindId = 'wheel';
    const part = asmCreateRolePart(role({ id: 'wheel-half' }));

    await asmLoadPartBuffer(part, twoFacedMesh(), 'p.stl');

    expect(part.patches!.length).toBeGreaterThan(1);
    expect(part.patchIdx).toBe(0);
    expect(part.patchNormal![2]).toBeCloseTo(1, 6); // the +Z face, which is the larger one
    expect(part.loaded).toBe(true);
  });

  it('honors the role’s preferred normal even when that face is smaller', async () => {
    state.assembly.kindId = 'footrest';
    const part = asmCreateRolePart(role({ id: 'footrest' }));

    await asmLoadPartBuffer(part, preferableFaceMesh(), 'p.stl');

    expect(part.patchIdx).not.toBe(0); // not the largest — the preferred one
    expect(part.patchNormal![1]).toBeCloseTo(1, 6);
    expect(part.topZ).toBeCloseTo(10, 6);
  });

  it('falls back to the largest patch when nothing points the preferred way', async () => {
    state.assembly.kindId = 'footrest';
    const part = asmCreateRolePart(role({ id: 'footrest' }));

    // this mesh has no +Y face at all
    await asmLoadPartBuffer(part, twoFacedMesh(), 'p.stl');

    expect(part.patchIdx).toBe(0);
    expect(part.patchNormal![2]).toBeCloseTo(1, 6);
  });

  it('falls back to the largest patch for a part whose role is not in the current kind', () => {
    state.assembly.kindId = 'wheel';
    const part = asmCreateRolePart(role({ id: 'no-such-role' }));

    return asmLoadPartBuffer(part, preferableFaceMesh(), 'p.stl').then(() => {
      expect(part.patchIdx).toBe(0);
      expect(part.patchNormal![2]).toBeCloseTo(1, 6);
    });
  });

  it('rejects a file type it cannot parse', async () => {
    const part = asmCreateRolePart(role());

    await expect(asmLoadPartBuffer(part, new ArrayBuffer(8), 'p.obj')).rejects.toThrow(
      /use \.stl or \.3mf/,
    );
    expect(part.loaded).toBe(false);
  });
});

describe('a role that builds its own mesh (AssemblyRole.buildMesh)', () => {
  /** Stand-in generator: ignores the asset and hands back a fixed one-triangle mesh. */
  const builtMesh = () => new Float32Array([0, 0, 0, 5, 0, 0, 0, 5, 0]);
  const hubcapRole = () => ASSEMBLY_KINDS.find((k) => k.id === 'hubcap')!.roles[0];
  let buildMesh: ReturnType<typeof vi.fn>;
  let real: AssemblyRole['buildMesh'];

  beforeEach(() => {
    buildMesh = vi.fn().mockResolvedValue({ positions: builtMesh() });
    state.assembly.kindId = 'hubcap';
    // Stand the real hubcap role's builder down for a stub: this is about the loader's contract
    // with buildMesh, not about the hubcap generator, which tests/hubcap.test.ts covers directly.
    real = hubcapRole().buildMesh;
    hubcapRole().buildMesh = buildMesh as unknown as AssemblyRole['buildMesh'];
  });
  afterEach(() => {
    hubcapRole().buildMesh = real;
  });

  it('keeps what the builder returns, and the fetched asset alongside it', async () => {
    const part = asmCreateRolePart(hubcapRole());

    await asmLoadPartBuffer(part, twoFacedMesh(), 'clips.stl');

    expect(buildMesh).toHaveBeenCalledTimes(1);
    expect(part.positions).toEqual(builtMesh());
    // kept so a parameter change can regenerate without re-fetching, and so export placement can
    // tell a generated part from a drifted asset
    expect(part.assetPositions).toBeInstanceOf(Float32Array);
    expect(part.assetPositions).not.toEqual(part.positions);
  });
});

describe('asmLoadLibraryEntryIntoPart', () => {
  const entry: LibraryEntry = { id: 'w', name: 'Wheel', file: 'stl/w.stl' };

  it('records which library part it is and applies the entry’s base depth', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => twoFacedMesh() }),
    );
    const part = asmCreateRolePart(role());

    await asmLoadLibraryEntryIntoPart(part, { ...entry, baseDepth: 2.5 });

    expect(part.libraryPartId).toBe('w');
    expect(part.baseDepth).toBe(2.5);
    expect(part.loaded).toBe(true);
  });

  it('keeps the default base depth when the entry does not set one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => twoFacedMesh() }),
    );
    const part = asmCreateRolePart(role());
    const wasDefault = part.baseDepth;

    await asmLoadLibraryEntryIntoPart(part, entry);

    expect(part.baseDepth).toBe(wasDefault);
  });

  it('names the part and the file when the fetch 404s', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const part = asmCreateRolePart(role());

    await asmLoadLibraryEntryIntoPart(part, entry);

    const msg = vi.mocked(alertDialog).mock.calls[0][0] as string;
    expect(msg).toContain('Wheel');
    expect(msg).toContain('stl/w.stl');
    expect(msg).toContain('404');
    expect(part.loaded).toBe(false);
  });

  it('reports a network failure rather than leaving the part silently blank', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const part = asmCreateRolePart(role());

    await asmLoadLibraryEntryIntoPart(part, entry);

    expect(alertDialog).toHaveBeenCalledWith(expect.stringContaining('offline'));
  });
});

describe('loadPartsLibrary', () => {
  it('populates the library and version-tags the manifest URL', async () => {
    const lib: LibraryEntry[] = [{ id: 'w', name: 'Wheel', file: 'stl/w.stl' }];
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => lib });
    vi.stubGlobal('fetch', fetchMock);
    state.shapeKind = 'disc'; // keep auto-load out of this test

    await loadPartsLibrary();

    expect(state.assembly.library).toEqual(lib);
    expect(fetchMock.mock.calls[0][0]).toMatch(/^stl\/parts\.json\?v=.+/);
  });

  it('leaves the library empty and stays silent when there is no manifest', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    state.shapeKind = 'disc';

    await loadPartsLibrary();

    expect(state.assembly.library).toEqual([]);
    expect(alertDialog).not.toHaveBeenCalled();
  });

  it('survives a manifest that is not valid JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token <');
        },
      }),
    );
    state.shapeKind = 'disc';

    await expect(loadPartsLibrary()).resolves.toBeUndefined();
    expect(state.assembly.library).toEqual([]);
  });
});

describe('maybeAutoLoadAssembly', () => {
  it('does nothing outside assembly mode', () => {
    state.shapeKind = 'disc';

    maybeAutoLoadAssembly();

    expect(state.assembly.parts).toHaveLength(0);
  });

  it('does nothing when parts are already present', () => {
    const existing = loadedPart();

    maybeAutoLoadAssembly();

    expect(state.assembly.parts).toEqual([existing]);
  });

  it('does nothing when the library cannot satisfy the kind', () => {
    state.assembly.library = []; // nothing to auto-load from

    maybeAutoLoadAssembly();

    expect(state.assembly.parts).toHaveLength(0);
  });
});

describe('asmLoadFullAssembly', () => {
  it('explains itself rather than silently doing nothing when the library is unreachable', async () => {
    state.assembly.library = [];

    await asmLoadFullAssembly();

    expect(alertDialog).toHaveBeenCalledWith(expect.stringMatching(/Reload the page/));
    expect(state.assembly.parts).toHaveLength(0);
  });

  it('is a no-op when no assembly kind is selected', async () => {
    state.assembly.kindId = null;

    await asmLoadFullAssembly();

    expect(alertDialog).not.toHaveBeenCalled();
    expect(state.assembly.parts).toHaveLength(0);
  });

  it('warns before discarding parts the user already has, and honors a cancel', async () => {
    const existing = loadedPart();
    state.assembly.library = wheelLibrary();
    vi.mocked(confirmDialog).mockResolvedValue(false);

    await asmLoadFullAssembly();

    expect(confirmDialog).toHaveBeenCalledWith(expect.stringMatching(/clears any parts/));
    expect(state.assembly.parts).toEqual([existing]);
  });

  it('loads every role plus its rotated copies once confirmed', async () => {
    state.assembly.library = wheelLibrary();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => twoFacedMesh() }),
    );

    await asmLoadFullAssembly();

    // wheel = Top (1 primary + 1 rotated copy) + Cap
    expect(state.assembly.parts.map((p) => p.roleId)).toEqual([
      'wheel-half',
      'wheel-half',
      'wheel-hub-cap',
    ]);
    const copy = state.assembly.parts[1];
    expect(copy.isDuplicateOf).toBe(state.assembly.parts[0].id);
    expect(copy.name).toBe('Bottom');
    expect(copy.angleDeg).toBe(180);
  });

  it('does not ask before loading into an empty assembly', async () => {
    state.assembly.library = wheelLibrary();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => twoFacedMesh() }),
    );

    await asmLoadFullAssembly();

    expect(confirmDialog).not.toHaveBeenCalled();
  });

  it('abandons its parts when a kind switch replaces the list mid-load', async () => {
    state.assembly.library = wheelLibrary();
    // the switch lands while the first role's mesh is in flight
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        state.assembly.parts = [];
        return { ok: true, arrayBuffer: async () => twoFacedMesh() };
      }),
    );

    await asmLoadFullAssembly();

    // the newer load owns the list — this one must not push its parts into it
    expect(state.assembly.parts).toHaveLength(0);
  });
});
