import type { AssemblyBuild } from '../types';
import { buildAssemblyGeometry, type AssemblyBuildInput } from '../geometry/assembly';
import { encodeInput, unpackBuild, type FromWorker, type ToWorker } from '../geometry/buildWire';
import { onCancelRequested, RebuildCancelled, throwIfCancelled } from '../cancel';
import { reportProgress } from '../progress';
import { replayWarnings } from '../warnings';

/** Thrown when the worker died mid-build; the message is the pill. */
export class BuildWorkerCrashed extends Error {
  constructor() {
    super(
      'The browser stopped partway through cutting the design, often from running out of ' +
        'memory. The 3D view still shows the last result, and export is off. Change any ' +
        'setting to try again.',
    );
    this.name = 'BuildWorkerCrashed';
  }
}

/**
 * A fault in the hand-off to the worker rather than in the design: the detail goes to the console,
 * and the pill says what happened in the user's terms.
 */
export class BuildWorkerFault extends Error {
  constructor() {
    super(
      "Couldn't cut the design because of a problem in the app, not your file. The 3D view still " +
        'shows the last result, and export is off. Reload the page to try again.',
    );
    this.name = 'BuildWorkerFault';
  }
}

function fault(detail: string): BuildWorkerFault {
  console.error('build worker:', detail);
  return new BuildWorkerFault();
}

/** The subset of Worker this module uses, so tests can hand in an in-process stand-in. */
export interface BuildWorkerLike {
  postMessage(msg: ToWorker): void;
  terminate(): void;
  addEventListener(type: 'message', fn: (e: MessageEvent<FromWorker>) => void): void;
  addEventListener(type: 'error' | 'messageerror', fn: (e: Event) => void): void;
}

/**
 * How long a cancelled worker may take to stop on its own before it is terminated. Stopping on its
 * own keeps its caches (the region pass's memo, the parts it holds), so a depth edit after a Cancel
 * mid-cut skips the region pass; terminating bounds what a long Manifold call burns in the background.
 */
const CANCEL_GRACE_MS = 1000;

const defaultFactory = (): BuildWorkerLike =>
  new Worker(new URL('../geometry/buildWorker.ts', import.meta.url), { type: 'module' });

let factory: (() => BuildWorkerLike) | null = typeof Worker === 'undefined' ? null : defaultFactory;
let worker: BuildWorkerLike | null = null;
/** Whether the current worker's code loaded: an error before that is a worker that never came up. */
let ready = false;
/** Ids of the inputs the current worker holds (buildWire.ts encodeInput). */
let held = new Set<number>();
let nextId = 1;
let pending: {
  id: number;
  input: AssemblyBuildInput;
  resolve: (b: AssemblyBuild | null) => void;
  reject: (e: unknown) => void;
} | null = null;
let windingDown: { id: number; timer: ReturnType<typeof setTimeout> } | null = null;
let lastReuse: { reused: string[]; cut: string[] } | null = null;

/**
 * Which parts the last finished build replayed from the worker's part cache and which it cut, by
 * name; null when it ran on the page. For driven checks (window.__mosaic.buildReuse).
 */
export function lastBuildReuse(): { reused: string[]; cut: string[] } | null {
  return lastReuse;
}

/** Tests swap in a stand-in; null runs every build on this thread, as under vitest. */
export function setBuildWorkerFactory(f: (() => BuildWorkerLike) | null): void {
  kill();
  factory = f;
}

function kill(): void {
  if (windingDown) clearTimeout(windingDown.timer);
  windingDown = null;
  worker?.terminate();
  worker = null;
  ready = false;
  held = new Set();
}

/**
 * The worker's code never loaded (a chunk missing after a deploy, a blocked script, no module
 * workers), which would fail every build the same way: build on the page for the rest of the
 * session instead. Slower to stay responsive, but nothing is lost, so it says nothing on screen.
 */
function neverCameUp(): void {
  const p = pending;
  pending = null;
  kill();
  factory = null;
  console.warn('build worker never loaded, building on the page');
  if (p) buildAssemblyGeometry(p.input).then(p.resolve, p.reject);
}

