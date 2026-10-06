import type { Loop, Pt } from '../types';
import { BACKGROUND } from './types';
import type { LabelMap, TraceParams } from './types';
import { fitChain } from './curve';
import { fracFloorPx } from './stats';

/**
 * Ceiling on traced components. Exceeding it raises the despeckle floor and re-runs rather than
 * hand the region pipeline a shape count it will choke on (see `shapeToFeature` in
 * src/geometry/regions.ts). A component cap, not a point cap: components drive ring count, which
 * `shapeToFeature` is quadratic in. Raising it means re-running scripts/bench-raster.ts and
 * scripts/bench-shape-to-feature.ts.
 */
export const MAX_COMPONENTS = 800;

/** One connected run of a single quantized color: its outer ring plus any rings enclosed by it. */
export interface TracedComponent {
  label: number;
  loops: Loop[];
  area: number;
}

export interface TraceResult {
  components: TracedComponent[];
  /** Times MAX_COMPONENTS forced the despeckle floor up. Any at all is the caller's capped notice. */
  raises: number;
  /** The floor in pixels this trace actually applied — the raised one after any raise. */
  floorPx: number;
  /** The grid actually traced, after every despeckle and checker break. Background included, so a check on it sees what `components` leaves out. */
  labels: Int16Array;
}

const E = 0,
  S = 1,
  W = 2,
  N = 3;

/** Clockwise on screen (y down), which is the turn that keeps a traversal hugging its own region. */
const right = (d: number) => (d + 1) & 3;
const left = (d: number) => (d + 3) & 3;

/**
 * Crack id for the lattice edge between two adjacent nodes, in the crack arrays' indexing (vertical
 * first, then horizontal). The chain builder and ring walk must agree exactly: the shared id is how
 * a ring finds the chain whose fitted points it splices in.
 */
function crackIndexer(stride: number, w: number, vCount: number) {
  return (a: number, b: number): number => {
    if (b === a + stride) return a;
    if (b === a - stride) return b;
    const y = (a / stride) | 0;
    const x = a % stride;
    return b === a + 1 ? vCount + y * w + x : vCount + y * w + x - 1;
  };
}

/** 4-connected components of equal label, background included (a transparent speck is no more printable than a colored one). Returns a component id per pixel and each component's area. */
export function labelComponents(
  labels: Int16Array,
  w: number,
  h: number,
): { compId: Int32Array; areas: number[]; labelOf: number[] } {
  const compId = new Int32Array(w * h).fill(-1);
  const areas: number[] = [];
  const labelOf: number[] = [];
  const stack: number[] = [];
  for (let seed = 0; seed < compId.length; seed++) {
    if (compId[seed] >= 0) continue;
    const id = areas.length;
    const label = labels[seed];
    areas.push(0);
    labelOf.push(label);
    compId[seed] = id;
    stack.push(seed);
    while (stack.length) {
      const p = stack.pop() as number;
      areas[id]++;
      const x = p % w,
        y = (p / w) | 0;
      if (x > 0 && compId[p - 1] < 0 && labels[p - 1] === label) {
        compId[p - 1] = id;
        stack.push(p - 1);
      }
      if (x + 1 < w && compId[p + 1] < 0 && labels[p + 1] === label) {
        compId[p + 1] = id;
        stack.push(p + 1);
      }
      if (y > 0 && compId[p - w] < 0 && labels[p - w] === label) {
        compId[p - w] = id;
        stack.push(p - w);
      }
      if (y + 1 < h && compId[p + w] < 0 && labels[p + w] === label) {
        compId[p + w] = id;
        stack.push(p + w);
      }
    }
  }
  return { compId, areas, labelOf };
}

