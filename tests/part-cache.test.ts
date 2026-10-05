import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { buildAssemblyGeometry, type AssemblyBuildInput } from '../src/geometry/assembly';
import { raiseTornWarning } from '../src/geometry/assemblyWarnings';
import {
  newPartTally,
  type BuildContext,
  type BuildTally,
  type CrossPartState,
  type PartTally,
  type TornPill,
} from '../src/geometry/buildContext';
import { armCsgFaults } from '../src/geometry/csgFault';
import { getManifold, takeEngineTrapped } from '../src/geometry/manifold';
import {
  cutPart,
  PartCache,
  partKeyer,
  type CachedBuild,
  type PartResult,
} from '../src/geometry/partCache';
import type { DesignPlacement, ZoneMapper } from '../src/geometry/zones';
import {
  clearWarnings,
  dropBuildWarningsSince,
  journalWarnings,
  warnBuild,
  warningMark,
  WARNINGS,
  type WarningCall,
} from '../src/warnings';
import type { AssemblyBuild, AssemblyPart, ParsedSVG, PolyFeature } from '../src/types';

function boxPart(id: number, name: string, height: number): AssemblyPart {
  const geo = new THREE.BoxGeometry(40, height, 40).toNonIndexed();
  geo.translate(0, height / 2, 0);
  return {
    id,
    name,
    roleId: 'role',
    positions: Float32Array.from(geo.attributes.position.array as Float32Array),
    patches: null,
    patchIdx: 0,
    boundaryLoops: [
      [
        [-20, height, -20],
        [20, height, -20],
        [20, height, 20],
        [-20, height, 20],
      ],
    ],
    patchNormal: [0, 1, 0],
    topZ: height,
    baseDepth: 0,
    isDuplicateOf: null,
    pivotX: 0,
    pivotZ: 0,
    angleDeg: 0,
    loaded: true,
    cutThrough: false,
  };
}

const square = (x: number, s: number) => [
  { x, y: 0 },
  { x: x + s, y: 0 },
  { x: x + s, y: s },
  { x, y: s },
  { x, y: 0 },
];

function twoColors(shift = 0): ParsedSVG {
  return {
    shapes: [
      { fill: '#ff0000', loops: [square(shift, 10)], order: 0 },
      { fill: '#0000ff', loops: [square(shift + 12, 10)], order: 1 },
    ],
    bbox: { minX: shift, minY: 0, maxX: shift + 22, maxY: 10 },
    rawSVGCircle: { cx: shift + 11, cy: 5, r: 11 },
  };
}

const design = (parsed: ParsedSVG, zoneId: string | null = null) => ({
  parsed,
  name: 'square',
  zoneId,
  scaleMult: 1,
  maxScaleMult: 4,
  offX: 0,
  offZ: 0,
  flipX: false,
  flipY: false,
  rotationDeg: 0,
  mode: 'sticker' as const,
});

/**
 * Two parts that say different things: one design placed twice (overlap, said by the first part
 * only), a depth too deep for either (a pill per part), and a zero depth on blue (said once, at the
 * end, from what every part staged).
 */
function scene(): AssemblyBuildInput {
  const art = twoColors();
  return {
    artworks: [design(art), design(art)],
    parts: [boxPart(1, 'A', 10), boxPart(2, 'B', 6)],
    mergeGroups: [],
    colorSettings: { 'asm:#0000ff': { depth: 0 } },
    globalDepth: 20,
    radius: 15,
  };
}

/** Mark ids are journal positions, which differ by design between two journals of one sequence. */
function normalized(journal: WarningCall[]): WarningCall[] {
  const ids = new Map<number, number>();
  return journal.map((c) => {
    if (c.op !== 'mark' && c.op !== 'drop') return c;
    if (!ids.has(c.id)) ids.set(c.id, ids.size);
    return { op: c.op, id: ids.get(c.id)! };
  });
}

