import type { AssemblyBuild, AssemblyPart, AssemblyPartOutput, ParsedSVG } from '../types';
import type { WarningCall } from '../warnings';
import type { ArtworkBuildInput, AssemblyBuildInput } from './assembly';

/**
 * An object sent once and named by id after. Identity is what the worker's caches key on (the
 * regions memo on `shapes`), and a structured clone is a new object every time, so the receiver
 * keeps one copy per id. Sound only because these objects are replaced, never edited in place:
 * ParsedSVG says so, and every AssemblyPart field holding an object is reassigned on change.
 */
export interface Ref {
  ref: number;
  value?: unknown;
}

type WirePart = { scalars: Record<string, unknown>; refs: Record<string, Ref> };
type WireArtwork = Omit<ArtworkBuildInput, 'parsed'> & { parsed: Ref };

export interface WireInput {
  rest: Omit<AssemblyBuildInput, 'artworks' | 'parts'>;
  artworks: WireArtwork[];
  parts: WirePart[];
}

type WireOutput = Omit<AssemblyPartOutput, 'part'> & { partIndex: number };
export type WireBuild = Omit<AssemblyBuild, 'partOutputs'> & { partOutputs: WireOutput[] };

export type ToWorker =
  { type: 'build'; id: number; search: string; input: WireInput } | { type: 'cancel'; id: number };

export type FromWorker =
  | { type: 'progress'; id: number; fraction: number }
  | { type: 'done'; id: number; build: WireBuild | null; warnings: WarningCall[] }
  | { type: 'cancelled'; id: number }
  | { type: 'failed'; id: number; message: string; warnings: WarningCall[] };

const ids = new WeakMap<object, number>();
let nextId = 1;

/**
 * The page's side. `held` is what the current worker already has, and is rewritten to exactly this
 * request's ids: the worker drops the rest on receipt, so both sides forget the same objects.
 */
export function encodeInput(input: AssemblyBuildInput, held: Set<number>): WireInput {
  const live = new Set<number>();
  const ref = (obj: object): Ref => {
    let id = ids.get(obj);
    if (id === undefined) ids.set(obj, (id = nextId++));
    const first = !held.has(id) && !live.has(id);
    live.add(id);
    return first ? { ref: id, value: obj } : { ref: id };
  };
  const { artworks, parts, ...rest } = input;
  const wire: WireInput = {
    rest,
    artworks: artworks.map((a) => ({ ...a, parsed: ref(a.parsed) })),
    parts: parts.map((p) => {
      const scalars: Record<string, unknown> = {};
      const refs: Record<string, Ref> = {};
      for (const [k, v] of Object.entries(p))
        if (v !== null && typeof v === 'object') refs[k] = ref(v as object);
        else scalars[k] = v;
      return { scalars, refs };
    }),
  };
  held.clear();
  for (const id of live) held.add(id);
  return wire;
}

/** The worker's side of `encodeInput`; `cache` is pruned to this request's ids, as `held` was. */
export function decodeInput(wire: WireInput, cache: Map<number, unknown>): AssemblyBuildInput {
  const all: Ref[] = [
    ...wire.artworks.map((a) => a.parsed),
    ...wire.parts.flatMap((p) => Object.values(p.refs)),
  ];
  for (const r of all) if ('value' in r) cache.set(r.ref, r.value);
  const live = new Set(all.map((r) => r.ref));
  for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
  const get = (r: Ref): unknown => {
    if (!cache.has(r.ref)) throw new Error(`build input ${r.ref} was never sent`);
    return cache.get(r.ref);
  };
  return {
    ...wire.rest,
    artworks: wire.artworks.map((a) => ({ ...a, parsed: get(a.parsed) as ParsedSVG })),
    parts: wire.parts.map(
      (p) =>
        ({
          ...p.scalars,
          ...Object.fromEntries(Object.entries(p.refs).map(([k, r]) => [k, get(r)])),
        }) as unknown as AssemblyPart,
    ),
  };
}

/** Every buffer an output owns, for the transfer list: moved, not copied, back to the page. */
function outputBuffers(o: AssemblyPartOutput): ArrayBufferLike[] {
  const arrays: ArrayBufferView[] = [o.bodySoup, ...Object.values(o.inlaySoups)];
  for (const m of [o.bodyIndexed, ...Object.values(o.inlayIndexed ?? {})])
    if (m) arrays.push(m.positions, m.indices);
  return arrays.map((a) => a.buffer);
}

/**
 * Outputs name their part by index into the request's `parts`, so the page reattaches its own
 * objects. `keep` is what the worker still holds as input: transferring it would detach the cached
 * copy, so it is cloned instead.
 */
export function packBuild(
  build: AssemblyBuild,
  parts: AssemblyPart[],
  keep: ReadonlySet<ArrayBufferLike>,
): { wire: WireBuild; transfer: ArrayBuffer[] } {
  const transfer = new Set<ArrayBuffer>();
  const partOutputs = build.partOutputs.map(({ part, ...rest }) => {
    const partIndex = parts.indexOf(part);
    if (partIndex < 0) throw new Error(`output for "${part.name}" names no input part`);
    for (const b of outputBuffers({ part, ...rest }))
      if (!keep.has(b) && b instanceof ArrayBuffer) transfer.add(b);
    return { ...rest, partIndex };
  });
  return { wire: { ...build, partOutputs }, transfer: [...transfer] };
}

export function unpackBuild(wire: WireBuild, parts: AssemblyPart[]): AssemblyBuild {
  return {
    ...wire,
    partOutputs: wire.partOutputs.map(({ partIndex, ...rest }) => ({
      part: parts[partIndex],
      ...rest,
    })),
  };
}

/** What an output could alias: a part's own meshes, which a fallback body might hand back as-is. */
export function partBuffers(parts: AssemblyPart[]): Set<ArrayBufferLike> {
  const out = new Set<ArrayBufferLike>();
  for (const p of parts)
    for (const v of [...(Object.values(p) as unknown[]), p.indexed?.positions, p.indexed?.indices])
      if (ArrayBuffer.isView(v)) out.add(v.buffer);
  return out;
}