/**
 * Absorb every component below `minArea` into the label that surrounds it most, smallest first.
 *
 * Dominant *neighbour*, not background: dropping a mid-face speck to background would punch a hole.
 * Unions over one component labelling, never simultaneous relabelling, which let two adjacent specks
 * trade labels instead of merging and left most of an image under the floor it had just applied
 * (docs/findings/2026-08-20-despeckle-floor.md).
 *
 * Nothing is left under the floor: a speck always has a neighbour unless it is the whole image.
 * `checkerFree` skips a label that would make an A,B/B,A, and leaves a speck that every label would.
 */
function despeckle(
  labels: Int16Array,
  w: number,
  h: number,
  minArea: number,
  checkerFree = false,
): void {
  if (minArea <= 1) return;
  const { compId, areas, labelOf } = labelComponents(labels, w, h);
  const under = (i: number) => areas[i] < minArea;
  // Before allocating anything: with no speck this is the whole call, and the adjacency scan below costs 20ms on a 1024px image to find that out.
  if (areas.length < 2 || !areas.some((_, i) => under(i))) return;

  // Shared boundary length per pair, only for pairs with a speck on one side — tallying the rest on a 1024px image is a million map writes for nothing.
  const adj: Map<number, number>[] = areas.map(() => new Map<number, number>());
  const touch = (p: number, q: number) => {
    const a = compId[p],
      b = compId[q];
    if (a === b || (!under(a) && !under(b))) return;
    adj[a].set(b, (adj[a].get(b) ?? 0) + 1);
    adj[b].set(a, (adj[b].get(a) ?? 0) + 1);
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (x + 1 < w) touch(p, p + 1);
      if (y + 1 < h) touch(p, p + w);
    }

  // Only a speck's pixels are ever relabelled, so only a speck's are listed; a merge with anything at or over the floor drops the list.
  const pixels: (number[] | null)[] = areas.map((_, i) => (checkerFree && under(i) ? [] : null));
  if (checkerFree) for (let p = 0; p < compId.length; p++) pixels[compId[p]]?.push(p);

  const parent = new Int32Array(areas.length).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const merge = (a: number, b: number): number => {
    a = find(a);
    b = find(b);
    if (a === b) return a;
    // The larger neighbour set absorbs the smaller, keeping splicing near-linear rather than quadratic on a long merge chain.
    if (adj[a].size < adj[b].size) [a, b] = [b, a];
    parent[b] = a;
    areas[a] += areas[b];
    const into = pixels[a],
      from = pixels[b];
    pixels[a] = into && from ? into.concat(from) : null;
    for (const [nb, shared] of adj[b])
      if (find(nb) !== a) adj[a].set(nb, (adj[a].get(nb) ?? 0) + shared);
    adj[b].clear();
    return a;
  };

  // Whether relabelling `comp` to `label` leaves a 2x2 with the same label on one diagonal and another on the other. Only a block holding one of its pixels can change, and only by that pixel taking `label`.
  const at = (q: number, comp: number, label: number) => {
    const root = find(compId[q]);
    return root === comp ? label : labelOf[root];
  };
  const makesChecker = (comp: number, label: number): boolean => {
    for (const p of pixels[comp] ?? []) {
      const x = p % w,
        y = (p / w) | 0;
      for (const dx of [-1, 1])
        for (const dy of [-1, 1]) {
          if (x + dx < 0 || x + dx >= w || y + dy < 0 || y + dy >= h) continue;
          const across = at(p + dx, comp, label);
          if (across !== label && across === at(p + dy * w, comp, label))
            if (at(p + dy * w + dx, comp, label) === label) return true;
        }
    }
    return false;
  };

  // Smallest first, so a speck asks which label dominates only after its smaller neighbours joined something. Re-queued if a merge leaves it too small.
  const queue = areas
    .map((_, i) => i)
    .filter(under)
    .sort((a, b) => areas[a] - areas[b]);
  for (let at = 0; at < queue.length; at++) {
    const comp = find(queue[at]);
    if (comp !== queue[at] || !under(comp)) continue;
    const byLabel = new Map<number, number>();
    for (const [nb, shared] of adj[comp]) {
      const root = find(nb);
      if (root === comp) continue;
      byLabel.set(labelOf[root], (byLabel.get(labelOf[root]) ?? 0) + shared);
    }
    // A speck every label would checker stays under the floor. Recolouring the checker's smallest component instead has no bound on how big a shape it recolours.
    if (checkerFree)
      for (const label of [...byLabel.keys()]) if (makesChecker(comp, label)) byLabel.delete(label);
    let best = -1,
      bestN = -1;
    for (const [label, shared] of byLabel)
      if (shared > bestN || (shared === bestN && label < best)) {
        bestN = shared;
        best = label;
      }
    if (bestN <= 0) continue;
    let root = comp;
    // Every neighbour of the winning label, not one: taking that label connects them all into one component.
    for (const nb of [...adj[comp].keys()]) if (labelOf[find(nb)] === best) root = merge(root, nb);
    labelOf[root] = best;
    if (under(root)) queue.push(root);
  }

  for (let p = 0; p < labels.length; p++) labels[p] = labelOf[find(compId[p])];
}

