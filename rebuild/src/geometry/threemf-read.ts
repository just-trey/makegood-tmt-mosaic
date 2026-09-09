import JSZip from 'jszip';
import { findAll, parseXml, type XmlNode } from '../lib/xml';
import { composeAffine, IDENTITY, mergeMeshes, transformMesh, type Affine, type Mesh } from './mesh';

export interface LoadedPart {
  name: string;
  mesh: Mesh;
}

function parse3mfTransform(s: string | undefined): Affine {
  if (!s) return IDENTITY;
  const v = s.trim().split(/\s+/).map(parseFloat);
  if (v.length < 12 || v.some((x) => !Number.isFinite(x))) return IDENTITY;
  // 3MF stores a row-vector 4x3: rows are the basis vectors, last row the translation.
  return [v[0], v[3], v[6], v[9], v[1], v[4], v[7], v[10], v[2], v[5], v[8], v[11]];
}

function unitScale(unit: string | undefined): number {
  switch ((unit ?? 'millimeter').toLowerCase()) {
    case 'micron':
      return 0.001;
    case 'centimeter':
      return 10;
    case 'inch':
      return 25.4;
    case 'foot':
      return 304.8;
    case 'meter':
      return 1000;
    default:
      return 1;
  }
}

function meshFromObject(obj: XmlNode, scale: number): Mesh | null {
  const meshNode = obj.children.find((c) => c.local === 'mesh');
  if (!meshNode) return null;
  const verts = findAll(meshNode, 'vertex');
  const tris = findAll(meshNode, 'triangle');
  const pos = new Float32Array(verts.length * 3);
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i].attrs;
    pos[i * 3] = parseFloat(a.x) * scale;
    pos[i * 3 + 1] = parseFloat(a.y) * scale;
    pos[i * 3 + 2] = parseFloat(a.z) * scale;
  }
  const idx = new Uint32Array(tris.length * 3);
  for (let i = 0; i < tris.length; i++) {
    const a = tris[i].attrs;
    idx[i * 3] = parseInt(a.v1, 10);
    idx[i * 3 + 1] = parseInt(a.v2, 10);
    idx[i * 3 + 2] = parseInt(a.v3, 10);
  }
  return { pos, idx };
}

/**
 * Read every printable object of a 3MF into one mesh per build item, in the file's build frame.
 * Handles inline meshes and the split-file layout slicers write (components referencing
 * 3D/Objects/*.model through p:path).
 */
export async function read3mf(data: ArrayBuffer | Uint8Array): Promise<LoadedPart[]> {
  const zip = await JSZip.loadAsync(data);
  const rootPath = await findRootModel(zip);
  const rootXml = await zip.file(rootPath)!.async('string');
  const cache = new Map<string, Promise<XmlNode>>();
  cache.set(rootPath, Promise.resolve(parseXml(rootXml)));
  const modelOf = (path: string): Promise<XmlNode> => {
    const norm = path.replace(/^\//, '');
    let p = cache.get(norm);
    if (!p) {
      const f = zip.file(norm);
      if (!f) throw new Error(`3MF references a missing file: ${norm}`);
      p = f.async('string').then(parseXml);
      cache.set(norm, p);
    }
    return p;
  };

  const resolve = async (modelPath: string, objectId: string, xf: Affine, depth: number): Promise<Mesh[]> => {
    if (depth > 16) return [];
    const doc = await modelOf(modelPath);
    const modelNode = doc.children.find((c) => c.local === 'model');
    if (!modelNode) return [];
    const scale = unitScale(modelNode.attrs.unit);
    const resources = modelNode.children.find((c) => c.local === 'resources');
    const obj = resources?.children.find((c) => c.local === 'object' && c.attrs.id === objectId);
    if (!obj) return [];
    const own = meshFromObject(obj, scale);
    if (own) return [transformMesh(own, xf)];
    const out: Mesh[] = [];
    const comps = obj.children.find((c) => c.local === 'components');
    for (const comp of comps?.children ?? []) {
      if (comp.local !== 'component') continue;
      const pathAttr = comp.attrs['p:path'] ?? Object.entries(comp.attrs).find(([k]) => k.endsWith(':path'))?.[1];
      const sub = pathAttr ?? modelPath;
      const local = parse3mfTransform(comp.attrs.transform);
      out.push(...(await resolve(sub, comp.attrs.objectid, composeAffine(xf, local), depth + 1)));
    }
    return out;
  };

  const doc = await modelOf(rootPath);
  const modelNode = doc.children.find((c) => c.local === 'model');
  const build = modelNode?.children.find((c) => c.local === 'build');
  const parts: LoadedPart[] = [];
  for (const item of build?.children ?? []) {
    if (item.local !== 'item') continue;
    const pathAttr = item.attrs['p:path'] ?? Object.entries(item.attrs).find(([k]) => k.endsWith(':path'))?.[1];
    const meshes = await resolve(pathAttr ?? rootPath, item.attrs.objectid, parse3mfTransform(item.attrs.transform), 0);
    if (meshes.length === 0) continue;
    const merged = meshes.length === 1 ? meshes[0] : mergeMeshes(meshes);
    parts.push({ name: await nameOf(modelOf, pathAttr ?? rootPath, item.attrs.objectid), mesh: merged });
  }
  return parts;
}

async function nameOf(modelOf: (p: string) => Promise<XmlNode>, path: string, id: string): Promise<string> {
  const doc = await modelOf(path);
  const res = doc.children.find((c) => c.local === 'model')?.children.find((c) => c.local === 'resources');
  const obj = res?.children.find((c) => c.local === 'object' && c.attrs.id === id);
  return obj?.attrs.name ?? `object ${id}`;
}

async function findRootModel(zip: JSZip): Promise<string> {
  const rels = zip.file('_rels/.rels');
  if (rels) {
    const doc = parseXml(await rels.async('string'));
    for (const r of findAll(doc, 'Relationship'))
      if ((r.attrs.Type ?? '').endsWith('/3dmodel') && r.attrs.Target) return r.attrs.Target.replace(/^\//, '');
  }
  if (zip.file('3D/3dmodel.model')) return '3D/3dmodel.model';
  const any = Object.keys(zip.files).find((f) => f.endsWith('.model'));
  if (!any) throw new Error('No 3D model inside this 3MF.');
  return any;
}
