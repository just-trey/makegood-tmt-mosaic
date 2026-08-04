import type { Loop, Pt } from '../types';
import { BACKGROUND } from './types';
import type { LabelMap, TraceParams } from './types';
import { fitChain } from './curve';

/**
 * Ceiling on traced components. Exceeding it raises the despeckle floor and re-runs rather than
 * handing the region pipeline a shape count it will choke on — see the O(n²·len) note in
 * docs/tech-debt.md. Deliberately a component cap rather than a point cap: components are what
 * drive ring count, and ring count is what `shapeToFeature` is quadratic in.
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
  /** True when MAX_COMPONENTS forced the despeckle floor up — the caller turns this into a notice. */
  capped: boolean;
}

const E = 0,
  S = 1,
  W = 2,
  N = 3;

/** Clockwise on screen (y down), which is the turn that keeps a traversal hugging its own region. */
const right = (d: number) => (d + 1) & 3;
const left = (d: number) => (d + 3) & 3;

/**
 * Crack id for the lattice edge between two adjacent nodes, in the same indexing the crack arrays
 * use (vertical cracks first, then horizontal). Both the chain builder and the ring walk need to
 * name the edge they just crossed, and they have to agree exactly — that shared id is how a ring
 * finds the chain whose fitted points it should splice in.
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

/**
 * 4-connected components of equal label, background included (a transparent speck is no more
 * printable than a colored one). Returns a component id per pixel and each component's area.
 */
