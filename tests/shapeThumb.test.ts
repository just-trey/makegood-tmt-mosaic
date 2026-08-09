// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

// jsdom has no 2D canvas, so renderSilhouette() can't run here — everything below is either a
// pure helper or a guard that returns before the first getContext() call. The rasterizer's own
// output is checked by looking at it (stubs/thumbs/), which is the only way a 30px picture can be.
import { partMatrix, thumbKey, refreshShapeThumb } from '../src/ui/shapeThumb';
import { state } from '../src/state/store';
import { ASSEMBLY_KINDS } from '../src/assembly/kinds';
import type { AssemblyPart } from '../src/types';

function part(over: Partial<AssemblyPart> = {}): AssemblyPart {
  return {
    id: 1,
    name: 'p',
    roleId: 'r',
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    patches: null,
    patchIdx: 0,
    boundaryLoop: null,
    topZ: 0,
    baseDepth: 3,
    isDuplicateOf: null,
    pivotX: 0,
    pivotZ: 0,
    angleDeg: 0,
    loaded: true,
    cutThrough: false,
    ...over,
  } as unknown as AssemblyPart;
}

const kind = ASSEMBLY_KINDS[0];

beforeEach(() => {
  document.body.innerHTML = '<div id="shape-thumb"><svg id="glyph"></svg></div>';
  state.shapeKind = 'assembly';
  state.assembly.kindId = kind.id;
  state.assembly.parts = [part()];
});

describe('partMatrix', () => {
  it('leaves a primary part where it is', () => {
    expect([...partMatrix(10, 20, 45, false).elements]).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);
  });

  it('pivot-rotates a duplicate to its real position, matching the viewport', () => {
    // The wheel's second Top half: 180° about the hub. A point 10mm out along +X must land 10mm
    // out along −X, not on top of the original — which is what makes the two halves two shapes.
    const m = partMatrix(0, 0, 180, true);
    const p = [10, 0, 0, 1];
    const e = m.elements;
    const x = e[0] * p[0] + e[4] * p[1] + e[8] * p[2] + e[12];
    const z = e[2] * p[0] + e[6] * p[1] + e[10] * p[2] + e[14];
    expect(x).toBeCloseTo(-10, 6);
    expect(z).toBeCloseTo(0, 6);
  });

  it('rotates a duplicate about its pivot, not about the origin', () => {
    const m = partMatrix(5, 0, 180, true);
    const e = m.elements;
    const x = e[0] * 5 + e[12];
    expect(x).toBeCloseTo(5, 6); // the pivot itself is the fixed point
  });
});

describe('thumbKey', () => {
  it('is null with no part carrying a mesh, so nothing is drawn from nothing', () => {
    state.assembly.parts = [part({ positions: null })];
    expect(thumbKey()).toBeNull();
  });

  it('changes when a part is re-packed to a different triangle count', () => {
    const before = thumbKey();
    state.assembly.parts = [part({ positions: new Float32Array(18) })];
    expect(thumbKey()).not.toBe(before);
  });

  it('changes when a duplicate is posed differently', () => {
    const before = thumbKey();
    state.assembly.parts = [part({ angleDeg: 180 })];
    expect(thumbKey()).not.toBe(before);
  });

  it('is stable across calls that changed nothing, so the cache actually caches', () => {
    expect(thumbKey()).toBe(thumbKey());
  });

  // The window this guards: parts.ts sets `positions` before `loaded`, across an await. The key
  // and the render have to agree on which parts count, in BOTH directions — a part the key counts
  // and the render skips caches a thumbnail that never updates again, and a part the render draws
  // and the key ignores means it never redraws when that part changes.
  it('ignores a part with a mesh that has not finished loading, as the render does', () => {
    const one = thumbKey();
    state.assembly.parts = [part(), part({ id: 2, loaded: false })];
    expect(thumbKey()).toBe(one);
  });

  it('changes when a part the render was drawing stops being drawn', () => {
    const drawn = thumbKey();
    state.assembly.parts = [part({ loaded: false })];
    expect(thumbKey()).not.toBe(drawn);
  });
});

describe('refreshShapeThumb', () => {
  it('leaves a flat kind it did not draw alone', () => {
    // Regression: this used to clear the box, so a part finishing its load after the user switched
    // to Disc wiped the disc glyph setShapeThumb had just painted.
    state.shapeKind = 'disc';

    refreshShapeThumb();

    expect(document.querySelector('#shape-thumb #glyph')).not.toBeNull();
  });

  it('empties the box when no part has a mesh yet, rather than showing a stale one', () => {
    state.assembly.parts = [part({ positions: null })];

    refreshShapeThumb();

    expect(document.querySelector('#shape-thumb')!.innerHTML).toBe('');
  });
});