function died(): void {
  const p = pending;
  pending = null;
  kill();
  p?.reject(new BuildWorkerCrashed());
}

function onMessage(msg: FromWorker): void {
  if (msg.type === 'ready') {
    ready = true;
    return;
  }
  if (msg.type === 'unreadable') {
    // A bug in what crossed, not the user's design: fail loudly, and start clean next time.
    const p = pending;
    pending = null;
    kill();
    p?.reject(fault('a build message failed to deserialize in the worker'));
    return;
  }
  if (windingDown?.id === msg.id) {
    if (msg.type === 'progress') return;
    // It stopped (or finished) on its own; whatever it says is about a build already cancelled.
    clearTimeout(windingDown.timer);
    windingDown = null;
    if (msg.type === 'failed' || ('trapped' in msg && msg.trapped)) kill();
    return;
  }
  if (pending?.id !== msg.id) return;
  if (msg.type === 'progress') {
    reportProgress(msg.fraction);
    return;
  }
  const p = pending;
  pending = null;
  if (msg.type === 'done') {
    const names = (ix: number[]): string[] => ix.map((i) => p.input.parts[i].name);
    lastReuse = { reused: names(msg.reused), cut: names(msg.cut) };
    replayWarnings(msg.warnings);
    p.resolve(msg.build && unpackBuild(msg.build, p.input.parts));
  } else if (msg.type === 'failed') {
    replayWarnings(msg.warnings);
    p.reject(msg.wire ? fault(msg.message) : new Error(msg.message));
  } else p.reject(new RebuildCancelled());
  // An exception that escaped the build, or a trapped engine, leaves a heap nobody can vouch for.
  if (msg.type === 'failed' || msg.trapped) kill();
}

function spawn(): BuildWorkerLike {
  const w = factory!();
  w.addEventListener('message', (e) => {
    if (w === worker) onMessage(e.data);
  });
  const onError = (e: Event): void => {
    if (w !== worker) return;
    e.preventDefault();
    console.error('build worker failed', e);
    if (ready) died();
    else neverCameUp();
  };
  w.addEventListener('error', onError);
  w.addEventListener('messageerror', onError);
  return w;
}

/** The cancel button's path: answered here at once; the worker is told, and stopped if it lingers. */
function cancelPending(): void {
  const p = pending;
  if (!p) return;
  pending = null;
  worker?.postMessage({ type: 'cancel', id: p.id });
  windingDown = { id: p.id, timer: setTimeout(kill, CANCEL_GRACE_MS) };
  try {
    throwIfCancelled();
  } catch (e) {
    p.reject(e);
  }
}

/**
 * Run one assembly build off the page's thread, or on it where there is no Worker (vitest, node).
 * Resolves and rejects as `buildAssemblyGeometry` does, its warnings already on the page's list,
 * plus `BuildWorkerCrashed`. A cancel rejects at once with RebuildCancelled.
 */
export async function runAssemblyBuild(input: AssemblyBuildInput): Promise<AssemblyBuild | null> {
  lastReuse = null;
  if (!factory) return buildAssemblyGeometry(input);
  throwIfCancelled();
  // A cancelled build still unwinding would make this one queue behind it.
  if (windingDown) kill();
  if (!worker) {
    try {
      worker = spawn();
    } catch (e) {
      console.warn('build worker unavailable, building on the page', e);
      factory = null;
      return buildAssemblyGeometry(input);
    }
  }
  const w = worker;
  const id = nextId++;
  return new Promise<AssemblyBuild | null>((resolve, reject) => {
    pending = { id, input, resolve, reject };
    onCancelRequested(cancelPending);
    try {
      const search = typeof location === 'undefined' ? '' : location.search;
      w.postMessage({ type: 'build', id, search, input: encodeInput(input, held) });
    } catch (e) {
      // DataCloneError: something in the input can't cross. A bug, so it fails loudly.
      pending = null;
      kill();
      reject(e);
    }
  }).finally(() => onCancelRequested(null));
}