/**
 * Rewrite one cell of the A,B/B,A whose top-left is `i`: the bottom-right one, or the bottom-left
 * when that strands a piece under the floor no label can take without making another. Never the top
 * two: either can remake an A,B/B,A the scan has passed. See docs/tech-debt.md for what still stays.
 */
function breakChecker(labels: Int16Array, w: number, h: number, minArea: number, i: number): void {
  const checkerAt = (q: number) => {
    const a = labels[q],
      b = labels[q + 1];
    return a !== b && a === labels[q + w + 1] && b === labels[q + w];
  };
  // Top-left corner of every 2x2 holding `p`.
  const blocksOf = (p: number): number[] => {
    const x = p % w,
      y = (p / w) | 0,
      out: number[] = [];
    for (let by = Math.max(0, y - 1); by <= Math.min(y, h - 2); by++)
      for (let bx = Math.max(0, x - 1); bx <= Math.min(x, w - 2); bx++) out.push(by * w + bx);
    return out;
  };
  const neighbours = (p: number): number[] => {
    const x = p % w,
      out: number[] = [];
    if (x > 0) out.push(p - 1);
    if (x + 1 < w) out.push(p + 1);
    if (p >= w) out.push(p - w);
    if (p + w < labels.length) out.push(p + w);
    return out;
  };
  // The piece of its label `from` sits in, or the first `minArea` pixels of it: the floor is all that is asked.
  const piece = (from: number): number[] => {
    const label = labels[from],
      seen = new Set([from]),
      stack = [from];
    while (stack.length && seen.size < minArea)
      for (const q of neighbours(stack.pop() as number))
        if (labels[q] === label && !seen.has(q)) {
          seen.add(q);
          stack.push(q);
        }
    return [...seen];
  };
  // Whether some label can take `cells` with no A,B/B,A around them. Stricter than the checker-free despeckle after this, which sees none left anywhere.
  const takeable = (cells: number[]): boolean => {
    const was = labels[cells[0]];
    const blocks = [...new Set(cells.flatMap(blocksOf))];
    const options = new Set(cells.flatMap(neighbours).map((q) => labels[q]));
    options.delete(was);
    for (const option of options) {
      for (const p of cells) labels[p] = option;
      const ok = !blocks.some(checkerAt);
      for (const p of cells) labels[p] = was;
      if (ok) return true;
    }
    return false;
  };
  // With `p` already rewritten from `was`: whether that left a piece of `was` under the floor that no label can take.
  const stuck = (p: number, was: number): boolean =>
    neighbours(p).some((q) => {
      if (labels[q] !== was) return false;
      const cells = piece(q);
      return cells.length < minArea && !takeable(cells);
    });

  const a = labels[i],
    b = labels[i + 1];
  labels[i + w + 1] = b;
  if (!stuck(i + w + 1, a)) return;
  labels[i + w + 1] = a;
  // Safe for the scan: the one passed block holding this cell is left one label down its right column.
  labels[i + w] = a;
}

