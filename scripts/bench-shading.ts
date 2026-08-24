// What the display path's creased shading costs, and whether the vertex weld inside it is the
// reason. Backs the "display meshes re-derive a vertex weld" section of docs/tech-debt.md, which
// records the shading swap as 3.0s -> 4.1s on a chair load and names the weld as the plausible but
// never-isolated cause.
//
//   node_modules/.bin/vite-node scripts/bench-shading.ts cost      split toCreasedNormals by phase
//   node_modules/.bin/vite-node scripts/bench-shading.ts candidate indexed crease pass, against it
//
// Both run the chair's 13 parts by default; pass part ids to narrow.
//
// The soup measured here is the one a bare chair load actually shades: `renderRawAssemblyParts`
// hands `part.positions` straight to `bufferGeometryFromTris`, with no artwork and no boolean
// anywhere in the picture. That matters, because the tech-debt section proposes reusing
// `bodyIndexed` from `AssemblyPartOutput`, which only exists after a cut.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The chair kind's parts, standard caster variant: the 13 the 4.1s figure was taken on. */
const CHAIR = [
  'chair-handle-left',
  'chair-handle-right',
  'chair-storage-left',
  'chair-storage-right',
  'chair-wing-left',
  'chair-wing-right',
  'chair-wheel-mount-left',
  'chair-wheel-mount-right',
  'chair-seat-center',
  'chair-seat-back-bottom',
  'chair-seat-back-top',
  'chair-caster-std-left',
  'chair-caster-std-right',
];

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.DOMParser = dom.window.DOMParser;

const THREE = await import('three');
const { toCreasedNormals } = await import('three/addons/utils/BufferGeometryUtils.js');
const JSZip = (await import('jszip')).default;

/** rebuild.ts's CREASE_ANGLE_RAD. Duplicated rather than imported: importing rebuild.ts pulls in
 * the whole scene and UI graph, which has no business in a geometry bench. */
const CREASE_ANGLE_RAD = (30 * Math.PI) / 180;

const now = () => performance.now();
const ms = (n: number) => `${n.toFixed(0)}ms`;

interface Part {
  id: string;
  /** Non-indexed triangle soup, exactly what part.positions holds. */
  positions: Float32Array;
  /** Unique vertices in file order. */
  vertices: Float32Array;
  /** 3 vertex indices per triangle, straight out of the 3MF. load3MF discards this today. */
  index: Uint32Array;
}

/**
 * Read a packed part, keeping the triangle index the file already carries.
 *
 * This is load3MF (src/geometry/meshparts.ts) with one difference that is the point of the bench:
 * the 3MF's <triangle> elements *are* an index, and load3MF expands them into a soup and drops
 * them. Whether a crease pass could consume that index instead of rebuilding one by hashing is
 * exactly the open question, so the bench keeps it.
 */
async function loadPart(id: string): Promise<Part> {
  const buf = readFileSync(path.join(REPO, 'public', 'stl', `${id}.3mf`));
  const zip = await JSZip.loadAsync(buf);
  const xmlText = await zip.file('3D/3dmodel.model')!.async('string');
  // Scanned, not DOM-parsed. jsdom's getElementsByTagName is a live collection, so walking a few
  // hundred thousand <vertex> elements through it is quadratic and never finishes. The app's
  // load3MF runs in a browser where that collection is native, so this shortcut is the bench's
  // problem to solve, not evidence about load3MF.
  const allVerts: number[] = [];
  const allTris: number[] = [];
  for (const objXml of xmlText.split('<object').slice(1)) {
    const base = allVerts.length / 3;
    let m: RegExpExecArray | null;
    const vRe = /<vertex\s+x="([^"]*)"\s+y="([^"]*)"\s+z="([^"]*)"/g;
    while ((m = vRe.exec(objXml))) allVerts.push(+m[1], +m[2], +m[3]);
    const tRe = /<triangle\s+v1="([^"]*)"\s+v2="([^"]*)"\s+v3="([^"]*)"/g;
    while ((m = tRe.exec(objXml))) allTris.push(base + +m[1], base + +m[2], base + +m[3]);
  }
  const vertices = Float32Array.from(allVerts);
  const index = Uint32Array.from(allTris);
  const positions = new Float32Array(index.length * 3);
  for (let i = 0; i < index.length; i++) {
    positions[i * 3] = vertices[index[i] * 3];
    positions[i * 3 + 1] = vertices[index[i] * 3 + 1];
    positions[i * 3 + 2] = vertices[index[i] * 3 + 2];
  }
  return { id, positions, vertices, index };
}

