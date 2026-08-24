// Is the placement frame's angle a bug in the frame math, or a rendering choice?
//
//   node_modules/.bin/vite-node scripts/measure-frame-angle.ts
//
// Backs "The placement frame's angle is unrelated to the face it acts on" in docs/tech-debt.md.
// That section has never been measured, and it says why that matters: the two answers close very
// differently. A frame drawn on a plane that is not the face's plane is a defect in placement. A
// frame that faithfully shows an odd-looking parameterisation is a bake or rendering question.
//
// ---------------------------------------------------------------------------
// What is actually compared, and why it is not the code under test twice
// ---------------------------------------------------------------------------
//
// The gizmo draws its outline along `FlatZoneMapper.frameAt()`'s uAxis/vAxis, in the plane those
// two span. `frameAt` returns those as literal constants: uAxis (1,0,0), vAxis (0,0,1), normal
// (0, ±1, 0) — a horizontal plane, whatever the part is shaped like.
//
// The face it is supposed to lie on is `patch.normal`, produced by `detectFlatPatches` from the
// mesh itself. Nothing in that path goes near frameAt. So the angle between the patch normal and
// the frame's plane normal is a comparison of two independent things, and it is exactly the
// quantity convention 13 is about: a gizmo aligned to the frame of the thing it acts on reads 0.
//
// The parts are the real shipped ones and the patch list is the real one the part panel offers,
// so a non-zero angle here is reachable by a user picking that patch, not a synthetic worry.
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.DOMParser = dom.window.DOMParser;

const { read3MF } = await import(
  // @ts-expect-error — plain-JS tooling module, no .d.ts (run by node, not bundled)
  './lib/mesh.mjs'
);
const { detectFlatPatches } = await import('../src/geometry/meshparts');
const { applyAsmPatchChoice } = await import('../src/assembly/parts');
const { FlatZoneMapper } = await import('../src/geometry/zones');
const { ASSEMBLY_KINDS } = await import('../src/assembly/kinds');
import type { AssemblyPart, FlatPatch } from '../src/types';

/**
 * The design meshes a user can actually reach today, and only those.
 *
 * chair-body is withheld from the UI (PR #133). `hubcap-clips` is deliberately absent: it is the
 * four mounting clips alone, and the hubcap role's `buildMesh` generates the disc the design
 * lands on at `state.hubcapDiameterMm`, so the part's mesh is never that file (kinds.ts says so
 * on the role). Measuring it would be measuring a face nothing designs on.
 */
const PARTS = ['wheel-half', 'wheel-hub-cap', 'footrest'];

/** How many of each part's ranked patches the part panel is worth checking over. */
const PATCHES_PER_PART = 6;

const deg = (rad: number) => (rad * 180) / Math.PI;

/**
 * Planar area of a turf polygon/multipolygon, outer rings minus holes, in the coordinates' own
 * units. Not `turf.area`, which reads coordinates as degrees on a sphere; these are mm.
 */
function turfArea(f: { geometry: { type: string; coordinates: unknown } }): number {
  const ring = (r: number[][]): number => {
    let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++)
      a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
    return Math.abs(a) / 2;
  };
  const poly = (p: number[][][]): number => p.reduce((s, r, i) => s + (i ? -ring(r) : ring(r)), 0);
  const c = f.geometry.coordinates;
  return f.geometry.type === 'MultiPolygon'
    ? (c as number[][][][]).reduce((s, p) => s + poly(p), 0)
    : poly(c as number[][][]);
}

/** Angle between two unit vectors, in degrees, sign-free. */
function angleBetween(a: number[], b: number[]): number {
  const d = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return deg(Math.acos(d));
}

/**
 * A part with `patch` chosen as its design face.
 *
 * The face-derived fields (`topZ`, `patchNormal`, `boundaryLoops`, `restPositions`) are written by
 * the app's own `applyAsmPatchChoice` rather than set here. Restating them is how this bench got
 * two things wrong already: the boundary loops need its area sort, which depends on a private
 * helper, and a stub is a second copy of the real part that drifts from it.
 *
 * `cutThrough` still has to come from the real role. `boundary()` skips the clip entirely on a
 * cut-through part (the design is meant to span the whole curved surface and the boolean bounds
 * it), so hardcoding it false published a clip area for wheel-hub-cap that the app never computes.
 */
