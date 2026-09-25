import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

vi.mock('../src/app/scheduler', () => ({ scheduleRebuild: vi.fn() }));
vi.mock('../src/scene/viewport', () => ({ requestFrame: vi.fn() }));

import { ASSEMBLY_KINDS } from '../src/assembly/kinds';
import { applyAsmPatchChoice, asmRemovePart } from '../src/assembly/parts';
import { state } from '../src/state/store';
import { detectFlatPatches, extractPatchBoundary, loopXZArea } from '../src/geometry/meshparts';
import { WARNINGS, clearWarnings } from '../src/warnings';
import type { AssemblyPart, LibraryEntry } from '../src/types';
import {
  read3MFIndexed,
  // @ts-expect-error — plain-JS tooling module, no .d.ts (run by node, not bundled)
} from '../scripts/lib/zonebake.mjs';

/**
 * A flat annulus at y=10: a coarse outer ring and a finely tessellated hole. The hole carries
 * eight times the outline's vertices, which is the input that decides whether "which loop is the
 * face" is answered by size or by point count.
 */
function annulusSoup(outerR = 20, innerR = 5, outerN = 8, innerN = 64): Float32Array {
  const at = (r: number, n: number, i: number): number[] => {
    const t = (2 * Math.PI * (i % n)) / n;
    return [r * Math.cos(t), 10, r * Math.sin(t)];
  };
  const tris: number[][] = [];
  let oi = 0,
    ii = 0;
  while (oi < outerN || ii < innerN) {
    // advance whichever ring is behind in angle, so the strip never self-overlaps
    if (ii === innerN || (oi < outerN && oi / outerN <= ii / innerN)) {
      tris.push(
        [at(outerR, outerN, oi), at(outerR, outerN, oi + 1), at(innerR, innerN, ii)].flat(),
      );
      oi++;
    } else {
      tris.push(
        [at(outerR, outerN, oi), at(innerR, innerN, ii + 1), at(innerR, innerN, ii)].flat(),
      );
      ii++;
    }
  }
  return Float32Array.from(tris.flat());
}

function partOf(name: string, positions: Float32Array): AssemblyPart {
  const patches = detectFlatPatches(positions);
  return {
    id: 1,
    name,
    roleId: 'role',
    positions,
    patches,
    patchIdx: patches.findIndex((p) => p.normal[1] > 0.9 || p.normal[1] < -0.9),
    boundaryLoops: null,
    topZ: 10,
    baseDepth: 0,
    isDuplicateOf: null,
    pivotX: 0,
    pivotZ: 0,
    angleDeg: 0,
    loaded: true,
    cutThrough: false,
  };
}

/** Triangles in the y=10 plane from (x, z) corners, wound so every one shares a normal. */
function flatSoup(tris: number[][][]): Float32Array {
  return Float32Array.from(tris.flatMap((t) => t.flatMap(([x, z]) => [x, 10, z])));
}

/** Every directed edge of the soup, keyed the way extractPatchBoundary keys vertices. */
function edgeSet(soup: Float32Array): Set<string> {
  const k = (o: number) => [soup[o], soup[o + 1], soup[o + 2]].map((v) => v.toFixed(4)).join(',');
  const out = new Set<string>();
  for (let o = 0; o < soup.length; o += 9)
    for (let e = 0; e < 3; e++) out.add(k(o + e * 3) + '|' + k(o + ((e + 1) % 3) * 3));
  return out;
}

/** A ring closes when every step, last→first included, runs along a triangle edge. */
function isClosedRing(loop: number[][], edges: Set<string>): boolean {
  const k = (p: number[]) => p.map((v) => v.toFixed(4)).join(',');
  return loop.every((p, i) => edges.has(k(p) + '|' + k(loop[(i + 1) % loop.length])));
}

/**
 * Two triangles stacked on one edge with the same winding. The shared edge has no reverse, so one
 * vertex has two outgoing boundary edges for one incoming: one triangle can close, the other's
 * two free edges cannot.
 */
