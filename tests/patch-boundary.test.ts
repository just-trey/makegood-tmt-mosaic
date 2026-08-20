import { describe, expect, it } from 'vitest';
import { applyAsmPatchChoice } from '../src/assembly/parts';
import { detectFlatPatches } from '../src/geometry/meshparts';
import type { AssemblyPart } from '../src/types';

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

function annulusPart(): AssemblyPart {
  const positions = annulusSoup();
  const patches = detectFlatPatches(positions);
  return {
    id: 1,
    name: 'annulus',
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

describe('applyAsmPatchChoice', () => {
  it('keeps every loop of the chosen patch, not just one', () => {
    const part = annulusPart();
    applyAsmPatchChoice(part);
    expect(part.boundaryLoops).toHaveLength(2);
  });

  it('puts the face outline first even when a hole out-vertexes it', () => {
    const part = annulusPart();
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
});