/** The latest cached build's reused/cut lists. */
let last: CachedBuild;

/** What reaches the page from one build: the list it leaves, the calls behind it, every byte. */
async function run(input: AssemblyBuildInput, cache?: PartCache) {
  clearWarnings();
  const journal: WarningCall[] = [];
  journalWarnings(journal);
  let build: AssemblyBuild | null;
  try {
    const cached = cache?.begin(input.parts);
    if (cached) last = cached;
    build = await buildAssemblyGeometry(input, cached);
  } finally {
    journalWarnings(null);
  }
  return {
    warnings: WARNINGS.map((w) => ({ ...w })),
    journal: normalized(journal),
    build: build && {
      ...build,
      partOutputs: build.partOutputs.map((o) => ({
        part: o.part.id,
        body: Buffer.from(o.bodySoup.buffer).toString('base64'),
        inlays: Object.entries(o.inlaySoups).map(([ci, s]) => [
          ci,
          Buffer.from(s.buffer).toString('base64'),
        ]),
        bodyIndexed: o.bodyIndexed && Buffer.from(o.bodyIndexed.indices.buffer).toString('base64'),
      })),
    },
  };
}

beforeAll(async () => {
  await getManifold();
});

afterEach(() => {
  armCsgFaults('');
  vi.restoreAllMocks();
});

describe('a part replayed from the cache', () => {
  it('puts on the page exactly what cutting it would: warnings, their order, its tally', async () => {
    const cache = new PartCache();
    const first = scene();
    await run(first, cache);
    expect(last.cut).toEqual([0, 1]);

    // B gets a new mesh object with the same content: B is cut, A is replayed.
    const [a, b] = first.parts;
    const second = { ...first, parts: [a, { ...b, positions: Float32Array.from(b.positions!) }] };
    const cached = await run(second, cache);
    expect(last.reused).toEqual([0]);
    expect(last.cut).toEqual([1]);

    const fresh = await run(second);
    // The scene has to exercise each thing a replay owes, or this proves nothing.
    const said = fresh.warnings.map((w) => w.message).join('\n');
    expect(said).toMatch(/Two placements of "square" overlap/);
    expect(said).toMatch(/deeper than "A" goes/);
    expect(said).toMatch(/deeper than "B" goes/);
    expect(said).toMatch(/Depth for "#0000ff" was set to 0\.00 mm/);
    expect(cached.warnings).toEqual(fresh.warnings);
    expect(cached.journal).toEqual(fresh.journal);
    expect(cached.build).toEqual(fresh.build);
  });

  it('stays exact replayed twice, so a replay never edits what it replays from', async () => {
    const cache = new PartCache();
    const input = scene();
    const fresh = await run(input);
    await run(input, cache);
    for (let i = 0; i < 2; i++) {
      const again = await run(input, cache);
      expect(last.reused).toEqual([0, 1]);
      expect(again).toEqual(fresh);
    }
  });
});

