// @vitest-environment jsdom
import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';

// jsdom has no 2D canvas, so renderSilhouette() can't run here — everything below is either a
// pure helper or a guard that returns before the first getContext() call. The rasterizer's own
// output is checked by looking at it (stubs/thumbs/), which is the only way a 30px picture can be.
import {
  partMatrix,
  thumbKey,
  refreshShapeThumb,
  thumbPixelSizes,
  thumbViewDir,
} from '../src/ui/shapeThumb';
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
    boundaryLoops: null,
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

describe('thumbViewDir', () => {
  const angleTo = (a: THREE.Vector3, b: THREE.Vector3) => (a.angleTo(b) * 180) / Math.PI;

  // The whole point of the angle. Face-on — which is where the viewport's opening view sits, 21°
  // off a plate kind's design face — a thick wheel and a thin hubcap are the same circle and no
  // amount of shading separates them, because a flat-on disc has no depth range to shade.
  it('looks well off the design face, so a disc shows its thickness', () => {
    const plate = thumbViewDir({} as unknown as Parameters<typeof thumbViewDir>[0]);
    expect(angleTo(plate, new THREE.Vector3(0, 1, 0))).toBeCloseTo(52.2, 1);
  });

  it('is the same angle off the front for every kind, so the thumbnails compare', () => {
    // The two families are posed by different conventions — a displayFrame kind faces −Y, a
    // plate-like kind's camera side is +Y — so equal angles off the front is what "one fixed
    // camera" can mean here. One world vector for both would show one family its back.
    const withFrame = ASSEMBLY_KINDS.find((k) => k.displayFrame)!;
    const without = ASSEMBLY_KINDS.find((k) => !k.displayFrame)!;
    expect(angleTo(thumbViewDir(withFrame), new THREE.Vector3(0, -1, 0))).toBeCloseTo(
      angleTo(thumbViewDir(without), new THREE.Vector3(0, 1, 0)),
      6,
    );
  });

  it('rises above the part rather than sitting level with it', () => {
    for (const kind of ASSEMBLY_KINDS) {
      expect(thumbViewDir(kind).z).toBeCloseTo(Math.sin(Math.PI / 6), 6);
    }
  });

  it('is a unit vector, so the depth range it projects onto is in millimetres', () => {
    for (const kind of ASSEMBLY_KINDS) expect(thumbViewDir(kind).length()).toBeCloseTo(1, 6);
  });
});

describe('thumbPixelSizes', () => {
  // The backing store half of this is also asserted on the running app
  // (scripts/check-part-thumbnails.mjs); the buffer is internal, so here is the only place it can
  // be pinned. Both were wrong in the same direction before: the buffer was a fixed 120px whatever
  // the display, so the 4x supersample it is sized for became 2.67x at dpr 1.5 — a softer edge
  // than a 1x display gets, which is backwards.
  it('sizes the backing store in device pixels, so it is drawn 1:1', () => {
    expect(thumbPixelSizes(1).out).toBe(30);
    expect(thumbPixelSizes(1.5).out).toBe(45);
    expect(thumbPixelSizes(2).out).toBe(60);
  });

  it('keeps the supersample a true 4x of the device pixels at every ratio', () => {
    for (const ratio of [1, 1.25, 1.5, 2, 3]) {
      const { out, buffer } = thumbPixelSizes(ratio);
      expect(buffer / out).toBe(4);
    }
  });

  // Clamping dpr is the undersized-backing-store bug wearing a hat: a 3x display would get 60
  // device pixels stretched across 90. The cost of not clamping is a 360px mask buffer, cached.
  it('does not clamp the ratio', () => {
    expect(thumbPixelSizes(3)).toEqual({ out: 90, buffer: 360 });
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