function labelComponents(
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
 * Absorb components below `minArea` into whichever label surrounds them most.
 *
 * Relabelling to the dominant *neighbour* rather than to the background is what makes this correct
 * for a speck in the middle of a face as well as one on an empty margin — dropping it to background
 * would punch a hole through the artwork instead of removing a speck. Two passes, because absorbing
 * one speck can leave another below the floor; a third would be chasing.
 */
function despeckle(labels: Int16Array, w: number, h: number, minArea: number): void {
  if (minArea <= 1) return;
  for (let pass = 0; pass < 2; pass++) {
    const { compId, areas } = labelComponents(labels, w, h);
    const small = areas.map((a) => a < minArea);
    if (!small.some(Boolean)) return;

    const votes = new Map<number, Map<number, number>>();
    for (let p = 0; p < labels.length; p++) {
      const id = compId[p];
      if (!small[id]) continue;
      const x = p % w,
        y = (p / w) | 0;
      let tally = votes.get(id);
      if (!tally) votes.set(id, (tally = new Map()));
      const consider = (q: number) => {
        if (compId[q] === id) return;
        tally.set(labels[q], (tally.get(labels[q]) ?? 0) + 1);
      };
      if (x > 0) consider(p - 1);
      if (x + 1 < w) consider(p + 1);
      if (y > 0) consider(p - w);
      if (y + 1 < h) consider(p + w);
    }

    const winner = new Map<number, number>();
    for (const [id, tally] of votes) {
      let best = -1,
        bestN = -1;
      for (const [label, n] of tally)
        if (n > bestN || (n === bestN && label < best)) {
          bestN = n;
          best = label;
        }
      if (bestN > 0) winner.set(id, best);
    }
    if (!winner.size) return;
    for (let p = 0; p < labels.length; p++) {
      const to = winner.get(compId[p]);
      if (to !== undefined) labels[p] = to;
    }
  }
}

/**
 * Break every 2x2 that reads A,B / B,A.
 *
 * Such a block puts four cracks on one lattice point with only two labels, and there is no
 * non-arbitrary way to pair them up — either choice makes a self-touching ring or a zero-area
 * overlap. Removing the configuration outright is cheaper than encoding a tie-break and leaves the
 * crack graph with no node above degree 3 that isn't a genuine meeting of distinct regions. One
 * scan pass suffices: it only ever writes the bottom-right cell, which every later block reads.
 */
function deChecker(labels: Int16Array, w: number, h: number): void {
  for (let y = 0; y + 1 < h; y++) {
    for (let x = 0; x + 1 < w; x++) {
      const i = y * w + x;
      const a = labels[i],
        b = labels[i + 1],
        c = labels[i + w],
        d = labels[i + w + 1];
      if (a === d && b === c && a !== b) labels[i + w + 1] = b;
    }
  }
}

/** One maximal run of cracks between two junctions, or a whole junction-free island boundary. */
interface Chain {
  nodes: number[];
  /** The sub-pixel polyline `curve.ts` fitted to `nodes`, in the same direction. */
  fitted: Pt[];
  closed: boolean;
  /** Position of each node within `nodes` — only built for closed chains, which need it to tell
   * which way a ring is traversing them. Open chains answer that by comparing against nodes[0]. */
  index: Map<number, number> | null;
}

interface ChainSet {
  chains: Chain[];
  /** Crack id -> index into `chains`. How a ring walk finds the chain it is currently on. */
  chainOf: Int32Array;
}

/**
 * Cut the crack graph into chains and fit a sub-pixel curve to each, once and globally.
 *
 * This is the whole reason the crack graph is built. Every boundary between two regions is one
 * chain of cracks shared by both of them; fitting each region's rings independently would pull
 * that shared chain two different ways and leave a sliver of bare part surface along every colour
 * boundary in the image. Fitting the shared chain once and splicing the identical points into both
 * regions keeps the two sides bit-identical — which is what makes the fit safe to do at all.
 */
function buildChains(labels: Int16Array, w: number, h: number, params: TraceParams): ChainSet {
  const stride = w + 1;
  const nodeCount = stride * (h + 1);
  const labelAt = (x: number, y: number) =>
    x < 0 || y < 0 || x >= w || y >= h ? BACKGROUND : labels[y * w + x];
  // A crack is a unit edge between two differently-labelled pixels. Vertical cracks are indexed
  // first, then horizontal ones.
  const vCount = stride * h;
  const crackBetween = crackIndexer(stride, w, vCount);

  // Crack existence and node degree are precomputed rather than derived per query: the walks below
  // hit them once per step over the whole lattice, and recomputing from `labels` each time made
  // tracing the dominant cost of loading an image (measured with scripts/bench-raster.ts).
  const vCrack = new Uint8Array(vCount);
  for (let y = 0; y < h; y++)
    for (let x = 0; x <= w; x++)
      vCrack[y * stride + x] = labelAt(x - 1, y) !== labelAt(x, y) ? 1 : 0;
  const hCrack = new Uint8Array(w * (h + 1));
  for (let y = 0; y <= h; y++)
    for (let x = 0; x < w; x++) hCrack[y * w + x] = labelAt(x, y - 1) !== labelAt(x, y) ? 1 : 0;

  // Neighbours of a lattice node along the four lattice directions, written into a scratch buffer
  // as [nodeId, crackId] pairs to keep this allocation-free in the inner loops.
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
    // A closed walk returns to its start, so the node list carries the first node twice; the fit
    // wants the cycle without that repeat.
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

  // Whatever is left is a closed chain with no junction on it — an island's boundary sitting inside
  // one uniform field. Every node still unvisited here has degree 2 (degree 1 and 3+ are junctions,
  // already walked above), so each remaining run is a cycle and gets fitted cyclically. The old RDP
  // path had to pin two arbitrary points on such a ring to have something to simplify between;
  // a cyclic fit needs no pins, and pinning would have planted two corners on a smooth island.
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
 * `buildChains` fitted.
 *
 * Rings are traversed with the region on the right; where one component touches itself diagonally
 * the sharpest-right-turn preference resolves it as two rings meeting at a point rather than one
 * self-crossing ring.
 */
function walkRings(
  labels: Int16Array,
  compId: Int32Array,
  w: number,
  h: number,
  chainSet: ChainSet,
): Map<number, Loop[]> {
  const stride = w + 1;
  const nodeCount = stride * (h + 1);
  const vCount = stride * h;
  const crackBetween = crackIndexer(stride, w, vCount);
  const { chains, chainOf } = chainSet;
  const labelAt = (x: number, y: number) =>
    x < 0 || y < 0 || x >= w || y >= h ? BACKGROUND : labels[y * w + x];

  // outEdge[node * 4 + dir] is the component that traverses that lattice direction, or -1. Each
  // direction is claimed by at most one component: a crack is walked once per side, and the
  // background side emits nothing.
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
  const rings = new Map<number, Loop[]>();

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
      const loop = spliceChains(ringNodes, chains, chainOf, crackBetween);
      if (loop.length >= 3) {
        const list = rings.get(comp);
        if (list) list.push(loop);
        else rings.set(comp, [loop]);
      }
    }
  return rings;
}

/**
 * Turn a ring's lattice-node cycle into the fitted polyline, by concatenating the chains it crosses.
 *
 * A ring is always a whole number of chains: a chain's interior nodes have exactly two cracks, so
 * once a traversal enters a chain there is no way out of it except at the far end. That is what
 * makes splicing whole chains — rather than per-node points — correct, and it is what guarantees
 * both regions along a boundary get byte-identical geometry.
 */
function spliceChains(
  ringNodes: number[],
  chains: Chain[],
  chainOf: Int32Array,
  crackBetween: (a: number, b: number) => number,
): Loop {
  const k = ringNodes.length;
  const loop: Loop = [];
  if (k < 2) return loop;

  const chainAtIn = (nodes: number[], i: number) =>
    chainOf[crackBetween(nodes[i], nodes[(i + 1) % k])];

  // The walk starts at the ring's lowest node id, which is a lattice corner and not necessarily a
  // chain boundary — a chain turns corners freely, only junctions end one. Starting mid-chain would
  // split that chain across the first and last group and emit its two halves out of order, so
  // rotate the cycle onto a boundary first. A ring that is one whole closed chain has no boundary
  // to find and needs no rotation.
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
    // Unreachable by construction — every crack the ring can cross was registered by one of the
    // two walks in buildChains. Loud rather than silent: skipping the run would ship a region
    // missing part of its outline, which looks plausible in the preview and prints wrong.
    if (!chain) throw new Error(`Traced ring crossed an unregistered boundary (crack chain ${id})`);
    appendFitted(loop, chain, nodes[i], nodes[(i + 1) % k]);
    i = j;
  }

  // The seam dedup in appendFitted only looks one point back, so the ring's own closing point —
  // shared by the last chain's end and the first chain's start — survives. Drop it: a Loop is
  // implicitly closed, and `loopToRing` would otherwise see a zero-length final edge.
  const first = loop[0];
  const last = loop[loop.length - 1];
  if (loop.length > 1 && first.x === last.x && first.y === last.y) loop.pop();
  return loop;
}