function stackedSoup(): Float32Array {
  return flatSoup([
    [
      [0, 0],
      [4, 0],
      [2, 3],
    ],
    [
      [0, 0],
      [4, 0],
      [2, 1],
    ],
  ]);
}

describe('applyAsmPatchChoice', () => {
  beforeEach(() => clearWarnings());

  it('keeps every loop of the chosen patch, not just one', () => {
    const part = partOf('annulus', annulusSoup());
    applyAsmPatchChoice(part);
    expect(part.boundaryLoops).toHaveLength(2);
  });

  it('puts the face outline first even when a hole out-vertexes it', () => {
    const part = partOf('annulus', annulusSoup());
    applyAsmPatchChoice(part);
    const [outline, hole] = part.boundaryLoops!;
    // The outline is the 8-point ring; sorting by point count would have taken the 64-point hole
    // and clipped the artwork to the inside of the gap instead of to the face.
    expect(outline).toHaveLength(8);
    expect(hole).toHaveLength(64);
    const radius = (loop: number[][]): number => Math.hypot(loop[0][0], loop[0][2]);
    expect(radius(outline)).toBeCloseTo(20);
    expect(radius(hole)).toBeCloseTo(5);
  });

  it('warns when part of the face edge could not be traced, and retracts it on a clean pick', () => {
    // The stacked pair at y=10 plus a clean triangle at y=0, so the part has a face to switch to.
    const bad = stackedSoup();
    const clean = Float32Array.from([0, 0, 0, 0, 0, 4, 4, 0, 0]);
    const positions = new Float32Array(bad.length + clean.length);
    positions.set(bad);
    positions.set(clean, bad.length);
    const part = partOf('stacked', positions);
    const badIdx = part.patches!.findIndex((p) => Math.abs(p.offset) > 5);
    part.patchIdx = badIdx;
    applyAsmPatchChoice(part);
    expect(part.boundaryLoops).toHaveLength(1);
    expect(WARNINGS).toHaveLength(1);
    expect(WARNINGS[0].level).toBe('warn');
    expect(WARNINGS[0].message).toMatch(/"stacked"/);

    part.patchIdx = badIdx === 0 ? 1 : 0;
    applyAsmPatchChoice(part);
    expect(WARNINGS).toHaveLength(0);
  });

  it('says the part will get no artwork when no ring closes at all', () => {
    // Two corners 0.01 µm apart weld to one key, so the sliver's three edges all cancel and the
    // patch has no boundary edge left: the build skips a part with no rings, which used to happen
    // in silence.
    const part = partOf(
      'sliver',
      flatSoup([
        [
          [0, 0],
          [0.00001, 0],
          [0, 10],
        ],
      ]),
    );
    applyAsmPatchChoice(part);
    expect(part.boundaryLoops).toBeNull();
    expect(WARNINGS).toHaveLength(1);
    expect(WARNINGS[0].message).toMatch(/"sliver", so no artwork will be cut on it/);
  });

  it('retracts the warning when the part leaves the assembly', () => {
    const part = partOf('stacked', stackedSoup());
    state.assembly.parts = [part];
    applyAsmPatchChoice(part);
    expect(WARNINGS).toHaveLength(1);

    asmRemovePart(part.id);
    expect(state.assembly.parts).toEqual([]);
    expect(WARNINGS).toHaveLength(0);
  });
});