function soupGeometry(positions: Float32Array): import('three').BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geo;
}

/**
 * Pass 1 of toCreasedNormals, lifted verbatim, and the hashing inside it on its own.
 *
 * Two numbers because "is the weld the cost" needs both. Pass 1 is the whole first loop: a face
 * normal per triangle (cross, normalize, and a `new Vector3` that every one of the triangle's
 * three buckets then holds) plus three string hashes and three map pushes. The weld proper is only
 * the hashing and bucketing half of that.
 *
 * Re-implemented rather than imported because three exports only the whole function. Keep this in
 * step with `toCreasedNormals` if three is upgraded, or it stops being an attribution.
 */
function pass1Costs(positions: Float32Array): {
  buckets: number;
  verbatimMs: number;
  hashMs: number;
} {
  const hashMultiplier = (1 + 1e-10) * 1e2;
  const triCount = positions.length / 9;

  const t0 = now();
  const vertexMap: Record<string, InstanceType<typeof THREE.Vector3>[]> = {};
  const a = new THREE.Vector3(),
    b = new THREE.Vector3(),
    c = new THREE.Vector3(),
    u = new THREE.Vector3(),
    v = new THREE.Vector3();
  for (let i = 0; i < triCount; i++) {
    const i9 = i * 9;
    a.set(positions[i9], positions[i9 + 1], positions[i9 + 2]);
    b.set(positions[i9 + 3], positions[i9 + 4], positions[i9 + 5]);
    c.set(positions[i9 + 6], positions[i9 + 7], positions[i9 + 8]);
    u.subVectors(c, b);
    v.subVectors(a, b);
    const normal = new THREE.Vector3().crossVectors(u, v).normalize();
    for (const vert of [a, b, c]) {
      const hash = `${~~(vert.x * hashMultiplier)},${~~(vert.y * hashMultiplier)},${~~(vert.z * hashMultiplier)}`;
      (vertexMap[hash] ||= []).push(normal);
    }
  }
  const verbatimMs = now() - t0;

  const t1 = now();
  const buckets: Record<string, number[]> = {};
  for (let i = 0; i < triCount; i++) {
    const i9 = i * 9;
    for (let n = 0; n < 3; n++) {
      const o = i9 + n * 3;
      const hash = `${~~(positions[o] * hashMultiplier)},${~~(positions[o + 1] * hashMultiplier)},${~~(positions[o + 2] * hashMultiplier)}`;
      (buckets[hash] ||= []).push(i);
    }
  }
  const hashMs = now() - t1;

  return { buckets: Object.keys(buckets).length, verbatimMs, hashMs };
}

/**
 * Candidate: crease-aware normals built from the triangle index, with no hashing at all.
 *
 * Shares a vertex exactly (the file's own vertex list) instead of bucketing positions to 0.01mm,
 * and builds the vertex-to-face adjacency with a counting sort into two flat typed arrays, so
 * nothing is allocated per triangle. Output is still a non-indexed soup with per-corner normals,
 * because that is what crease shading needs: a vertex on a real edge carries a different normal on
 * each side of it.
 */
