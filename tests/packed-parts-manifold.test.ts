import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { getManifold, soupToManifold } from '../src/geometry/manifold';
import type { LibraryEntry } from '../src/types';
import {
  read3MFIndexed,
  // @ts-expect-error — plain-JS tooling module, no .d.ts (run by node, not bundled)
} from '../scripts/lib/zonebake.mjs';

// Every shipped part must survive the boolean engine, because a part Manifold rejects can't be cut
// at all — the build warns and exports it uncut, which is easy to miss until someone actually
// places artwork on that piece. chair-storage-left/right shipped in exactly that state: watertight
// in CAD, but packed at 1e-4mm coordinate precision, which welded distinct vertices together and
// made the mesh non-manifold (see the `num` comment in scripts/pack-part.mjs). Detecting flat
// patches and loading the mesh both still worked, so nothing else caught it.

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const library: LibraryEntry[] = JSON.parse(
  readFileSync(resolve(REPO, 'public/stl/parts.json'), 'utf8'),
);

describe('every packed library part is a solid the boolean engine accepts', () => {
  it.each(library.map((e) => [e.id, e.file] as const))(
    '%s',
    async (_id, file) => {
      const mesh = await read3MFIndexed(readFileSync(resolve(REPO, 'public', file)));
      const soup = new Float32Array(mesh.tris.length * 9);
      mesh.tris.forEach((t: number[], i: number) => {
        t.forEach((vi, k) => soup.set(mesh.verts[vi], i * 9 + k * 3));
      });
      const wasm = await getManifold();
      const man = soupToManifold(wasm, soup);
      expect(man.numTri()).toBeGreaterThan(0);
      expect(man.volume()).toBeGreaterThan(0);
      man.delete();
    },
    60000,
  );
});