/**
 * Break every 2x2 that reads A,B / B,A. Such a block puts four cracks on one lattice point with two
 * labels, and no non-arbitrary pairing exists — either choice is a self-touching ring or a
 * zero-area overlap. Removing it is cheaper than a tie-break and leaves no node above degree 3 that
 * isn't a genuine meeting of distinct regions. One scan suffices: `breakChecker` only writes a
 * bottom cell, which every later block reads.
 */
function deChecker(labels: Int16Array, w: number, h: number, minArea: number): boolean {
  let changed = false;
  for (let y = 0; y + 1 < h; y++) {
    for (let x = 0; x + 1 < w; x++) {
      const i = y * w + x;
      const a = labels[i],
        b = labels[i + 1],
        c = labels[i + w],
        d = labels[i + w + 1];
      if (a === d && b === c && a !== b) {
        breakChecker(labels, w, h, minArea, i);
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * `despeckle`, then `deChecker`, then absorb whatever the checker break split or shaved under the
 * floor. Not the other order: `despeckle` relabels whole components and can make the very A,B/B,A
 * `deChecker` exists to remove, which is why the last pass may only take a checker-free label.
 */
function clean(labels: Int16Array, w: number, h: number, minArea: number): void {
  despeckle(labels, w, h, minArea);
  if (deChecker(labels, w, h, minArea)) despeckle(labels, w, h, minArea, true);
}

/** One maximal run of cracks between two junctions, or a whole junction-free island boundary. */
interface Chain {
  nodes: number[];
  /** The sub-pixel polyline `curve.ts` fitted to `nodes`, in the same direction. */
  fitted: Pt[];
  closed: boolean;
  /** Position of each node within `nodes` — closed chains only, to tell which way a ring traverses them. Open chains compare against nodes[0]. */
  index: Map<number, number> | null;
}

interface ChainSet {
  chains: Chain[];
  /** Crack id -> index into `chains`. How a ring walk finds the chain it is currently on. */
  chainOf: Int32Array;
}

/** One component's assembled rings, plus every chain they were spliced from. */
interface RingSet {
  loops: Loop[];
  chains: number[];
}

/**
 * Share of its pixel area a component must still enclose after fitting, or its chains are unfitted.
 * Matches curve.ts's guard for closed chains: rounding a corner costs a few percent, the failure
 * this catches costs everything.
 */
const MIN_COMPONENT_AREA_RATIO = 0.85;

function loopArea(loop: Loop): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i];
    const q = loop[(i + 1) % loop.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/**
 * Drop back to lattice points on any chain that helped a component lose its area, and report
 * whether anything changed so the caller can reassemble.
 *
 * curve.ts guards a *closed* chain by its own enclosed area; an open chain has none, so the same
 * failure goes uncaught there and is not hypothetical: a one-pixel stroke between two other colours
 * is bounded by open chains that each turn a corner around it, the cone's half-pixel slack
 * swallows the excursion, both fit to chords, and the region vanishes with no warning (measured at
 * every length tried).
 *
 * The check is per component (the smallest thing with an area); the *fix* is per chain, because a
 * chain is shared. Unfitting one keeps both sides of that boundary identical — if only the starved
 * component fell back it would disagree with its neighbour and open the sliver this design prevents.
 */
function unfitCollapsedChains(
  rings: Map<number, RingSet>,
  chainSet: ChainSet,
  areas: number[],
  labelOf: number[],
  stride: number,
): boolean {
  const suspect = new Set<number>();
  for (const [comp, entry] of rings) {
    if (labelOf[comp] === BACKGROUND) continue;
    const fitted = Math.abs(entry.loops.reduce((s, loop) => s + loopArea(loop), 0));
    if (fitted >= areas[comp] * MIN_COMPONENT_AREA_RATIO) continue;
    for (const id of entry.chains) suspect.add(id);
  }
  if (!suspect.size) return false;

  let changed = false;
  for (const id of suspect) {
    const chain = chainSet.chains[id];
    const lattice = chain.nodes.map((n) => ({ x: n % stride, y: (n / stride) | 0 }));
    const body = chain.closed ? lattice.slice(0, -1) : lattice;
    if (chain.fitted.length === body.length) continue;
    chain.fitted = body;
    changed = true;
  }
  return changed;
}

/**
 * Cut the crack graph into chains and fit a sub-pixel curve to each, once and globally.
 *
 * The reason the crack graph exists: every boundary between two regions is one chain shared by both,
 * and fitting each region's rings independently would pull it two ways, leaving a sliver of bare
 * part surface along every colour boundary. Fitting once and splicing identical points into both
 * keeps the sides bit-identical.
 *
 * What it does *not* buy: a region never crossing one it shares no chain with. Nothing bounds how
 * far a fitted chain strays from its lattice path, so it can sweep over a third region a pixel away
 * — measured up to one working pixel of overlap. The bound, why it can't be tightened and what
 * absorbs it downstream are on the "keeps any overlap between components down to a sliver" test in
 * tests/raster-trace.test.ts.
 */
function buildChains(labels: Int16Array, w: number, h: number, params: TraceParams): ChainSet {
  const stride = w + 1;
  const nodeCount = stride * (h + 1);
  const labelAt = (x: number, y: number) =>
    x < 0 || y < 0 || x >= w || y >= h ? BACKGROUND : labels[y * w + x];
  // A crack is a unit edge between two differently-labelled pixels. Vertical cracks are indexed first, then horizontal.
  const vCount = stride * h;
  const crackBetween = crackIndexer(stride, w, vCount);

  // Crack existence and node degree are precomputed: the walks hit them once per step over the whole lattice, and recomputing from `labels` made tracing the dominant cost of loading an image (scripts/bench-raster.ts).
  const vCrack = new Uint8Array(vCount);
  for (let y = 0; y < h; y++)
    for (let x = 0; x <= w; x++)
      vCrack[y * stride + x] = labelAt(x - 1, y) !== labelAt(x, y) ? 1 : 0;
  const hCrack = new Uint8Array(w * (h + 1));
  for (let y = 0; y <= h; y++)
    for (let x = 0; x < w; x++) hCrack[y * w + x] = labelAt(x, y - 1) !== labelAt(x, y) ? 1 : 0;

  // Neighbours of a lattice node along the four directions, written as [nodeId, crackId] pairs into a scratch buffer to stay allocation-free in inner loops.
  const nbBuf = new Int32Array(8);
  const neighbours = (n: number): number => {
    const x = n % stride,
      y = (n / stride) | 0;
    let k = 0;
    if (y > 0 && vCrack[(y - 1) * stride + x]) {
      nbBuf[k++] = n - stride;
      nbBuf[k++] = (y - 1) * stride + x;
    }
    if (y < h && vCrack[y * stride + x]) {
      nbBuf[k++] = n + stride;
      nbBuf[k++] = y * stride + x;
    }
    if (x > 0 && hCrack[y * w + (x - 1)]) {
      nbBuf[k++] = n - 1;
      nbBuf[k++] = vCount + y * w + (x - 1);
    }
    if (x < w && hCrack[y * w + x]) {
      nbBuf[k++] = n + 1;
      nbBuf[k++] = vCount + y * w + x;
    }
    return k >> 1;
  };

  const crackCount = vCount + w * (h + 1);
  const degrees = new Uint8Array(nodeCount);
  const visited = new Uint8Array(crackCount);
  const junctions: number[] = [];
  for (let n = 0; n < nodeCount; n++) {
    const d = (degrees[n] = neighbours(n));
    if (d && d !== 2) junctions.push(n);
  }

  const walk = (start: number, firstNode: number, firstCrack: number): number[] => {
    const chain = [start];
    let node = firstNode;
    visited[firstCrack] = 1;
    chain.push(node);
    while (degrees[node] === 2) {
      const count = neighbours(node);
      let nextNode = -1,
        nextCrack = -1;
      for (let i = 0; i < count; i++)
        if (!visited[nbBuf[i * 2 + 1]]) {
          nextNode = nbBuf[i * 2];
          nextCrack = nbBuf[i * 2 + 1];
          break;
        }
      if (nextNode < 0) break;
      visited[nextCrack] = 1;
      node = nextNode;
      chain.push(node);
    }
    return chain;
  };

  const chains: Chain[] = [];
  const chainOf = new Int32Array(crackCount).fill(-1);

  const register = (nodes: number[], closed: boolean): void => {
    const id = chains.length;
    for (let i = 1; i < nodes.length; i++) chainOf[crackBetween(nodes[i - 1], nodes[i])] = id;
    const pts: Pt[] = nodes.map((n) => ({ x: n % stride, y: (n / stride) | 0 }));
    // A closed walk returns to its start, so the node list has the first node twice; the fit wants the cycle without the repeat.
    const body = closed ? pts.slice(0, -1) : pts;
    chains.push({
      nodes,
      fitted: fitChain(body, closed, params),
      closed,
      index: closed ? new Map(nodes.slice(0, -1).map((n, i) => [n, i])) : null,
    });
  };

  for (const j of junctions) {
    const count = neighbours(j);
    const pairs = Array.from({ length: count }, (_, i) => [nbBuf[i * 2], nbBuf[i * 2 + 1]]);
    for (const [node, crack] of pairs) {
      if (visited[crack]) continue;
      register(walk(j, node, crack), false);
    }
  }

  // What's left is a closed chain with no junction — an island's boundary in a uniform field. Every
  // unvisited node has degree 2 (junctions were walked above), so each run is a cycle, fitted
  // cyclically. The old RDP path pinned two arbitrary points on such a ring; a cyclic fit needs
  // none, and pinning would plant two corners on a smooth island.
  for (let n = 0; n < nodeCount; n++) {
    if (!degrees[n]) continue;
    const count = neighbours(n);
    const pairs = Array.from({ length: count }, (_, i) => [nbBuf[i * 2], nbBuf[i * 2 + 1]]);
    for (const [node, crack] of pairs) {
      if (visited[crack]) continue;
      const ring = walk(n, node, crack);
      register(ring, ring.length > 2 && ring[0] === ring[ring.length - 1]);
    }
  }
  return { chains, chainOf };
}

/**
 * Walk every region boundary as a closed ring of lattice points, keeping only the points
 * `buildChains` fitted. Rings are traversed with the region on the right; where a component touches
 * itself diagonally, sharpest-right-turn preference gives two rings meeting at a point, not one self-crossing ring.
 */
function walkRings(
  labels: Int16Array,
  compId: Int32Array,
  w: number,
  h: number,
  chainSet: ChainSet,
): Map<number, RingSet> {
  const stride = w + 1;
  const nodeCount = stride * (h + 1);
  const vCount = stride * h;
  const crackBetween = crackIndexer(stride, w, vCount);
  const { chains, chainOf } = chainSet;
  const labelAt = (x: number, y: number) =>
    x < 0 || y < 0 || x >= w || y >= h ? BACKGROUND : labels[y * w + x];

  // outEdge[node * 4 + dir] is the component traversing that direction, or -1. Each direction is claimed by at most one component: a crack is walked once per side and the background side emits nothing.
  const outEdge = new Int32Array(nodeCount * 4).fill(-1);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const label = labels[y * w + x];
      if (label === BACKGROUND) continue;
      const c = compId[y * w + x];
      if (labelAt(x, y - 1) !== label) outEdge[(y * stride + x) * 4 + E] = c;
      if (labelAt(x + 1, y) !== label) outEdge[(y * stride + x + 1) * 4 + S] = c;
      if (labelAt(x, y + 1) !== label) outEdge[((y + 1) * stride + x + 1) * 4 + W] = c;
      if (labelAt(x - 1, y) !== label) outEdge[((y + 1) * stride + x) * 4 + N] = c;
    }

  const step = (n: number, d: number) =>
    d === E ? n + 1 : d === S ? n + stride : d === W ? n - 1 : n - stride;
  const visited = new Uint8Array(nodeCount * 4);
  const rings = new Map<number, RingSet>();

  for (let start = 0; start < nodeCount; start++)
    for (let startDir = 0; startDir < 4; startDir++) {
      const comp = outEdge[start * 4 + startDir];
      if (comp < 0 || visited[start * 4 + startDir]) continue;
      const ringNodes: number[] = [];
      let n = start,
        d = startDir;
      for (;;) {
        visited[n * 4 + d] = 1;
        ringNodes.push(n);
        const nn = step(n, d);
        let nd = -1;
        for (const cand of [right(d), d, left(d)])
          if (outEdge[nn * 4 + cand] === comp && !visited[nn * 4 + cand]) {
            nd = cand;
            break;
          }
        n = nn;
        if (nd < 0) break;
        d = nd;
      }
      const used: number[] = [];
      const loop = spliceChains(ringNodes, chains, chainOf, crackBetween, used);
      const entry = rings.get(comp) ?? { loops: [], chains: [] };
      // A ring collapsed below three points contributes no geometry, but its chains are the ones to suspect — recorded before dropping it, or the guard below can't see a region lost outright.
      if (loop.length >= 3) entry.loops.push(loop);
      for (const id of used) if (!entry.chains.includes(id)) entry.chains.push(id);
      rings.set(comp, entry);
    }
  return rings;
}

/**
 * Turn a ring's lattice-node cycle into the fitted polyline by concatenating the chains it crosses.
 * A ring is a whole number of chains (an interior node has exactly two cracks, so a traversal can
 * only leave a chain at its far end), which is what makes splicing whole chains correct and gives
 * both regions along a boundary byte-identical geometry.
 */
function spliceChains(
  ringNodes: number[],
  chains: Chain[],
  chainOf: Int32Array,
  crackBetween: (a: number, b: number) => number,
  used: number[],
): Loop {
  const k = ringNodes.length;
  const loop: Loop = [];
  if (k < 2) return loop;

  const chainAtIn = (nodes: number[], i: number) =>
    chainOf[crackBetween(nodes[i], nodes[(i + 1) % k])];

  // The walk starts at the ring's lowest node id, a lattice corner that needn't be a chain boundary
  // (only junctions end a chain). Starting mid-chain would split it across the first and last group
  // and emit its halves out of order, so rotate onto a boundary first. A ring that is one whole
  // closed chain has none and needs no rotation.
  let startIdx = 0;
  for (let i = 0; i < k; i++)
    if (chainAtIn(ringNodes, i) !== chainAtIn(ringNodes, (i - 1 + k) % k)) {
      startIdx = i;
      break;
    }
  const nodes =
    startIdx === 0 ? ringNodes : [...ringNodes.slice(startIdx), ...ringNodes.slice(0, startIdx)];
  const chainAt = (i: number) => chainAtIn(nodes, i);

  let i = 0;
  while (i < k) {
    const id = chainAt(i);
    let j = i + 1;
    while (j < k && chainAt(j) === id) j++;
    const chain = chains[id];
    // Unreachable by construction — every crossable crack was registered in buildChains. Loud, not silent: skipping would ship a region missing part of its outline, plausible in preview and wrong in print.
    if (!chain) throw new Error(`Traced ring crossed an unregistered boundary (crack chain ${id})`);
    used.push(id);
    appendFitted(loop, chain, nodes[i], nodes[(i + 1) % k]);
    i = j;
  }

  // The seam dedup in appendFitted looks one point back, so the ring's closing point (shared by the last chain's end and the first's start) survives. Dropped: a Loop is implicitly closed and `loopToRing` would see a zero-length final edge.
  const first = loop[0];
  const last = loop[loop.length - 1];
  if (loop.length > 1 && first.x === last.x && first.y === last.y) loop.pop();
  return loop;
}

/**
 * Which way is this ring traversing the chain? An open chain answers by its pinned first node; a
 * closed one compares the step taken against the step the chain stores. The second node matters in
 * both cases: a chain that leaves a junction and returns to it has identical endpoints, and the
 * entry node alone can't tell the two ways apart.
 */
function traversedForward(chain: Chain, entry: number, second: number): boolean {
  if (!chain.index) return entry === chain.nodes[0] && second === chain.nodes[1];
  const at = chain.index.get(entry);
  if (at === undefined) return true;
  return chain.nodes[(at + 1) % chain.index.size] === second;
}

function appendFitted(loop: Loop, chain: Chain, entry: number, second: number): void {
  const pts = traversedForward(chain, entry, second) ? chain.fitted : [...chain.fitted].reverse();
  if (!pts.length) return;
  // Consecutive chains meet at a junction both fits pin, so the shared point arrives twice. Exact equality is right: pinned endpoints pass through the fit unchanged.
  const prev = loop[loop.length - 1];
  const skipFirst = prev !== undefined && pts[0].x === prev.x && pts[0].y === prev.y;
  for (let i = skipFirst ? 1 : 0; i < pts.length; i++) loop.push(pts[i]);
}

/**
 * Quantized label grid -> closed polygons, one component at a time. Hole-vs-solid is deliberately
 * *not* decided here: `shapeToFeature` (src/geometry/regions.ts) resolves it by containment depth,
 * tested for both SVG fill rules, and `loopToRing` normalizes winding. Emitting every closed ring
 * and letting that classify reuses tested logic and removes a class of tracer bug.
 */
export function traceLabelMap(map: LabelMap, params: TraceParams, placedFloor = 0): TraceResult {
  const { w, h } = map;
  const labels = map.labels.slice(); // the caller's grid is reused across re-quantizes
  // `placedFloor` is the resolved floor for this placement (stats.ts despeckleFloorPx). It replaces
  // the fractional floor, not raises it: at a large placement the right floor is *below* the
  // fraction; 0 means placement unknown, so the fraction is all there is.
  let minArea = Math.max(1, placedFloor || fracFloorPx(params, w, h));

  clean(labels, w, h, minArea);

  let { compId, areas, labelOf } = labelComponents(labels, w, h);
  let raises = 0;
  for (;;) {
    const real = areas.filter((_, i) => labelOf[i] !== BACKGROUND);
    if (real.length <= MAX_COMPONENTS) break;
    raises++;
    // Raise the floor to exactly the size that fits under the cap, not a guessed multiplier. It must
    // be rechecked: absorbing specks merges them and the merged ones can clear the floor meant to
    // remove them. The `minArea + 1` is what ends the loop: the floor rises every pass and at w*h
    // the image is one component.
    real.sort((a, b) => b - a);
    minArea = Math.max(minArea + 1, real[MAX_COMPONENTS - 1] + 1);
    clean(labels, w, h, minArea);
    ({ compId, areas, labelOf } = labelComponents(labels, w, h));
  }

  const chainSet = buildChains(labels, w, h, params);
  let rings = walkRings(labels, compId, w, h, chainSet);
  if (unfitCollapsedChains(rings, chainSet, areas, labelOf, w + 1))
    rings = walkRings(labels, compId, w, h, chainSet);

  const components: TracedComponent[] = [];
  for (const [comp, entry] of rings) {
    if (labelOf[comp] === BACKGROUND || !entry.loops.length) continue;
    components.push({ label: labelOf[comp], loops: entry.loops, area: areas[comp] });
  }
  components.sort((a, b) => b.area - a.area);
  return { components, raises, floorPx: minArea, labels };
}
