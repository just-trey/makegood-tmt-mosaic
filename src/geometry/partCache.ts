import type { AssemblyPart, AssemblyPartOutput, PolyFeature } from '../types';
import { journalLength, journalSince, replayWarnings, type WarningCall } from '../warnings';
import {
  mergePartTally,
  newPartTally,
  type BuildContext,
  type BuildTally,
  type CrossPartState,
  type PartTally,
  type TornPill,
} from './buildContext';
import { BUILD_PART_FIELDS } from './buildWire';
import { csgFaultArmed } from './csgFault';
import { requestedDepth } from './depth';
import { engineTrapCount } from './manifold';
import { artworksOnZone } from './partBuild';
import type { ZoneMapper } from './zones';

export interface PartResult {
  output: AssemblyPartOutput | null;
  placed: boolean;
}

interface Entry {
  key: string;
  /** Each cross-part key the part touched, as it found it; a replay needs the same. */
  before: CrossTouch;
  /** The same keys as the part left them. */
  after: CrossTouch;
  warnings: WarningCall[];
  tally: PartTally;
  /**
   * Copied in and out: the worker moves a build's meshes to the page, detaching them here, and a
   * copy made here keeps the page's side a move rather than a copy on the page's thread.
   */
  output: Omit<AssemblyPartOutput, 'part'> | null;
  placed: boolean;
}

interface CrossTouch {
  torn: Map<string, TornPill | undefined>;
  overlap: Map<string, boolean>;
}

/** An object keyed by identity: sound for the reason buildWire.ts gives on `Ref`. */
class Ident {
  constructor(readonly id: number) {}
}
const ids = new WeakMap<object, number>();
let nextId = 1;
function ident(o: object): Ident {
  let id = ids.get(o);
  if (id === undefined) ids.set(o, (id = nextId++));
  return new Ident(id);
}

/**
 * A canonical string for plain data. Numbers by `String` plus a -0 mark, not JSON: JSON writes NaN
 * and both infinities as `null`, so a depth of NaN and one of Infinity would share a key.
 */
