import type { Loop, Pt } from '../types';
import { BACKGROUND } from './types';
import type { LabelMap, TraceParams } from './types';

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

/** Ramer–Douglas–Peucker over lattice-node ids, marking which survive. Explicit stack, not
 * recursion: a boundary chain can run to tens of thousands of points, and this repo already
 * carries scar tissue for that class of overflow (see rethrowStackOverflowAs in regions.ts). */
function rdpMark(nodes: number[], tol: number, survivor: Uint8Array, stride: number): void {
  if (nodes.length < 3) {
    for (const n of nodes) survivor[n] = 1;
    return;
  }
  survivor[nodes[0]] = 1;
  survivor[nodes[nodes.length - 1]] = 1;
  const xOf = (n: number) => n % stride;
  const yOf = (n: number) => (n / stride) | 0;
  const stack: [number, number][] = [[0, nodes.length - 1]];
  while (stack.length) {
    const [from, to] = stack.pop() as [number, number];
    if (to <= from + 1) continue;
    const x0 = xOf(nodes[from]),
      y0 = yOf(nodes[from]);
    const x1 = xOf(nodes[to]),
      y1 = yOf(nodes[to]);
    const dx = x1 - x0,
      dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    let worst = -1,
      worstD = tol;
    for (let i = from + 1; i < to; i++) {
      const px = xOf(nodes[i]),
        py = yOf(nodes[i]);
      const d = len
        ? Math.abs(dy * px - dx * py + x1 * y0 - y1 * x0) / len
        : Math.hypot(px - x0, py - y0);
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst < 0) continue;
    survivor[nodes[worst]] = 1;
    stack.push([from, worst], [worst, to]);
  }
}

/**
 * Decide, once and globally, which lattice points survive simplification.
 *
 * This is the whole reason the crack graph is built. Every boundary between two regions is one
 * chain of cracks shared by both of them; simplifying each region's rings independently would pull
 * that shared chain two different ways and leave a sliver of bare part surface along every colour
 * boundary in the image. Marking survivors on the shared chain and then filtering both regions'
 * rings through the same mark keeps the two sides bit-identical.
 */
function markSurvivors(labels: Int16Array, w: number, h: number, tol: number): Uint8Array {
  const stride = w + 1;
  const nodeCount = stride * (h + 1);
  const survivor = new Uint8Array(nodeCount);
  const labelAt = (x: number, y: number) =>
    x < 0 || y < 0 || x >= w || y >= h ? BACKGROUND : labels[y * w + x];
  // A crack is a unit edge between two differently-labelled pixels. Vertical cracks are indexed
  // first, then horizontal ones.
  const vCount = stride * h;

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

  const degrees = new Uint8Array(nodeCount);
  const visited = new Uint8Array(vCount + w * (h + 1));
  const junctions: number[] = [];
  for (let n = 0; n < nodeCount; n++) {
    const d = (degrees[n] = neighbours(n));
    if (d && d !== 2) {
      survivor[n] = 1;
      junctions.push(n);
    }
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

  for (const j of junctions) {
    const count = neighbours(j);
    const pairs = Array.from({ length: count }, (_, i) => [nbBuf[i * 2], nbBuf[i * 2 + 1]]);
    for (const [node, crack] of pairs) {
      if (visited[crack]) continue;
      rdpMark(walk(j, node, crack), tol, survivor, stride);
    }
  }

  // Whatever is left is a closed chain with no junction on it — an island's boundary sitting inside
  // one uniform field. Pin two points on it so RDP has something to work between, chosen
  // deterministically (lowest node id, then the point geometrically farthest from it) so both sides
  // of the chain make the same choice.
  for (let n = 0; n < nodeCount; n++) {
    if (!degrees[n]) continue;
    const count = neighbours(n);
    const pairs = Array.from({ length: count }, (_, i) => [nbBuf[i * 2], nbBuf[i * 2 + 1]]);
    for (const [node, crack] of pairs) {
      if (visited[crack]) continue;
      const ring = walk(n, node, crack);
      if (ring.length < 4) {
        for (const p of ring) survivor[p] = 1;
        continue;
      }
      const x0 = ring[0] % stride,
        y0 = (ring[0] / stride) | 0;
      let far = 1,
        farD = -1;
      for (let i = 1; i < ring.length; i++) {
        const d = Math.hypot((ring[i] % stride) - x0, ((ring[i] / stride) | 0) - y0);
        if (d > farD) {
          farD = d;
          far = i;
        }
      }
      rdpMark(ring.slice(0, far + 1), tol, survivor, stride);
      rdpMark(ring.slice(far), tol, survivor, stride);
    }
  }
  return survivor;
}

/**
 * Walk every region boundary as a closed ring of lattice points, keeping only the points
 * `markSurvivors` kept.
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
  survivor: Uint8Array,
): Map<number, Loop[]> {
  const stride = w + 1;
  const nodeCount = stride * (h + 1);
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
      const loop: Loop = [];
      let n = start,
        d = startDir;
      for (;;) {
        visited[n * 4 + d] = 1;
        if (survivor[n]) loop.push({ x: n % stride, y: (n / stride) | 0 } as Pt);
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
      if (loop.length >= 3) {
        const list = rings.get(comp);
        if (list) list.push(loop);
        else rings.set(comp, [loop]);
      }
    }
  return rings;
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

  const survivor = markSurvivors(labels, w, h, params.simplifyTol);
  const rings = walkRings(labels, compId, w, h, survivor);

  const components: TracedComponent[] = [];
  for (const [comp, loops] of rings) {
    if (labelOf[comp] === BACKGROUND) continue;
    components.push({ label: labelOf[comp], loops, area: areas[comp] });
  }
  components.sort((a, b) => b.area - a.area);
  return { components, capped };
}