describe('a changed input is never replayed', () => {
  type Edit = (s: AssemblyBuildInput) => AssemblyBuildInput;
  const art = (s: AssemblyBuildInput, i: number, over: object) => ({
    ...s,
    artworks: s.artworks.map((a, j) => (j === i ? { ...a, ...over } : a)),
  });
  const part = (s: AssemblyBuildInput, i: number, over: Partial<AssemblyPart>) => ({
    ...s,
    parts: s.parts.map((p, j) => (j === i ? { ...p, ...over } : p)),
  });
  const cases: [string, Edit, number[]][] = [
    ['a design moved', (s) => art(s, 0, { offX: 3 }), [0, 1]],
    ['a design renamed (warnings name it)', (s) => art(s, 1, { name: 'other' }), [0, 1]],
    ['a design mirrored', (s) => art(s, 0, { flipX: true }), [0, 1]],
    ['a design redrawn', (s) => art(s, 0, { parsed: twoColors(2) }), [0, 1]],
    ['one color deeper', (s) => ({ ...s, colorSettings: { 'asm:#ff0000': { depth: 1 } } }), [0, 1]],
    ['the global depth', (s) => ({ ...s, globalDepth: 0.1 }), [0, 1]],
    ['two colors merged', (s) => ({ ...s, mergeGroups: [['#ff0000', '#0000ff']] }), [0, 1]],
    ['the Design radius', (s) => ({ ...s, radius: 18 }), [0, 1]],
    ['one part re-meshed', (s) => part(s, 0, boxPart(1, 'A', 12)), [0]],
    ['one part renamed', (s) => part(s, 1, { name: 'B2' }), [1]],
    ['one part cut through', (s) => part(s, 1, { cutThrough: true }), [1]],
  ];
  it.each(cases)('%s', async (_name, edit, recut) => {
    const cache = new PartCache();
    const before = scene();
    await run(before, cache);
    const after = edit(before);
    const cached = await run(after, cache);
    expect(last.cut).toEqual(recut);
    expect(cached).toEqual(await run(after));
  });

  it("re-cuts a rotated copy when its source's face changes, which its mapper reads", async () => {
    const src = boxPart(1, 'Top', 10);
    const copy: AssemblyPart = {
      ...boxPart(2, 'Bottom', 10),
      isDuplicateOf: 1,
      patchNormal: undefined,
      angleDeg: 90,
    };
    const before: AssemblyBuildInput = { ...scene(), parts: [src, copy] };
    const cache = new PartCache();
    await run(before, cache);
    const after = { ...before, parts: [{ ...src, patchNormal: [0, 1, 0] }, copy] };
    const cached = await run(after, cache);
    expect(last.cut).toEqual([0, 1]);
    expect(cached).toEqual(await run(after));
  });

  it('replays every part for an edit to a design on a zone none of them has', async () => {
    const cache = new PartCache();
    const base = scene();
    const before = { ...base, artworks: [...base.artworks, design(twoColors(), 'elsewhere')] };
    await run(before, cache);
    const after = art(before, 2, { offX: 5, scaleMult: 2 });
    const cached = await run(after, cache);
    expect(last.reused).toEqual([0, 1]);
    expect(cached).toEqual(await run(after));
  });
});

