import { describe, expect, it, beforeAll } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { ASSEMBLY_KINDS } from '../src/assembly/kinds';
import type { DisplayFrame } from '../src/types';
import {
  assemblyViewDir,
  displayQuaternion,
  displayQuaternionFor,
} from '../src/scene/displayFrame';
import { GRID_SPAN_MM } from '../src/scene/viewport';
import {
  analyze,
  readMesh,
  // @ts-expect-error — plain-JS tooling module, no .d.ts (run by node, not bundled)
} from '../scripts/lib/mesh.mjs';

// The viewport poses each assembly kind by its authored display frame. Nothing else in the app
// asserts scene orientation, and the failure mode is silent — a wrong frame just renders the part
// lying down — so these check the frame against the shipped meshes rather than against itself.

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const stl = (f: string): string => resolve(REPO, 'public', f);

interface Entry {
  id: string;
  name: string;
  file: string;
}
const manifest: Entry[] = JSON.parse(readFileSync(stl('stl/parts.json'), 'utf8'));
const chairEntries = manifest.filter((e) => e.id.startsWith('chair-'));

const boxes = new Map<string, { mn: number[]; mx: number[] }>();

beforeAll(async () => {
  for (const e of chairEntries) {
    const a = analyze(await readMesh(stl(e.file)));
    boxes.set(e.id, { mn: a.bb.mn, mx: a.bb.mx });
  }
}, 60000);

/** A part's bounding box in world space once posed by `q`. */
function posedBox(id: string, q: THREE.Quaternion): THREE.Box3 {
  const b = boxes.get(id)!;
  const box = new THREE.Box3();
  for (let i = 0; i < 8; i++) {
    box.expandByPoint(
      new THREE.Vector3(
        i & 1 ? b.mx[0] : b.mn[0],
        i & 2 ? b.mx[1] : b.mn[1],
        i & 4 ? b.mx[2] : b.mn[2],
      ).applyQuaternion(q),
    );
  }
  return box;
}

/** Lowest world Z a part's bounding box reaches once posed — i.e. how close it sits to the grid. */
function lowestWorldZ(id: string, q: THREE.Quaternion): number {
  return posedBox(id, q).min.z;
}

const chairKind = ASSEMBLY_KINDS.find((k) => k.id === 'chair-body')!;
const close = (v: THREE.Vector3, x: number, y: number, z: number): void => {
  expect(v.x).toBeCloseTo(x, 6);
  expect(v.y).toBeCloseTo(y, 6);
  expect(v.z).toBeCloseTo(z, 6);
};

describe('displayQuaternion', () => {
  it('turns an authored up into world up and an authored front toward the camera', () => {
    const q = displayQuaternion({ up: [0, 1, 0], front: [0, 0, 1] });
    close(new THREE.Vector3(0, 1, 0).applyQuaternion(q), 0, 0, 1);
    // −Y is where viewport.ts parks the default camera, so the front faces the opening view.
    close(new THREE.Vector3(0, 0, 1).applyQuaternion(q), 0, -1, 0);
  });

  it('re-orthogonalizes a front that is not exactly perpendicular to up', () => {
    const q = displayQuaternion({ up: [0, 1, 0], front: [0, 0.3, 1] });
    close(new THREE.Vector3(0, 1, 0).applyQuaternion(q), 0, 0, 1);
    const front = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    expect(front.angleTo(new THREE.Vector3(0, -1, 0))).toBeLessThan(0.35);
  });

  it('falls back to identity rather than NaN on a degenerate frame', () => {
    const degenerate: DisplayFrame[] = [
      { up: [0, 0, 0], front: [0, 0, 1] },
      { up: [0, 1, 0], front: [0, 0, 0] },
      { up: [0, 1, 0], front: [0, 1, 0] }, // front parallel to up
    ];
    for (const df of degenerate) {
      expect(displayQuaternion(df).equals(new THREE.Quaternion())).toBe(true);
    }
  });

  it('leaves a kind that authors no display frame untransformed', () => {
    for (const id of ['wheel', 'footrest']) {
      const kind = ASSEMBLY_KINDS.find((k) => k.id === id)!;
      expect(kind.displayFrame, `${id} must stay design-face-up`).toBeUndefined();
      expect(displayQuaternionFor(kind).equals(new THREE.Quaternion())).toBe(true);
    }
    expect(displayQuaternionFor(null).equals(new THREE.Quaternion())).toBe(true);
  });
});

describe('the chair display frame against the shipped meshes', () => {
  it('authors an up the meshes agree is the chair’s tall axis', () => {
    // Guards a re-pack that re-orients the chair: the frame would silently stop matching the part
    // and the viewport would lay it down again with nothing else to catch it.
    expect(chairKind.displayFrame, 'the chair must author a display frame').toBeDefined();
    const mn = [Infinity, Infinity, Infinity];
    const mx = [-Infinity, -Infinity, -Infinity];
    for (const b of boxes.values())
      for (let k = 0; k < 3; k++) {
        mn[k] = Math.min(mn[k], b.mn[k]);
        mx[k] = Math.max(mx[k], b.mx[k]);
      }
    const extent = mx.map((v, k) => v - mn[k]);
    const upAxis = chairKind.displayFrame!.up.findIndex((c) => c !== 0);
    // ~547mm tall vs ~380 wide — taller than it is wide, which is what "up" has to mean here.
    expect(extent[upAxis]).toBeGreaterThan(extent[0]);
  });

  it('rests the chair on its underside, not the rear face it used to lie on', () => {
    const q = displayQuaternionFor(chairKind);
    const low = (id: string): number => lowestWorldZ(id, q);
    // The wings reach lowest, then the caster and storage mounts — the pieces that actually face
    // the floor. Before the display frame the grid-resting face was the REAR (native min Z), which
    // put the storage and caster mounts down and the wings 650mm up in the air.
    const floor = low('chair-wing-left');
    for (const id of ['chair-handle-left', 'chair-seat-back-top', 'chair-seat-center'])
      expect(low(id), `${id} must sit above the chair's underside`).toBeGreaterThan(floor);
    // and the pieces that DID rest on the grid before are no longer the lowest thing
    expect(low('chair-storage-left')).toBeGreaterThan(floor);
    expect(low('chair-caster-std-left')).toBeGreaterThan(floor);
  });

  it('leaves a footprint the grid can hold, so the chair stands on the stage not past it', () => {
    // The viewport centers the posed assembly over the grid, so what matters is the footprint's
    // SIZE, not where the CAD origin happens to sit. Union of both variants — if the conservative
    // box fits, either variant does.
    const q = displayQuaternionFor(chairKind);
    const foot = new THREE.Box3();
    for (const id of boxes.keys()) foot.union(posedBox(id, q));
    const size = foot.getSize(new THREE.Vector3());
    expect(size.x, 'chair width vs grid span').toBeLessThan(GRID_SPAN_MM);
    expect(size.y, 'chair depth vs grid span').toBeLessThan(GRID_SPAN_MM);
  });

  it('points the opening camera at the front for a posed kind, at the design face otherwise', () => {
    // posed: camera on −Y, the side the authored front now faces
    expect(assemblyViewDir(chairKind, 1).y).toBeLessThan(0);
    expect(assemblyViewDir(chairKind, -1).y).toBeLessThan(0); // viewSign is irrelevant once posed
    // unposed: unchanged ±Y face-normal behaviour
    const wheel = ASSEMBLY_KINDS.find((k) => k.id === 'wheel')!;
    expect(assemblyViewDir(wheel, 1).y).toBeGreaterThan(0);
    expect(assemblyViewDir(wheel, -1).y).toBeLessThan(0);
  });
});