function creasedFromIndex(
  vertices: Float32Array,
  index: Uint32Array,
  creaseAngle: number,
): Float32Array {
  const creaseDot = Math.cos(creaseAngle);
  const triCount = index.length / 3;
  const vertCount = vertices.length / 3;

  const faceN = new Float32Array(triCount * 3);
  for (let f = 0; f < triCount; f++) {
    const a = index[f * 3] * 3,
      b = index[f * 3 + 1] * 3,
      c = index[f * 3 + 2] * 3;
    const ux = vertices[c] - vertices[b],
      uy = vertices[c + 1] - vertices[b + 1],
      uz = vertices[c + 2] - vertices[b + 2];
    const vx = vertices[a] - vertices[b],
      vy = vertices[a + 1] - vertices[b + 1],
      vz = vertices[a + 2] - vertices[b + 2];
    let nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    faceN[f * 3] = nx;
    faceN[f * 3 + 1] = ny;
    faceN[f * 3 + 2] = nz;
  }

  // vertex -> incident faces, as a CSR-style pair of arrays (counting sort, two linear passes)
  const start = new Uint32Array(vertCount + 1);
  for (let i = 0; i < index.length; i++) start[index[i] + 1]++;
  for (let v = 0; v < vertCount; v++) start[v + 1] += start[v];
  const cursor = start.slice(0, vertCount);
  const adj = new Uint32Array(index.length);
  for (let f = 0; f < triCount; f++)
    for (let k = 0; k < 3; k++) adj[cursor[index[f * 3 + k]]++] = f;

  const normals = new Float32Array(triCount * 9);
  for (let f = 0; f < triCount; f++) {
    const fx = faceN[f * 3],
      fy = faceN[f * 3 + 1],
      fz = faceN[f * 3 + 2];
    for (let k = 0; k < 3; k++) {
      const v = index[f * 3 + k];
      let sx = 0,
        sy = 0,
        sz = 0;
      for (let p = start[v]; p < start[v + 1]; p++) {
        const o = adj[p] * 3;
        const ox = faceN[o],
          oy = faceN[o + 1],
          oz = faceN[o + 2];
        if (fx * ox + fy * oy + fz * oz >= creaseDot) {
          sx += ox;
          sy += oy;
          sz += oz;
        }
      }
      const len = Math.hypot(sx, sy, sz) || 1;
      const out = f * 9 + k * 3;
      normals[out] = sx / len;
      normals[out + 1] = sy / len;
      normals[out + 2] = sz / len;
    }
  }
  return normals;
}

/** Worst and mean angle, in degrees, between two per-corner normal arrays, plus how many corners
 * are more than a degree apart. The mean hides a handful of bad corners; the count does not. */
function normalAgreement(
  a: Float32Array,
  b: Float32Array,
  skip?: Uint8Array,
): { worstDeg: number; meanDeg: number; over1: number; counted: number } {
  let worst = 0,
    sum = 0,
    over1 = 0,
    counted = 0;
  const n = a.length / 3;
  for (let i = 0; i < n; i++) {
    if (skip?.[i]) continue;
    counted++;
    const o = i * 3;
    const dot = Math.min(1, Math.max(-1, a[o] * b[o] + a[o + 1] * b[o + 1] + a[o + 2] * b[o + 2]));
    const deg = (Math.acos(dot) * 180) / Math.PI;
    worst = Math.max(worst, deg);
    if (deg > 1) over1++;
    sum += deg;
  }
  return { worstDeg: worst, meanDeg: counted ? sum / counted : 0, over1, counted };
}

/**
 * Corners belonging to a zero-area triangle, which has no normal to compare.
 *
 * Every normal pass has to invent something for a degenerate face, and the inventions differ:
 * three falls back to whatever its bucket held, and a face-normal pass yields (0,0,0). Comparing
 * those produces a 90° disagreement that says nothing about shading, because a zero-area triangle
 * covers no pixels. Counted and excluded rather than quietly tolerated.
 */
