import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { boxSize, flatPatches, meshBounds, meshVolume } from '../src/geometry/mesh';
import { read3mf } from '../src/geometry/threemf-read';

const part = (f: string) => readFileSync(new URL(`../reference/parts/${f}`, import.meta.url));

describe('3mf reader', () => {
  it('reads the wheel half as one 280mm part', async () => {
    const parts = await read3mf(part('wheel-half.3mf'));
    expect(parts).toHaveLength(1);
    const size = boxSize(meshBounds(parts[0].mesh));
    expect(Math.max(...size)).toBeCloseTo(280, 0);
    expect(meshVolume(parts[0].mesh)).toBeGreaterThan(0);
  });
  it('finds a large flat design face on the footrest and wheel', async () => {
    for (const f of ['footrest.3mf', 'wheel-half.3mf']) {
      const [p] = await read3mf(part(f));
      const patches = flatPatches(p.mesh);
      expect(patches.length).toBeGreaterThan(0);
      expect(patches[0].areaMm2).toBeGreaterThan(2000);
    }
  });
});

describe('cutter slab', () => {
  it('builds a closed slab that Manifold accepts', async () => {
    const { engine, toManifold } = await import('../src/geometry/csg');
    const { buildCutter } = await import('../src/geometry/cutter');
    const { HeightSampler } = await import('../src/geometry/raycast');
    const wasm = await engine();
    // A stepped block: two heights, so the slab path (not the flat shortcut) is taken.
    const pos = new Float32Array([
      0, 0, 0, 20, 0, 0, 20, 20, 0, 0, 20, 0,
      0, 0, 5, 20, 0, 5, 20, 20, 5, 0, 20, 5,
    ]);
    const idx = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
    const step = { pos: new Float32Array([...pos, ...Array.from(pos).map((v, i) => (i % 3 === 2 ? v + 8 : i % 3 === 0 ? v + 20 : v))]), idx: new Uint32Array([...idx, ...Array.from(idx).map((v) => v + 8)]) };
    const body = toManifold(wasm, step);
    expect(body.volume()).toBeCloseTo(4000, 0);
    const sampler = new HeightSampler(step);
    const region = [[[[5, 5], [35, 5], [35, 15], [5, 15]] as [number, number][]]];
    const c = buildCutter(wasm, region, sampler, 1, 0.6);
    const inlay = body.intersect(c.manifold);
    // 30 x 10 mm at 1 mm deep across both heights.
    expect(inlay.volume()).toBeCloseTo(300, 0);
    c.manifold.delete();
  });
});