function partWithPatch(
  positions: Float32Array,
  patch: FlatPatch,
  cutThrough: boolean,
): AssemblyPart {
  const part = {
    id: 1,
    name: 'measured',
    roleId: 'r',
    positions,
    patches: [patch],
    patchIdx: 0,
    baseDepth: 3,
    isDuplicateOf: null,
    pivotX: 0,
    pivotZ: 0,
    angleDeg: 0,
    loaded: true,
    cutThrough,
    zones: undefined,
  } as unknown as AssemblyPart;
  applyAsmPatchChoice(part);
  return part;
}

interface Row {
  part: string;
  rank: number;
  area: number;
  normal: number[];
  /** angle between the real face normal and the plane the gizmo draws the frame in */
  frameTilt: number;
  /** whether the mapper's faceY took its real branch or the |ny| <= 0.1 fallback */
  faceYFallback: boolean;
  /** X/Z area of the region the cut is clipped to, mm². 0 means nothing can be cut there. */
  clipArea: number;
}

const rows: Row[] = [];

/** The shipped role that loads this mesh, so its own flags are read rather than restated here. */
function roleFor(libraryPartId: string) {
  for (const kind of ASSEMBLY_KINDS) {
    const role = kind.roles.find((r) => r.libraryPartId === libraryPartId);
    if (role) return role;
  }
  throw new Error(`no shipped role loads ${libraryPartId}`);
}

for (const id of PARTS) {
  const buf = readFileSync(path.join(REPO, 'public', 'stl', `${id}.3mf`));
  const positions = await read3MF(buf);
  const patches = detectFlatPatches(positions);
  const cutThrough = !!roleFor(id).cutThrough;
  for (let r = 0; r < Math.min(PATCHES_PER_PART, patches.length); r++) {
    const patch = patches[r];
    const part = partWithPatch(positions, patch, cutThrough);
    // isRect only moves the design's centre within the face; it cannot change the frame's plane,
    // so the tilt is read once. Both values are covered by the shipped kinds regardless.
    const mapper = new FlatZoneMapper(part, [part], true, null);
    const frame = mapper.frameAt(0, 0);
    const frameNormal = [frame.normal.x, frame.normal.y, frame.normal.z];
    // Sign-free: a face pointing -Y is handled by nsign and is not a misalignment.
    const tilt = Math.min(
      angleBetween(patch.normal, frameNormal),
      angleBetween(
        patch.normal,
        frameNormal.map((c) => -c),
      ),
    );
    // What the CUT is clipped to, from the same mapper. The gizmo drawing a frame somewhere the
    // cut cannot reach is a different, worse story than the frame merely being rotated, so it is
    // read rather than assumed.
    const clip = mapper.boundary();
    rows.push({
      part: id,
      rank: r,
      area: patch.area,
      normal: patch.normal,
      frameTilt: tilt,
      faceYFallback: !(Math.abs(patch.normal[1]) > 0.1),
      clipArea: clip ? turfArea(clip) : -1,
    });
  }
}

const v3 = (n: number[]) => `(${n.map((c) => c.toFixed(2)).join(', ')})`;

console.log('\nFrame plane vs face plane, per selectable patch');
// Ranked by area, which is the order the dropdown lists. Deliberately NOT labelled with which one
// is the default: `defaultPatchIdx` prefers the role's `preferFaceNormal` over rank 0 (the
// footrest's default is rank 1), and restating that rule here is a copy that can drift from it.
// The driven run reads the app's own selection instead.
console.log('ranked by area, which is the order the part panel offers them.\n');
console.log(
  'part            rank      area mm²  face normal          frame tilt   faceY      cut clip mm²',
);
console.log('-'.repeat(96));
for (const r of rows) {
  const flag = r.frameTilt > 1 ? '  <-- frame off the face' : '';
  const clip = r.clipArea < 0 ? 'unbounded' : r.clipArea.toFixed(0);
  console.log(
    `${r.part.padEnd(15)} ${String(r.rank).padEnd(4)} ${r.area.toFixed(0).padStart(9)}  ` +
      `${v3(r.normal).padEnd(20)} ${r.frameTilt.toFixed(1).padStart(7)}°   ` +
      `${r.faceYFallback ? 'fallback' : 'real    '} ${clip.padStart(11)}${flag}`,
  );
}

const bad = rows.filter((r) => r.frameTilt > 1);
console.log(`\n${rows.length} patches over ${PARTS.length} parts.`);
console.log(`Any selectable patch misaligned on: ${bad.length}`);
if (bad.length) {
  const worst = bad.reduce((a, b) => (b.frameTilt > a.frameTilt ? b : a));
  console.log(`Worst: ${worst.part} rank ${worst.rank} at ${worst.frameTilt.toFixed(1)}°`);
}