function degenerateCorners(vertices: Float32Array, index: Uint32Array): Uint8Array {
  const out = new Uint8Array(index.length);
  for (let f = 0; f < index.length / 3; f++) {
    const a = index[f * 3] * 3,
      b = index[f * 3 + 1] * 3,
      c = index[f * 3 + 2] * 3;
    const ux = vertices[c] - vertices[b],
      uy = vertices[c + 1] - vertices[b + 1],
      uz = vertices[c + 2] - vertices[b + 2];
    const vx = vertices[a] - vertices[b],
      vy = vertices[a + 1] - vertices[b + 1],
      vz = vertices[a + 2] - vertices[b + 2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    if (Math.hypot(nx, ny, nz) === 0) out[f * 3] = out[f * 3 + 1] = out[f * 3 + 2] = 1;
  }
  return out;
}

/**
 * Fuse vertices sharing one exact position, and remap the index onto them.
 *
 * **On the packed parts this is a measured no-op, and that is the result it exists to establish.**
 * The obvious explanation for the disagreement with `toCreasedNormals` was that the files leave
 * vertices duplicated at a position, which position-bucketing would silently fuse. They do not:
 * chair-storage-left has 23244 vertices at 23244 distinct positions, and so does every part
 * checked. The bench proves it from the other end too, since the fused and as-packed columns
 * report identical worst angles and bad-corner counts on all 13 parts.
 *
 * So what `toCreasedNormals` merges beyond this is the 0.01mm bucket, not duplicate geometry.
 *
 * Kept because it is also the stand-in for the path an uploaded STL would need: soup with no
 * vertex list at all. Its cost here is *not* that cost, and must not be quoted as it -- keying 23k
 * unique vertices is a fraction of keying a soup's 1.1M corners.
 */
function fuseVertices(
  vertices: Float32Array,
  index: Uint32Array,
): { vertices: Float32Array; index: Uint32Array } {
  const map = new Map<string, number>();
  const remap = new Uint32Array(vertices.length / 3);
  const out: number[] = [];
  for (let v = 0; v < vertices.length / 3; v++) {
    const o = v * 3;
    const key = `${vertices[o]},${vertices[o + 1]},${vertices[o + 2]}`;
    let id = map.get(key);
    if (id === undefined) {
      id = out.length / 3;
      map.set(key, id);
      out.push(vertices[o], vertices[o + 1], vertices[o + 2]);
    }
    remap[v] = id;
  }
  const newIndex = new Uint32Array(index.length);
  for (let i = 0; i < index.length; i++) newIndex[i] = remap[index[i]];
  return { vertices: Float32Array.from(out), index: newIndex };
}

async function cost(ids: string[]): Promise<void> {
  console.log('\nWhat the display path pays per part, and how much of it is the weld\n');
  console.log(
    '  part                        tris   buckets    flat   creased   pass1  pass1%    hash   hash%',
  );
  const totals = { tris: 0, flat: 0, creased: 0, pass1: 0, hash: 0 };
  for (const id of ids) {
    const part = await loadPart(id);
    const tris = part.positions.length / 9;

    // Warm every timed path on this part before timing any of it. pass1Costs used to be the one
    // path left cold, which inflated its share of the creased pass from 32% to 38%.
    soupGeometry(part.positions).computeVertexNormals();
    toCreasedNormals(soupGeometry(part.positions), CREASE_ANGLE_RAD);
    pass1Costs(part.positions);

    let t = now();
    soupGeometry(part.positions).computeVertexNormals();
    const flat = now() - t;

    t = now();
    toCreasedNormals(soupGeometry(part.positions), CREASE_ANGLE_RAD);
    const creased = now() - t;

    const w = pass1Costs(part.positions);
    console.log(
      `  ${id.padEnd(24)} ${String(tris).padStart(7)} ${String(w.buckets).padStart(9)} ` +
        `${ms(flat).padStart(7)} ${ms(creased).padStart(9)} ${ms(w.verbatimMs).padStart(7)} ` +
        `${((100 * w.verbatimMs) / creased).toFixed(0).padStart(5)}% ${ms(w.hashMs).padStart(7)} ` +
        `${((100 * w.hashMs) / creased).toFixed(0).padStart(5)}%`,
    );
    totals.tris += tris;
    totals.flat += flat;
    totals.creased += creased;
    totals.pass1 += w.verbatimMs;
    totals.hash += w.hashMs;
  }
  console.log(
    `  ${'TOTAL'.padEnd(24)} ${String(totals.tris).padStart(7)} ${''.padStart(9)} ` +
      `${ms(totals.flat).padStart(7)} ${ms(totals.creased).padStart(9)} ${ms(totals.pass1).padStart(7)} ` +
      `${((100 * totals.pass1) / totals.creased).toFixed(0).padStart(5)}% ${ms(totals.hash).padStart(7)} ` +
      `${((100 * totals.hash) / totals.creased).toFixed(0).padStart(5)}%`,
  );
  console.log(
    `\n  creased costs ${(totals.creased / totals.flat).toFixed(1)}x flat ` +
      `(+${ms(totals.creased - totals.flat)} over the whole chair)\n` +
      `  pass1 = the whole first loop, hash = only the bucketing inside it (the weld proper)\n`,
  );
}

async function candidate(ids: string[]): Promise<void> {
  console.log('\nIndexed crease pass against toCreasedNormals\n');
  console.log(
    '  part                        tris   creased   as-packed  worst   mean  bad      fused  worst  bad',
  );
  const totals = {
    creased: 0,
    raw: 0,
    fused: 0,
    rawWorst: 0,
    fusedWorst: 0,
    rawBad: 0,
    fusedBad: 0,
    // Corner-weighted, so the total mean is the mean over every compared corner rather than a mean
    // of per-part means, which would over-weight the small parts.
    rawDegSum: 0,
    rawCounted: 0,
  };
  for (const id of ids) {
    const part = await loadPart(id);
    const tris = part.positions.length / 9;
    const fusedIn = fuseVertices(part.vertices, part.index);

    toCreasedNormals(soupGeometry(part.positions), CREASE_ANGLE_RAD);
    creasedFromIndex(part.vertices, part.index, CREASE_ANGLE_RAD);
    creasedFromIndex(fusedIn.vertices, fusedIn.index, CREASE_ANGLE_RAD);

    let t = now();
    const ref = toCreasedNormals(soupGeometry(part.positions), CREASE_ANGLE_RAD);
    const creased = now() - t;

    t = now();
    const asPacked = creasedFromIndex(part.vertices, part.index, CREASE_ANGLE_RAD);
    const rawMs = now() - t;

    // The fuse is part of the candidate's cost, so it is timed with the pass, not before it.
    t = now();
    const f = fuseVertices(part.vertices, part.index);
    const fusedNormals = creasedFromIndex(f.vertices, f.index, CREASE_ANGLE_RAD);
    const fusedMs = now() - t;

    const refN = ref.attributes.normal.array as Float32Array;
    const a = normalAgreement(refN, asPacked, degenerateCorners(part.vertices, part.index));
    const b = normalAgreement(refN, fusedNormals, degenerateCorners(part.vertices, part.index));
    console.log(
      `  ${id.padEnd(24)} ${String(tris).padStart(7)} ${ms(creased).padStart(9)} ` +
        `${ms(rawMs).padStart(11)} ${a.worstDeg.toFixed(1).padStart(6)}° ${a.meanDeg.toFixed(3).padStart(6)}° ${String(a.over1).padStart(4)} ` +
        `${ms(fusedMs).padStart(10)} ${b.worstDeg.toFixed(1).padStart(6)}° ${String(b.over1).padStart(4)}`,
    );
    totals.creased += creased;
    totals.raw += rawMs;
    totals.fused += fusedMs;
    totals.rawWorst = Math.max(totals.rawWorst, a.worstDeg);
    totals.fusedWorst = Math.max(totals.fusedWorst, b.worstDeg);
    totals.rawBad += a.over1;
    totals.fusedBad += b.over1;
    totals.rawDegSum += a.meanDeg * a.counted;
    totals.rawCounted += a.counted;
  }
  console.log(
    `  ${'TOTAL'.padEnd(24)} ${''.padStart(7)} ${ms(totals.creased).padStart(9)} ` +
      `${ms(totals.raw).padStart(11)} ${totals.rawWorst.toFixed(1).padStart(6)}° ` +
      `${(totals.rawDegSum / totals.rawCounted).toFixed(3).padStart(6)}° ${String(totals.rawBad).padStart(4)} ` +
      `${ms(totals.fused).padStart(10)} ${totals.fusedWorst.toFixed(1).padStart(6)}° ${String(totals.fusedBad).padStart(4)}`,
  );
  console.log(
    `\n  as-packed ${(totals.creased / totals.raw).toFixed(1)}x, ` +
      `fused ${(totals.creased / totals.fused).toFixed(1)}x, ` +
      `over the chair's ${totals.rawBad + totals.fusedBad === 0 ? 'identical' : 'compared'} corners\n`,
  );
}

const [mode, ...rest] = process.argv.slice(2);
const ids = rest.length ? rest : CHAIR;
if (mode === 'cost') await cost(ids);
else if (mode === 'candidate') await candidate(ids);
else {
  console.error('usage: bench-shading.ts cost|candidate [part-id...]');
  process.exit(1);
}