describe('extractPatchBoundary at a pinch vertex', () => {
  it('separates two islands that touch at one point into two closed rings', () => {
    const soup = flatSoup([
      [
        [-2, -1],
        [0, 0],
        [-2, 1],
      ],
      [
        [2, 1],
        [0, 0],
        [2, -1],
      ],
    ]);
    const { loops, openEdges } = extractPatchBoundary(soup, [0, 1]);
    expect(openEdges).toBe(0);
    expect(loops).toHaveLength(2);
    const edges = edgeSet(soup);
    for (const loop of loops) {
      expect(loop).toHaveLength(3);
      expect(isClosedRing(loop, edges)).toBe(true);
    }
  });

  it('walks a hole that touches the outline as rings enclosing exactly the face', () => {
    // A 4x4 square minus a diamond whose apex T sits on the top edge. Every triangle is CCW.
    const A = [-2, -2],
      B = [2, -2],
      C = [2, 2],
      T = [0, 2],
      D = [-2, 2],
      R = [1, 1],
      Bt = [0, 0],
      Lf = [-1, 1];
    const soup = flatSoup([
      [A, B, Bt],
      [B, R, Bt],
      [B, C, R],
      [C, T, R],
      [T, D, Lf],
      [D, A, Lf],
      [A, Bt, Lf],
    ]);
    const { loops, openEdges } = extractPatchBoundary(soup, [0, 1, 2, 3, 4, 5, 6]);
    expect(openEdges).toBe(0);
    const edges = edgeSet(soup);
    for (const loop of loops) expect(isClosedRing(loop, edges)).toBe(true);
    // Nine boundary edges: none lost, none repeated.
    expect(loops.reduce((n, l) => n + l.length, 0)).toBe(9);
    // One keyhole ring or an outline plus a hole: either way the loops enclose the square (16)
    // minus the diamond (2). A truncated chain read as a hole encloses something else.
    const areas = loops.map(loopXZArea).sort((a, b) => b - a);
    const enclosed = loops.length === 1 ? areas[0] : areas[0] - areas[1];
    expect(enclosed).toBeCloseTo(14, 6);
  });

  it('reports the edges no ring can take instead of returning a chain as a ring', () => {
    const soup = stackedSoup();
    const { loops, openEdges } = extractPatchBoundary(soup, [0, 1]);
    expect(loops).toHaveLength(1);
    expect(isClosedRing(loops[0], edgeSet(soup))).toBe(true);
    expect(openEdges).toBe(2);
  });
});

// Every face the Advanced dropdown offers (the first six patches) of every packed part must trace
// as closed rings only. Measured before the directed-edge walk: 19 of 114 carried a chain that
// did not close (all chair pieces plus wheel-half's -Y back), each returned as if it were a ring.
const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const library: LibraryEntry[] = JSON.parse(
  readFileSync(resolve(REPO, 'public/stl/parts.json'), 'utf8'),
);

describe('every selectable face of every packed part traces as closed rings', () => {
  it.each(library.map((e) => [e.id, e.file] as const))(
    '%s',
    async (_id, file) => {
      const mesh = await read3MFIndexed(readFileSync(resolve(REPO, 'public', file)));
      const soup = new Float32Array(mesh.tris.length * 9);
      mesh.tris.forEach((t: number[], i: number) => {
        t.forEach((vi, k) => soup.set(mesh.verts[vi], i * 9 + k * 3));
      });
      const edges = edgeSet(soup);
      const all = detectFlatPatches(soup);
      // The dropdown's six, plus the face a role's preferFaceNormal lands on: defaultPatchIdx
      // (src/assembly/parts.ts) and scripts/gen-templates.mjs both search the whole ranked list
      // for it, so it can sit past the six the dropdown shows.
      const preferred = ASSEMBLY_KINDS.flatMap((k) => k.roles)
        .filter((r) => r.libraryPartId === _id && r.preferFaceNormal)
        .map((r) => {
          const [nx, ny, nz] = r.preferFaceNormal!;
          return all.findIndex((p) => p.normal[0] * nx + p.normal[1] * ny + p.normal[2] * nz > 0.9);
        })
        .filter((i) => i >= 6);
      const patches = all.slice(0, 6).concat(preferred.map((i) => all[i]));
      const traced = patches.map((p) => extractPatchBoundary(soup, p.triIndices));
      expect(traced.map((t) => t.openEdges)).toEqual(patches.map(() => 0));
      for (const { loops } of traced) {
        expect(loops.length).toBeGreaterThan(0);
        for (const loop of loops) expect(isClosedRing(loop, edges)).toBe(true);
      }
    },
    60000,
  );
});