/**
 * Which way is this ring traversing the chain? An open chain answers by its pinned first node; a
 * closed one has no distinguished end, so it compares the step actually taken against the step the
 * chain stores. The second node matters in both cases: a chain that leaves a junction and returns
 * to the same one has identical endpoints, and the entry node alone can't tell the two ways apart.
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
  // Consecutive chains meet at a junction that both fits pin exactly, so the shared point arrives
  // twice. Exact equality is the right test: pinned endpoints are copied through the fit unchanged.
  const prev = loop[loop.length - 1];
  const skipFirst = prev !== undefined && pts[0].x === prev.x && pts[0].y === prev.y;
  for (let i = skipFirst ? 1 : 0; i < pts.length; i++) loop.push(pts[i]);
}

/**
 * Quantized label grid -> closed polygons, one component at a time.
 *
 * Hole-vs-solid is deliberately *not* decided here: `shapeToFeature` (src/geometry/regions.ts)
 * already resolves it by containment depth, correctly for both SVG fill rules and under test. The
 * same goes for winding, which `loopToRing` normalizes. Emitting every closed ring and letting that
 * code classify them reuses tested logic and removes a whole class of tracer bug.
 */
export function traceLabelMap(map: LabelMap, params: TraceParams): TraceResult {
  const { w, h } = map;
  const labels = map.labels.slice(); // the caller's grid is reused across re-quantizes
  let minArea = Math.max(1, Math.round(params.despeckleFrac * w * h));

  despeckle(labels, w, h, minArea);
  deChecker(labels, w, h);

  let { compId, areas, labelOf } = labelComponents(labels, w, h);
  let capped = false;
  const realCount = () => areas.filter((_, i) => labelOf[i] !== BACKGROUND).length;
  if (realCount() > MAX_COMPONENTS) {
    // Raise the floor to exactly the size that fits under the cap, rather than guessing a
    // multiplier and re-running blind.
    const sorted = areas.filter((_, i) => labelOf[i] !== BACKGROUND).sort((a, b) => b - a);
    minArea = Math.max(minArea + 1, sorted[MAX_COMPONENTS - 1] + 1);
    despeckle(labels, w, h, minArea);
    deChecker(labels, w, h);
    ({ compId, areas, labelOf } = labelComponents(labels, w, h));
    capped = true;
  }

  const chainSet = buildChains(labels, w, h, params);
  const rings = walkRings(labels, compId, w, h, chainSet);

  const components: TracedComponent[] = [];
  for (const [comp, loops] of rings) {
    if (labelOf[comp] === BACKGROUND) continue;
    components.push({ label: labelOf[comp], loops, area: areas[comp] });
  }
  components.sort((a, b) => b.area - a.area);
  return { components, capped };
}