describe('what the cache refuses to keep', () => {
  it('stores nothing and replays nothing while ?csgfault is armed', async () => {
    const cache = new PartCache();
    const input = scene();
    armCsgFaults('?csgfault=intersection:1');
    await run(input, cache);
    const armed = await run(input, cache);
    expect(last.reused).toEqual([]);
    expect(armed.warnings.map((w) => w.message).join('\n')).toMatch(/Couldn't fit the inlay/);
    armCsgFaults('');
    await run(input, cache);
    expect(last.cut).toEqual([0, 1]);
  });

  it('cuts a part again after the engine trapped on it, rather than replaying the trap', async () => {
    const cache = new PartCache();
    const input = scene();
    const wasm = await getManifold();
    const spy = vi.spyOn(wasm.Manifold, 'difference').mockImplementation(() => {
      throw new WebAssembly.RuntimeError('memory access out of bounds');
    });
    const failed = await run(input, cache);
    expect(failed.warnings.map((w) => w.message).join('\n')).toMatch(/Couldn't cut the recesses/);
    spy.mockRestore();
    const healed = await run(input, cache);
    expect(last.cut).toEqual([0, 1]);
    expect(healed).toEqual(await run(input));
    takeEngineTrapped();
  });

  it('replays an engine exception, which unwinds cleanly and comes back the same', async () => {
    const cache = new PartCache();
    const input = scene();
    const wasm = await getManifold();
    vi.spyOn(wasm.Manifold, 'difference').mockImplementation(() => {
      throw new Error('engine exception');
    });
    await run(input, cache);
    const replayed = await run(input, cache);
    expect(last.reused).toEqual([0, 1]);
    expect(replayed.warnings.map((w) => w.message).join('\n')).toMatch(/Couldn't cut the recesses/);
    expect(replayed).toEqual(await run(input));
  });
});

describe('the cross-part state a part was cut against', () => {
  // Two stand-in parts writing what the real ones do: A raises a torn-sheet pill and marks a zone
  // checked; B raises a worse or better tear (dismissing A's pill, or not), and checks the zone
  // only if A didn't. Drop-since-mark rides along, since a replay must carry its marks.
  const A = { id: 1, name: 'A' } as AssemblyPart;
  const B = { id: 2, name: 'B' } as AssemblyPart;
  const parts = [A, B];

  async function pass(cache: PartCache | null, tearA: number, aChecksZone = true, tearE = 1) {
    clearWarnings();
    const journal: WarningCall[] = [];
    journalWarnings(journal);
    const cross = {
      tornPills: new Map<string, TornPill>(),
      overlapCheckedZones: new Set<string>(),
    } satisfies CrossPartState;
    const tally: PartTally = newPartTally();
    const buildA = async (t: BuildTally): Promise<PartResult> => {
      warnBuild('A was cut');
      raiseTornWarning(t.tornPills, 'D', ['x', 'y'], tearA);
      raiseTornWarning(t.tornPills, 'E', ['x', 'y'], tearE);
      if (aChecksZone) t.overlapCheckedZones.add('z');
      t.landedColors.add(0);
      return { output: null, placed: true };
    };
    const buildB = async (t: BuildTally): Promise<PartResult> => {
      const mark = warningMark();
      warnBuild('B scratch');
      dropBuildWarningsSince(mark);
      raiseTornWarning(t.tornPills, 'D', ['y', 'x'], 7);
      if (!t.overlapCheckedZones.has('z')) warnBuild('B checked z');
      t.hiddenColors.add(1);
      return { output: null, placed: false };
    };
    try {
      const cached = cache?.begin(parts);
      if (cached) last = cached;
      const keys = [`A:${tearA}:${aChecksZone}:${tearE}`, 'B'];
      const builds = [buildA, buildB];
      for (let i = 0; i < 2; i++)
        if (cached) await cached.run(i, parts[i], keys[i], cross, tally, builds[i]);
        else await cutPart(cross, tally, builds[i]);
    } finally {
      journalWarnings(null);
    }
    return {
      warnings: WARNINGS.map((w) => ({ ...w })),
      journal: normalized(journal),
      tally: Object.entries(tally).map(([k, v]) => [k, [...(v as Iterable<unknown>)]]),
      cross: [[...cross.tornPills], [...cross.overlapCheckedZones]],
    };
  }

  it('replays B only into the state it was cut against, so a dismiss never lands wrong', async () => {
    const cache = new PartCache();
    await pass(cache, 5);
    expect(await pass(cache, 5)).toEqual(await pass(null, 5));
    // B's own key is unchanged, but A now leaves a worse tear, so B's dismiss would be wrong.
    const worse = await pass(cache, 12);
    expect(last.cut).toEqual([0, 1]);
    expect(worse).toEqual(await pass(null, 12));
    const unchecked = await pass(cache, 12, false);
    expect(last.cut).toEqual([0, 1]);
    expect(unchecked).toEqual(await pass(null, 12, false));
    expect(unchecked.warnings.map((w) => w.message)).toContain('B checked z');
  });

  it('still replays B when A changes only state B never touches', async () => {
    const cache = new PartCache();
    await pass(cache, 5, true, 1);
    const other = await pass(cache, 5, true, 2);
    expect(last.reused).toEqual([1]);
    expect(other).toEqual(await pass(null, 5, true, 2));
  });

  it('replays the warning calls themselves, so a dismissed pill is dismissed again', async () => {
    const cache = new PartCache();
    await pass(cache, 5);
    const replayed = await pass(cache, 5);
    expect(last.reused).toEqual([0, 1]);
    expect(replayed.journal.map((c) => c.op)).toEqual([
      'push',
      'push',
      'push',
      'mark',
      'push',
      'drop',
      'dismiss',
      'push',
    ]);
  });
});

describe('the key', () => {
  // Every field of the context buildPart reads, changed one at a time on the design this part
  // carries and on one bound to a zone it lacks. The second must not move the key.
  const ink = (x: number): PolyFeature => ({
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [x, 0],
          [1, 0],
          [1, 1],
          [x, 0],
        ],
      ],
    },
  });
  const placement: DesignPlacement = {
    svgC: { cx: 0, cy: 0, r: 1 },
    mmPerUnit: 1,
    xFlip: 1,
    zMul: -1,
    offX: 0,
    offZ: 0,
    rotationDeg: 0,
  };
  const cell = { x: 0, y: 0, w: 10, h: 10 };
  const [mine, other] = [twoColors(), twoColors()];
  const base = (): BuildContext => ({
    artworks: [design(mine, 'mine'), design(other, 'other')],
    palette: [{ hex: '#ff0000', key: 'asm:#ff0000', members: ['#ff0000'], isMerge: false }],
    featuresByColor: [[ink(0), ink(0)]],
    placements: [placement, placement],
    maxScalePlacement: () => placement,
    tileCells: [cell, cell],
    tileVerts: [4, 4],
    colorSettings: {},
    globalDepth: 1,
    wasm: null as never,
  });
  const part = boxPart(1, 'A', 10);
  const key = (ctx: BuildContext) =>
    partKeyer(ctx, [part], false)(part, [{ zoneId: 'mine' } as ZoneMapper]);
  const edits: [string, (c: BuildContext) => void, boolean][] = [
    ['its ink', (c) => (c.featuresByColor = [[ink(0.5), ink(0)]]), true],
    ['its ink, by a sign bit', (c) => (c.featuresByColor = [[ink(-0), ink(0)]]), true],
    ['the other ink', (c) => (c.featuresByColor = [[ink(0), ink(0.5)]]), false],
    ['its placement', (c) => (c.placements = [{ ...placement, mmPerUnit: 2 }, placement]), true],
    ['the other placement', (c) => (c.placements = [placement, { ...placement, offX: 3 }]), false],
    ['its tile', (c) => (c.tileCells = [{ ...cell, w: 11 }, cell]), true],
    ['its tile points', (c) => (c.tileVerts = [5, 4]), true],
    ['its offset, 0 to -0', (c) => (c.artworks[0] = { ...c.artworks[0], offX: -0 }), true],
    ['the palette', (c) => (c.palette = [{ ...c.palette[0], isMerge: true }]), true],
    ['a depth on its color', (c) => (c.colorSettings = { 'asm:#ff0000': { depth: 2 } }), true],
    ['a depth on no color', (c) => (c.colorSettings = { 'asm:#00ff00': { depth: 2 } }), false],
    ['the global depth', (c) => (c.globalDepth = 2), true],
  ];
  it.each(edits)('%s', (_name, edit, moves) => {
    const after = base();
    edit(after);
    expect(key(after) !== key(base())).toBe(moves);
  });

  it('keys a fill on its placement at max Scale, which its refusal message reads', () => {
    const fill = (mmPerUnit: number) => {
      const c = base();
      c.artworks[0] = { ...c.artworks[0], mode: 'fill' };
      c.maxScalePlacement = () => ({ ...placement, mmPerUnit });
      return key(c);
    };
    expect(fill(4)).not.toEqual(fill(5));
  });

  it('tells a NaN depth from an infinite one, which JSON would write alike', () => {
    const [nan, inf] = [base(), base()];
    nan.globalDepth = NaN;
    inf.globalDepth = Infinity;
    expect(key(nan)).not.toEqual(key(inf));
  });
});
