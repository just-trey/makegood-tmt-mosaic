/**
 * Reading a zone config's parts, shared by the measurement scripts that run off a shipped sidecar.
 * The bake library itself never touches the filesystem — scripts/bake-zones.mjs hands it meshes —
 * so this lives beside it rather than in it.
 */
import fs from 'fs';
import path from 'path';
import { read3MFIndexed } from './zonebake.mjs';

/**
 * `vertsOf(libraryPartId)` over a config's parts: the packed vertex list in file order, which is
 * the order a sidecar chart's `verts` indexes into. Refuses a part the config does not list rather
 * than returning undefined, since every caller here is about to index it.
 */
export async function configPartVerts(config, repo) {
  const verts = new Map();
  for (const p of config.parts) {
    const mesh = await read3MFIndexed(fs.readFileSync(path.resolve(repo, p.file)));
    verts.set(p.libraryPartId, mesh.verts);
  }
  return (id) => {
    const v = verts.get(id);
    if (!v) throw new Error(`sidecar chart names part "${id}", which the config does not list`);
    return v;
  };
}