function keyOf(v: unknown): string {
  if (v instanceof Ident) return `#${v.id}`;
  if (typeof v === 'number') return Object.is(v, -0) ? 'n-0' : `n${v}`;
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 't' : 'f';
  if (v === null) return 'N';
  if (v === undefined) return 'U';
  if (ArrayBuffer.isView(v)) return keyOf(ident(v));
  if (Array.isArray(v)) return `[${v.map(keyOf).join(',')}]`;
  if (typeof v === 'object') {
    const proto: unknown = Object.getPrototypeOf(v);
    // A Map has no own keys, so two different ones would both read as `{}`.
    if (proto !== Object.prototype && proto !== null) return keyOf(ident(v));
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${keyOf((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return typeof v === 'function' ? keyOf(ident(v)) : `?${String(v)}`;
}

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

/**
 * Two murmur3 lanes over every coordinate's bits and every array's length: 64 bits, where a
 * collision would hand a part the previous build's ink. Hashed, not held: a key can't pin geometry.
 */
function featureHash(f: PolyFeature | null): string {
  if (!f) return 'none';
  let h1 = 0x9747b28c;
  let h2 = 0x3c6ef372;
  let n = 0;
  const mix = (w: number): void => {
    n++;
    let k = Math.imul(w, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h1 ^= k;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = (Math.imul(h1, 5) + 0xe6546b64) | 0;
    let j = Math.imul(w ^ n, 0x85ebca6b);
    j = (j << 17) | (j >>> 15);
    j = Math.imul(j, 0xc2b2ae35);
    h2 ^= j;
    h2 = (h2 << 11) | (h2 >>> 21);
    h2 = (Math.imul(h2, 9) + 0x52dce729) | 0;
  };
  const walk = (a: unknown): void => {
    if (typeof a === 'number') {
      f64[0] = a;
      mix(u32[0]);
      mix(u32[1]);
    } else if (Array.isArray(a)) {
      mix(0x5b5b0000 ^ a.length);
      for (const x of a) walk(x);
    } else mix(a === null ? 0x4e4e4e4e : 0x3f3f3f3f);
  };
  const fmix = (h: number): number => {
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
  };
  walk(f.geometry.coordinates);
  return `${f.geometry.type}:${n}:${fmix(h1 ^ n).toString(16)}:${fmix(h2 ^ n).toString(16)}:${keyOf(f.properties ?? null)}`;
}

function partFields(part: AssemblyPart): string {
  return keyOf(
    BUILD_PART_FIELDS.map((k) => {
      const v: unknown = part[k];
      return [k, v !== null && typeof v === 'object' ? ident(v) : v];
    }),
  );
}

/**
 * Builds each part's key for one build: everything `buildPart` reads, from `ctx` by value and from
 * the part by identity. Per artwork it is only those landing on the part's zones, which is what
 * lets an edit to one zone's design leave the other parts' keys alone.
 */
export function partKeyer(
  ctx: BuildContext,
  parts: AssemblyPart[],
  isRect: boolean,
): (part: AssemblyPart, mappers: ZoneMapper[]) => string {
  const { artworks, palette } = ctx;
  const shared = keyOf({
    isRect,
    palette,
    // The only read of colorSettings and globalDepth below the build loop (colorPrism.ts).
    depths: palette.map((c) => requestedDepth(ctx.colorSettings, ctx.globalDepth, c.key)),
  });
  const designs = new Map<number, string>();
  const design = (ai: number): string => {
    let k = designs.get(ai);
    if (k !== undefined) return k;
    const { parsed, ...fields } = artworks[ai];
    k = keyOf({
      parsed: ident(parsed),
      fields,
      // A content hash, not an input list: these are derived from every artwork and the merge
      // settings, and a derivation added later can't then miss the key.
      features: ctx.featuresByColor.map((perArtwork) => featureHash(perArtwork[ai])),
      placement: ctx.placements[ai],
      maxScale: artworks[ai].mode === 'fill' ? ctx.maxScalePlacement(ai) : null,
      tileCell: ctx.tileCells[ai],
      tileVerts: ctx.tileVerts[ai],
    });
    designs.set(ai, k);
    return k;
  };
  return (part, mappers) => {
    const on = [...new Set(mappers.flatMap((m) => artworksOnZone(artworks, m.zoneId)))].sort(
      (a, b) => a - b,
    );
    // A rotated copy's flat mapper reads its source's face normal (asmPartFaceNormal).
    const source =
      part.isDuplicateOf != null ? parts.find((p) => p.id === part.isDuplicateOf) : undefined;
    return [
      shared,
      partFields(part),
      source ? partFields(source) : 'N',
      keyOf(mappers.map((m) => m.zoneId)),
      on.map(design).join('|'),
    ].join('\n');
  };
}

/**
 * `cross` as the part sees it, logging each key's value at the part's first touch of it: the part
 * can observe nothing else of the state the parts before it left.
 */
function logged(cross: CrossPartState, before: CrossTouch): CrossPartState {
  const torn = (k: string): void => {
    if (!before.torn.has(k)) before.torn.set(k, copyPill(cross.tornPills.get(k)));
  };
  const zone = (z: string): void => {
    if (!before.overlap.has(z)) before.overlap.set(z, cross.overlapCheckedZones.has(z));
  };
  return {
    tornPills: {
      get: (k) => (torn(k), cross.tornPills.get(k)),
      set: (k, v) => (torn(k), cross.tornPills.set(k, v)),
    },
    overlapCheckedZones: {
      has: (z) => (zone(z), cross.overlapCheckedZones.has(z)),
      add: (z) => (zone(z), cross.overlapCheckedZones.add(z)),
    },
  };
}

const copyPill = (p: TornPill | undefined): TornPill | undefined => p && { ...p };

/** The touched keys of `cross` as they stand now. */
function current(cross: CrossPartState, keys: CrossTouch): CrossTouch {
  return {
    torn: new Map([...keys.torn.keys()].map((k) => [k, copyPill(cross.tornPills.get(k))])),
    overlap: new Map([...keys.overlap.keys()].map((z) => [z, cross.overlapCheckedZones.has(z)])),
  };
}

const sameTouch = (a: CrossTouch, b: CrossTouch): boolean =>
  keyOf([[...a.torn], [...a.overlap]]) === keyOf([[...b.torn], [...b.overlap]]);

/**
 * One part's last result, per part, kept by the build worker between builds, so a part whose
 * inputs didn't change is replayed instead of cut. A replay reproduces everything the cut did
 * besides its output: the warning calls in order, its tally, and the cross-part state after it.
 */
export class PartCache {
  private entries = new Map<number, Entry>();
  /** Indices into the latest build's `parts`, for the page's live check (main.ts buildReuse). */
  reused: number[] = [];
  cut: number[] = [];

  begin(parts: AssemblyPart[]): void {
    const live = new Set(parts.map((p) => p.id));
    for (const id of this.entries.keys()) if (!live.has(id)) this.entries.delete(id);
    this.reused = [];
    this.cut = [];
  }

  /**
   * Replay the part if its key and every cross-part key it touched match what it was cut against;
   * otherwise cut it with `build` and store the result. Not stored: a part cut while the engine
   * trapped, whose heap nobody can vouch for, or while ?csgfault is armed, where which part fails
   * depends on every part before it. An engine exception is stored: it unwinds cleanly, and the
   * repair ladder (colorPrism.ts) meets one on ordinary artwork, so refusing it re-cut parts forever.
   */
  async run(
    index: number,
    part: AssemblyPart,
    key: string,
    cross: CrossPartState,
    tally: PartTally,
    build: (tally: BuildTally) => Promise<PartResult>,
  ): Promise<PartResult> {
    if (csgFaultArmed()) {
      this.cut.push(index);
      return (await cutPart(cross, tally, build)).result;
    }
    const hit = this.entries.get(part.id);
    if (hit && hit.key === key && sameTouch(current(cross, hit.before), hit.before)) {
      replayWarnings(hit.warnings);
      mergePartTally(tally, hit.tally);
      // A part only sets a pill and only adds a zone, so what it left is written back as such.
      for (const [k, v] of hit.after.torn) if (v) cross.tornPills.set(k, { ...v });
      for (const [z, on] of hit.after.overlap) if (on) cross.overlapCheckedZones.add(z);
      this.reused.push(index);
      return { output: hit.output && { ...structuredClone(hit.output), part }, placed: hit.placed };
    }
    this.entries.delete(part.id);
    const from = journalLength();
    const traps = engineTrapCount();
    const before: CrossTouch = { torn: new Map(), overlap: new Map() };
    const { result, own } = await cutPart(logged(cross, before), tally, build);
    this.cut.push(index);
    if (from !== null && engineTrapCount() === traps)
      this.entries.set(part.id, {
        key,
        before,
        after: current(cross, before),
        warnings: journalSince(from),
        tally: own,
        output: result.output && structuredClone(withoutPart(result.output)),
        placed: result.placed,
      });
    return result;
  }
}

function withoutPart({ part, ...rest }: AssemblyPartOutput): Omit<AssemblyPartOutput, 'part'> {
  void part;
  return rest;
}

/** One part cut fresh, its facts folded into the build's; `own` is what it added. */
export async function cutPart(
  cross: CrossPartState,
  tally: PartTally,
  build: (tally: BuildTally) => Promise<PartResult>,
): Promise<{ result: PartResult; own: PartTally }> {
  const own = newPartTally();
  const result = await build({ ...cross, ...own });
  mergePartTally(tally, own);
  return { result, own };
}
