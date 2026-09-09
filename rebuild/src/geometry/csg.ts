import Module, { type Manifold, type ManifoldToplevel } from 'manifold-3d';
import type { Mesh } from './mesh';

let top: Promise<ManifoldToplevel> | null = null;

/** The WASM engine, loaded once on first use. */
export function engine(): Promise<ManifoldToplevel> {
  if (!top)
    top = Module().then((m) => {
      m.setup();
      return m;
    });
  return top;
}

export class CsgError extends Error {}

export function toManifold(wasm: ManifoldToplevel, m: Mesh): Manifold {
  const mesh = new wasm.Mesh({ numProp: 3, vertProperties: m.pos, triVerts: m.idx });
  mesh.merge();
  const man = new wasm.Manifold(mesh);
  const st = String(man.status());
  if (st !== 'NoError' && st !== '0') {
    man.delete();
    throw new CsgError(`mesh is not a closed solid (${st})`);
  }
  return man;
}

export function fromManifold(man: Manifold): Mesh {
  const g = man.getMesh();
  if (g.numProp === 3) return { pos: new Float32Array(g.vertProperties), idx: new Uint32Array(g.triVerts) };
  const nv = g.vertProperties.length / g.numProp;
  const pos = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) pos[i * 3 + k] = g.vertProperties[i * g.numProp + k];
  return { pos, idx: new Uint32Array(g.triVerts) };
}
