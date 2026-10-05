import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { buildAssemblyGeometry, type AssemblyBuildInput } from '../src/geometry/assembly';
import {
  BUILD_PART_FIELDS,
  decodeInput,
  encodeInput,
  packBuild,
  partBuffers,
  unpackBuild,
  type FromWorker,
  type ToWorker,
} from '../src/geometry/buildWire';
import {
  BuildWorkerCrashed,
  BuildWorkerFault,
  lastBuildReuse,
  runAssemblyBuild,
  setBuildWorkerFactory,
  type BuildWorkerLike,
} from '../src/app/buildClient';
import { armCancel, cancelHonoured, RebuildCancelled, requestCancel } from '../src/cancel';
import { setProgressSink } from '../src/progress';
import { clearWarnings, warn, WARNINGS } from '../src/warnings';
import type { AssemblyBuild, AssemblyPart, ParsedSVG } from '../src/types';

function boxPart(overrides: Partial<AssemblyPart> = {}): AssemblyPart {
  const geo = new THREE.BoxGeometry(40, 10, 40).toNonIndexed();
  geo.translate(0, 5, 0);
  return {
    id: 1,
    name: 'test box',
    roleId: 'role',
    positions: Float32Array.from(geo.attributes.position.array as Float32Array),
    patches: null,
    patchIdx: 0,
    boundaryLoops: [
      [
        [-20, 10, -20],
        [20, 10, -20],
        [20, 10, 20],
        [-20, 10, 20],
      ],
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
  };
}

const square = (x: number, y: number, s: number) => [
  { x, y },
  { x: x + s, y },
  { x: x + s, y: y + s },
  { x, y: y + s },
  { x, y },
];

function parsed(fill = '#ff0000'): ParsedSVG {
  return {
    shapes: [{ fill, loops: [square(0, 0, 10)], order: 0 }],
    bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    rawSVGCircle: { cx: 5, cy: 5, r: 5 },
  };
}

const placed = (p: ParsedSVG, offX = 0) => ({
  parsed: p,
  name: 'square',
  scaleMult: 1,
  offX,
  offZ: 0,
  flipX: false,
  flipY: false,
  rotationDeg: 0,
});

/** A red square on the part and a blue one pushed off it, so the build has something to say. */
function input(p: ParsedSVG = parsed(), parts = [boxPart()]): AssemblyBuildInput {
  return {
    artworks: [placed(p), placed(parsed('#0000ff'), 1000)],
    parts,
    mergeGroups: [],
    colorSettings: {},
    globalDepth: 1,
    radius: 15,
  };
}

/** Listeners and termination, as a Worker has them. */
class FakeWorker implements BuildWorkerLike {
  private listeners: Record<string, ((e: never) => void)[]> = {};
  terminated = false;
  received: ToWorker[] = [];

  postMessage(msg: ToWorker): void {
    if (!this.terminated) this.received.push(msg);
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(type: string, fn: (e: never) => void): void {
    (this.listeners[type] ||= []).push(fn);
  }

  emit(type: string, e: unknown): void {
    if (this.terminated) return;
    for (const fn of this.listeners[type] ?? []) fn(e as never);
  }
}

/** Answers nothing unless told to: for the client's own paths (crash, linger, stale ids). */
class ScriptedWorker extends FakeWorker {
  reply(msg: FromWorker): void {
    this.emit('message', { data: msg });
  }
}

/**
 * The worker's code in-process, in its own module registry: in a browser it has its own cancel
 * flag, warnings list and progress sink, and sharing the page's here would hide every bug where
 * the two disagree. Messages are structured-cloned with their transfer lists, as postMessage does.
 */
class InProcessWorker extends FakeWorker {
  private core: Promise<(msg: ToWorker) => Promise<void>>;

  constructor() {
    super();
    vi.resetModules();
    this.core = import('../src/geometry/buildWorkerCore').then((m) => {
      const post = (msg: FromWorker, transfer: Transferable[] = []): void => {
        const data = structuredClone(msg, { transfer });
        setTimeout(() => this.emit('message', { data }));
      };
      const { onMessage } = m.startBuildWorker(post);
      // What buildWorker.ts does once its code has loaded.
      post({ type: 'ready' });
      return onMessage;
    });
  }

  override postMessage(msg: ToWorker): void {
    if (this.terminated) return;
    const data = structuredClone(msg);
    this.received.push(data);
    void this.core.then((handle) => setTimeout(() => !this.terminated && void handle(data)));
  }
}

const soupBytes = (b: AssemblyBuild) =>
  b.partOutputs.map((o) => ({
    part: o.part,
    body: Buffer.from(o.bodySoup.buffer).toString('base64'),
    inlays: Object.fromEntries(
      Object.entries(o.inlaySoups).map(([k, v]) => [k, Buffer.from(v.buffer).toString('base64')]),
    ),
    bodyIndexed: o.bodyIndexed && Buffer.from(o.bodyIndexed.indices.buffer).toString('base64'),
  }));

beforeEach(() => {
  clearWarnings();
  armCancel();
});

afterEach(() => {
  setBuildWorkerFactory(null);
  setProgressSink(null);
  vi.useRealTimers();
});

describe('the build input crossing to the worker', () => {
  it('sends an object once, then names it, and the worker keeps the same instance', () => {
    const held = new Set<number>();
    const cache = new Map<number, unknown>();
    const inp = input();
    const first = encodeInput(inp, held);
    const second = encodeInput(inp, held);

    expect('value' in first.artworks[0].parsed).toBe(true);
    expect('value' in second.artworks[0].parsed).toBe(false);
    expect(Object.values(second.parts[0].refs).every((r) => !('value' in r))).toBe(true);

    // Identity is the regions memo's key: a second clone of the same shapes would always miss it.
    const a = decodeInput(structuredClone(first), cache);
    const b = decodeInput(structuredClone(second), cache);
    expect(b.artworks[0].parsed).toBe(a.artworks[0].parsed);
    expect(b.parts[0].positions).toBe(a.parts[0].positions);
    for (const k of BUILD_PART_FIELDS) expect(b.parts[0][k]).toEqual(inp.parts[0][k]);
  });

  it('sends only the part fields the build reads, and a read of any other throws by name', () => {
    const part = boxPart({
      restPositions: new Float32Array(9),
      assetPositions: new Float32Array(9),
    });
    const wire = encodeInput(input(parsed(), [part]), new Set());
    expect(Object.keys({ ...wire.parts[0].scalars, ...wire.parts[0].refs }).sort()).toEqual(
      [...BUILD_PART_FIELDS].sort(),
    );
    const [out] = decodeInput(structuredClone(wire), new Map()).parts;
    expect(() => out.restPositions).toThrow(/AssemblyPart.restPositions isn't sent/);
    expect(() => out.patches).toThrow(/AssemblyPart.patches isn't sent/);
  });

  it('forgets on both sides whatever the latest request no longer uses', () => {
    const held = new Set<number>();
    const cache = new Map<number, unknown>();
    decodeInput(structuredClone(encodeInput(input(), held)), cache);
    const swapped = { ...input(), artworks: [placed(parsed())] };
    decodeInput(structuredClone(encodeInput(swapped, held)), cache);

    expect([...cache.keys()].sort()).toEqual([...held].sort());
    // The dropped parse is resent, not named, if it comes back.
    const again = encodeInput(swapped, held);
    expect('value' in again.artworks[0].parsed).toBe(false);
  });

  it('keeps an object two parts share as one object in the worker', () => {
    const loops = boxPart().boundaryLoops;
    const parts = [boxPart({ boundaryLoops: loops }), boxPart({ id: 2, boundaryLoops: loops })];
    const out = decodeInput(
      structuredClone(encodeInput(input(parsed(), parts), new Set())),
      new Map(),
    );
    expect(out.parts[1].boundaryLoops).toBe(out.parts[0].boundaryLoops);
  });

  it('refuses a name the worker was never sent, rather than building without it', () => {
    const held = new Set<number>();
    const inp = input();
    encodeInput(inp, held);
    const wire = encodeInput(inp, held);
    expect(() => decodeInput(wire, new Map())).toThrow(/never sent/);
  });
});

describe('the build result crossing back', () => {
  it("reattaches the page's own parts and moves every mesh buffer but the inputs", async () => {
    const inp = input();
    const built = (await buildAssemblyGeometry(inp))!;
    const [part] = inp.parts;
    // A fallback body handing back the part's own mesh must be copied, or the worker's cached input dies.
    built.partOutputs.push({ part, bodySoup: part.positions!, inlaySoups: {} });
    const { wire, transfer } = packBuild(built, inp.parts, partBuffers(inp.parts));

    expect(transfer).not.toContain(part.positions!.buffer);
    expect(transfer).toContain(built.partOutputs[0].bodySoup.buffer);
    const back = unpackBuild(structuredClone(wire), inp.parts);
    expect(back.partOutputs[0].part).toBe(part);
    expect(back.palette).toEqual(built.palette);
  });

  it('refuses an output naming a part that was not in the request', async () => {
    const inp = input();
    const built = (await buildAssemblyGeometry(inp))!;
    expect(() => packBuild(built, [boxPart()], new Set())).toThrow(/names no input part/);
  });
});

describe('runAssemblyBuild through a worker', () => {
  it('builds what the page would have built, warnings included', async () => {
    // Every field a loaded part carries, so a read of one the worker isn't sent throws here.
    const part = boxPart({
      indexed: { positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) },
      vertices: new Float32Array(9),
      restPositions: new Float32Array(9),
      assetPositions: new Float32Array(9),
      libraryPartId: 'lib',
      buildWarning: 'w',
      patches: [],
    });
    const inp = input(parsed(), [part]);
    const direct = (await buildAssemblyGeometry(inp))!;
    const directWarnings = WARNINGS.map((w) => ({ ...w }));
    expect(directWarnings.length).toBeGreaterThan(0);

    clearWarnings();
    setBuildWorkerFactory(() => new InProcessWorker());
    const viaWorker = (await runAssemblyBuild(inp))!;

    expect(soupBytes(viaWorker)).toEqual(soupBytes(direct));
    expect(viaWorker.palette).toEqual(direct.palette);
    expect(viaWorker.detectedColors).toEqual(direct.detectedColors);
    expect(WARNINGS).toEqual(directWarnings);
  });

  it("replays the worker's calls against the page's list, so a standing fact keeps its scope", async () => {
    const direct = (await buildAssemblyGeometry(input()))!;
    expect(direct).not.toBeNull();
    const said = WARNINGS[0].message;
    clearWarnings();
    // Standing on the page, raised by the build too: unkeyed pushes skip what stands.
    warn(said);
    setBuildWorkerFactory(() => new InProcessWorker());
    await runAssemblyBuild(input());
    expect(WARNINGS.filter((w) => w.message === said)).toEqual([
      { message: said, level: 'warn', key: undefined },
    ]);
  });

  it('replays unchanged parts across builds, and every build still brings its bytes', async () => {
    const a = boxPart();
    const b = boxPart({ id: 2, name: 'second box' });
    const inp = input(parsed(), [a, b]);
    const direct = (await buildAssemblyGeometry(inp))!;
    const directWarnings = WARNINGS.map((w) => ({ ...w }));
    setBuildWorkerFactory(() => new InProcessWorker());

    clearWarnings();
    await runAssemblyBuild(inp);
    expect(lastBuildReuse()).toEqual({ reused: [], cut: ['test box', 'second box'] });
    // Three replays: a stored mesh moved to the page rather than copied would arrive empty from
    // the second on, its buffer detached in the worker.
    for (let i = 0; i < 3; i++) {
      clearWarnings();
      const again = (await runAssemblyBuild(inp))!;
      expect(lastBuildReuse()).toEqual({ reused: ['test box', 'second box'], cut: [] });
      expect(soupBytes(again)).toEqual(soupBytes(direct));
      expect(WARNINGS).toEqual(directWarnings);
    }
    clearWarnings();
    const moved = { ...inp, parts: [a, { ...b, positions: Float32Array.from(b.positions!) }] };
    await runAssemblyBuild(moved);
    expect(lastBuildReuse()).toEqual({ reused: ['test box'], cut: ['second box'] });
    // A build that returns before the part loop reports its own empty lists, not the last ones.
    await runAssemblyBuild({ ...inp, artworks: [] });
    expect(lastBuildReuse()).toEqual({ reused: [], cut: [] });
  });

  it('forwards progress to the curtain', async () => {
    const seen: number[] = [];
    setProgressSink((f) => seen.push(f));
    setBuildWorkerFactory(() => new InProcessWorker());
    await runAssemblyBuild(input());
    expect(seen.length).toBeGreaterThan(2);
    expect(seen.at(-1)).toBe(1);
  });

  it('answers a cancel at once, honoured, and reuses the worker once it has stopped', async () => {
    let spawned = 0;
    let w!: InProcessWorker;
    setBuildWorkerFactory(() => {
      spawned++;
      return (w = new InProcessWorker());
    });
    const run = runAssemblyBuild(input());
    requestCancel();
    await expect(run).rejects.toBeInstanceOf(RebuildCancelled);
    expect(cancelHonoured()).toBe(true);
    expect(w.received.map((m) => m.type)).toEqual(['build', 'cancel']);

    // Let it unwind on its own, inside the grace period.
    await vi.waitFor(() => expect(w.received).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 200));
    armCancel();
    expect(await runAssemblyBuild(input())).not.toBeNull();
    expect(spawned).toBe(1);
    expect(w.terminated).toBe(false);
  });

  it('terminates a cancelled worker that lingers, and the next build gets a fresh one', async () => {
    vi.useFakeTimers();
    const workers: ScriptedWorker[] = [];
    setBuildWorkerFactory(() => {
      workers.push(new ScriptedWorker());
      return workers.at(-1)!;
    });
    const run = runAssemblyBuild(input());
    requestCancel();
    await expect(run).rejects.toBeInstanceOf(RebuildCancelled);
    expect(workers[0].terminated).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(workers[0].terminated).toBe(true);

    armCancel();
    void runAssemblyBuild(input());
    expect(workers).toHaveLength(2);
    // Everything is resent: the new worker holds nothing.
    const build = workers[1].received[0] as Extract<ToWorker, { type: 'build' }>;
    expect('value' in build.input.artworks[0].parsed).toBe(true);
  });

  it("doesn't queue a new build behind a cancelled one still unwinding", async () => {
    const workers: ScriptedWorker[] = [];
    setBuildWorkerFactory(() => {
      workers.push(new ScriptedWorker());
      return workers.at(-1)!;
    });
    const run = runAssemblyBuild(input());
    requestCancel();
    await expect(run).rejects.toBeInstanceOf(RebuildCancelled);
    armCancel();
    void runAssemblyBuild(input());
    expect(workers[0].terminated).toBe(true);
    expect(workers).toHaveLength(2);
  });

  it('turns a dead worker into BuildWorkerCrashed, and respawns for the next build', async () => {
    const workers: ScriptedWorker[] = [];
    setBuildWorkerFactory(() => {
      workers.push(new ScriptedWorker());
      return workers.at(-1)!;
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = runAssemblyBuild(input());
    workers[0].reply({ type: 'ready' });
    workers[0].emit('error', new Event('error'));
    await expect(run).rejects.toBeInstanceOf(BuildWorkerCrashed);
    expect(workers[0].terminated).toBe(true);

    const next = runAssemblyBuild(input());
    expect(workers).toHaveLength(2);
    const { id } = workers[1].received[0];
    workers[1].reply({
      type: 'done',
      id,
      build: null,
      warnings: [],
      trapped: false,
      reused: [],
      cut: [],
    });
    expect(await next).toBeNull();
    errSpy.mockRestore();
  });

  it("builds on the page, from then on, when the worker's code never loads", async () => {
    let spawned = 0;
    let w!: ScriptedWorker;
    setBuildWorkerFactory(() => {
      spawned++;
      return (w = new ScriptedWorker());
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const run = runAssemblyBuild(input());
    // A missing chunk: 'error' before 'ready'. Not a crash, and not the out-of-memory pill.
    w.emit('error', new Event('error'));
    const built = await run;
    expect(built?.partOutputs).toHaveLength(1);
    expect(w.terminated).toBe(true);
    expect(await runAssemblyBuild(input())).not.toBeNull();
    expect(spawned).toBe(1);
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('replaces a worker whose engine trapped, after answering', async () => {
    const workers: ScriptedWorker[] = [];
    setBuildWorkerFactory(() => {
      workers.push(new ScriptedWorker());
      return workers.at(-1)!;
    });
    const run = runAssemblyBuild(input());
    const { id } = workers[0].received[0];
    workers[0].reply({
      type: 'done',
      id,
      build: null,
      warnings: [],
      trapped: true,
      reused: [],
      cut: [],
    });
    expect(await run).toBeNull();
    expect(workers[0].terminated).toBe(true);
    void runAssemblyBuild(input());
    expect(workers).toHaveLength(2);
  });

  it('keeps a worker whose build only degraded, without a trap', async () => {
    let w!: ScriptedWorker;
    let spawned = 0;
    setBuildWorkerFactory(() => {
      spawned++;
      return (w = new ScriptedWorker());
    });
    const run = runAssemblyBuild(input());
    w.reply({
      type: 'done',
      id: w.received[0].id,
      build: null,
      warnings: [],
      trapped: false,
      reused: [],
      cut: [],
    });
    await run;
    void runAssemblyBuild(input());
    expect(spawned).toBe(1);
    expect(w.terminated).toBe(false);
  });

  it('fails a build the worker could not read in plain words, the detail on the console', async () => {
    let w!: ScriptedWorker;
    setBuildWorkerFactory(() => (w = new ScriptedWorker()));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = runAssemblyBuild(input());
    w.reply({ type: 'unreadable' });
    await expect(run).rejects.toBeInstanceOf(BuildWorkerFault);
    expect(errSpy).toHaveBeenCalledWith('build worker:', expect.stringMatching(/deserialize/));
    expect(w.terminated).toBe(true);
    errSpy.mockRestore();
  });

  it('puts a fault in what crossed on the console, and plain words on screen', async () => {
    let w!: ScriptedWorker;
    setBuildWorkerFactory(() => (w = new ScriptedWorker()));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = runAssemblyBuild(input());
    const detail = "AssemblyPart.restPositions isn't sent to the build worker (BUILD_PART_FIELDS)";
    w.reply({ type: 'failed', id: w.received[0].id, message: detail, warnings: [], wire: true });
    const e = await run.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BuildWorkerFault);
    expect((e as Error).message).not.toMatch(/AssemblyPart|BUILD_PART_FIELDS|worker/);
    expect(errSpy).toHaveBeenCalledWith('build worker:', detail);
    errSpy.mockRestore();
  });

  it('rethrows a build that failed in the worker, after saying what it said first', async () => {
    let w!: ScriptedWorker;
    setBuildWorkerFactory(() => (w = new ScriptedWorker()));
    const run = runAssemblyBuild(input());
    const { id } = w.received[0];
    // A late message from an earlier build is not this one's answer.
    w.reply({
      type: 'done',
      id: id - 1,
      build: null,
      warnings: [],
      trapped: false,
      reused: [],
      cut: [],
    });
    w.reply({
      type: 'failed',
      id,
      message: 'boom',
      warnings: [
        { op: 'push', notice: { message: 'before the throw', level: 'warn', build: true } },
      ],
    });
    await expect(run).rejects.toThrow('boom');
    expect(WARNINGS.map((x) => x.message)).toEqual(['before the throw']);
    // Something escaped the build: its heap is nobody's to vouch for.
    expect(w.terminated).toBe(true);
  });

  it('builds on the page when no worker can be made', async () => {
    setBuildWorkerFactory(() => {
      throw new Error('no module workers');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await runAssemblyBuild(input())).not.toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("the worker's message handler", () => {
  it('answers a build it cannot read with failed, and ignores a cancel for another build', async () => {
    const { startBuildWorker } = await import('../src/geometry/buildWorkerCore');
    const sent: FromWorker[] = [];
    const { onMessage } = startBuildWorker((msg) => sent.push(msg));
    await onMessage({ type: 'cancel', id: 7 });
    const held = new Set<number>();
    const inp = input();
    encodeInput(inp, held);
    // Names only: this worker was never sent the objects.
    await onMessage({ type: 'build', id: 8, search: '', input: encodeInput(inp, held) });
    expect(sent).toEqual([
      {
        type: 'failed',
        id: 8,
        message: expect.stringMatching(/never sent/),
        warnings: [],
        wire: true,
      },
    ]);
  });

  it('answers a message that failed to arrive', async () => {
    const { startBuildWorker } = await import('../src/geometry/buildWorkerCore');
    const sent: FromWorker[] = [];
    startBuildWorker((msg) => sent.push(msg)).onMessageError();
    expect(sent).toEqual([{ type: 'unreadable' }]);
  });

  it('says when the engine trapped during a build, and not when a cut merely failed', async () => {
    // Both from the registry the core runs in: an earlier InProcessWorker reset the modules.
    const { startBuildWorker } = await import('../src/geometry/buildWorkerCore');
    const { Manifold } = await (await import('../src/geometry/manifold')).getManifold();
    const sent: FromWorker[] = [];
    const { onMessage } = startBuildWorker((msg) => sent.push(msg));
    const build = async () =>
      onMessage({ type: 'build', id: 9, search: '', input: encodeInput(input(), new Set()) });

    const plain = vi.spyOn(Manifold, 'difference').mockImplementation(() => {
      throw new Error('not a trap');
    });
    await build();
    plain.mockRestore();
    const trap = vi.spyOn(Manifold, 'difference').mockImplementation(() => {
      throw new WebAssembly.RuntimeError('memory access out of bounds');
    });
    await build();
    trap.mockRestore();
    const done = sent.filter((m) => m.type === 'done');
    expect(done.map((m) => m.type === 'done' && m.trapped)).toEqual([false, true]);
  });
});
