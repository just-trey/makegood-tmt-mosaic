// Pack a source mesh into the compact, single-object 3MF that public/stl/ ships.
//
// Two jobs, both offline:
//   1. Re-index and DEFLATE the mesh. The shipped files were roughly 2x larger than they need
//      to be simply from unindexed vertices and verbose coordinates.
//   2. Move the mesh into the frame of the file it replaces (--align-to). Parts are never
//      recentered at load time (see asmLoadPartBuffer in src/assembly/parts.ts), so a lot of
//      hand-verified state -- FOOTREST_PLATE_R, WHEEL_TOP_POS, the wheel's pivot-at-origin
//      rotated copy, the generated footrest template -- is pinned to the current mesh poses.
//      Baking the transform into the asset keeps every one of those constants valid, which is
//      why it happens here and not at runtime.
//
// A *new* part has no predecessor to --align-to, so --rotate/--center state its frame instead.
// They compose with --align-to and run after it: align to the file carrying the verified print
// pose, then reframe that into the app's convention (design face up, centered on the origin).
//
// --weld [mm] closes hairline cracks a CAD tessellation can leave between shells, so the boolean
// engine reads the part as a solid; every pack also *reports* whether the result is a solid,
// because assembly-mode export silently drops a non-solid part (exports it uncut with a warning).
//
// Writes a single inlined <object>, the only form load3MF (src/geometry/meshparts.ts) reads. It
// never has to *resolve* a <component p:path>, because every input here is either a CAD STL or
// an already-flat shipped 3MF.
//
// Usage:
//   npx vite-node scripts/pack-part.mjs <src.stl|src.3mf> [--align-to <ref.3mf>] [--weld [mm]] --out <out.3mf>
import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';
import {
  analyze,
  applyTransform,
  axisName,
  BBOX_TOL,
  faceCoherence,
  findTransform,
  IDENTITY_MAP,
  parseAxisMap,
  readMesh,
  TESSELLATION_GAP,
} from './lib/mesh.mjs';
import { soupToIndexed } from '../src/export/threemf.ts';
import {
  getManifold,
  manifoldIsValid,
  manifoldToMeshes,
  soupToManifold,
} from '../src/geometry/manifold.ts';

// Default vertex-weld tolerance for --weld, in mm. Enough to close the hairline cracks a CAD
// tessellation can leave between shells (a few tenths of a micron) without merging genuinely
// distinct detail — 10x below any print resolution. See the manifold check below for why this
// matters: a mesh with open edges makes assembly-mode export drop the part uncut.
const WELD_TOL = 0.001;

const USAGE =
  'usage: pack-part.mjs <src.stl|src.3mf> [--align-to <ref.3mf>] [--bbox-tol <mm>]\n' +
  '                     [--rotate <x,-z,y>] [--center] [--weld [mm]] --out <out.3mf>';

function parseArgs(argv) {
  const out = {
    src: null,
    alignTo: null,
    out: null,
    bboxTol: BBOX_TOL,
    rotate: null,
    center: false,
    weld: null,
  };
  for (let i = 0; i < argv.length; i++) {
    // A flag whose value is missing must not read as "not passed": a dropped --align-to value
    // would silently skip alignment, which is the one thing this script exists to guarantee.
    const value = (flag) => {
      const v = argv[++i];
      if (!v || v.startsWith('--')) die(`${flag} needs a value\n  ${USAGE}`);
      return v;
    };
    if (argv[i] === '--align-to') out.alignTo = value('--align-to');
    else if (argv[i] === '--out') out.out = value('--out');
    else if (argv[i] === '--bbox-tol') out.bboxTol = Number(value('--bbox-tol'));
    else if (argv[i] === '--rotate') out.rotate = value('--rotate');
    else if (argv[i] === '--center') out.center = true;
    else if (argv[i] === '--weld') {
      // optional value: consume the next arg only if it's a number, else use the default
      const next = argv[i + 1];
      out.weld =
        next && !next.startsWith('--') && Number.isFinite(Number(next))
          ? Number(argv[++i])
          : WELD_TOL;
    } else if (!out.src) out.src = argv[i];
    else die(`unexpected argument: ${argv[i]}`);
  }
  if (!out.src || !out.out) die(USAGE);
  if (!(out.bboxTol > 0)) die(`--bbox-tol must be a positive number of mm`);
  if (out.weld != null && !(out.weld > 0)) die(`--weld tolerance must be a positive number of mm`);
  return out;
}

function die(msg) {
  console.error(`\n  ERROR: ${msg}\n`);
  process.exit(1);
}

const num = (v) => {
  const s = v.toFixed(4);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
};

// Weld near-coincident vertices with Manifold's own tolerance-based merge — a proper spatial
// weld, not a grid snap (a grid snap leaves cracks that straddle a cell boundary). Returns the
// repaired soup, or dies if the result still isn't a solid the boolean engine accepts. Runs the
// exact engine the app uses, so a mesh that welds clean here is guaranteed to load there.
async function weldSoup(soup, tol) {
  const wasm = await getManifold();
  const { Manifold, Mesh } = wasm;
  const triCount = soup.length / 9;
  const triVerts = new Uint32Array(triCount * 3);
  for (let i = 0; i < triCount * 3; i++) triVerts[i] = i;
  const mesh = new Mesh({ numProp: 3, vertProperties: Float32Array.from(soup), triVerts });
  mesh.tolerance = tol;
  mesh.merge();
  let man;
  try {
    man = new Manifold(mesh);
  } catch (e) {
    die(
      `--weld ${tol}mm did not close this mesh into a solid (${e.message}). Try a larger tolerance.`,
    );
  }
  if (!manifoldIsValid(man)) {
    man.delete();
    die(`--weld ${tol}mm did not close this mesh into a solid. Try a larger tolerance.`);
  }
  const out = manifoldToMeshes(man).soup;
  const genus = man.genus();
  man.delete();
  console.log(
    `  welded      tol ${tol}mm: ${triCount} -> ${out.length / 9} triangles ` +
      `(closed to a solid, genus ${genus})`,
  );
  return out;
}

// Assembly-mode export cuts pockets with a 3D boolean, which silently drops any part whose mesh
// the engine can't read as a solid (open edges from a CAD tessellation are the usual cause) —
// the part then exports uncut with only a warning. Catch that here, at pack time, rather than in
// the app. Returns a one-line status for the report.
async function manifoldStatus(soup) {
  const wasm = await getManifold();
  try {
    const man = soupToManifold(wasm, soup);
    const ok = manifoldIsValid(man);
    const genus = ok ? man.genus() : null;
    man.delete();
    return ok
      ? `valid solid (genus ${genus})`
      : `NOT a solid — the app will export this part UNCUT. Re-pack with --weld.`;
  } catch (e) {
    return `NOT readable by the boolean engine (${e.message}) — the app will export this part UNCUT. Re-pack with --weld.`;
  }
}

function buildModelXML(soup) {
  const { verts, tris } = soupToIndexed(soup);
  const v = [];
  for (let i = 0; i < verts.length; i += 3)
    v.push(`<vertex x="${num(verts[i])}" y="${num(verts[i + 1])}" z="${num(verts[i + 2])}"/>`);
  const t = [];
  for (let i = 0; i < tris.length; i += 3)
    t.push(`<triangle v1="${tris[i]}" v2="${tris[i + 1]}" v3="${tris[i + 2]}"/>`);
  return {
    xml:
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
      `<resources><object id="1" type="model"><mesh>` +
      `<vertices>${v.join('')}</vertices><triangles>${t.join('')}</triangles>` +
      `</mesh></object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></build></model>`,
    vertCount: v.length,
  };
}

async function writeThreeMF(outPath, xml) {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`,
  );
  zip.file('3D/3dmodel.model', xml);
  const buf = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
  // temp + rename so --out may legally be the same path as --align-to
  const tmp = outPath + '.tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, outPath);
  return buf.length;
}

const args = parseArgs(process.argv.slice(2));
const srcSize = fs.statSync(args.src).size;
let soup = await readMesh(args.src);
if (!soup.length) die(`${args.src} has zero triangles`);
let a = analyze(soup);

console.log(`\n  source      ${args.src}`);
console.log(`              ${soup.length / 9} triangles, ${(srcSize / 1024).toFixed(0)} KB`);

if (args.alignTo) {
  const ref = analyze(await readMesh(args.alignTo));
  const { hit, reason, bboxWorst, score } = findTransform(a, ref, args.bboxTol);
  if (!hit && reason === 'bbox')
    die(
      `no axis map lines up the bounding boxes of ${args.src} and ${args.alignTo}: the closest ` +
        `is ${bboxWorst.toFixed(3)}mm off on one axis, over the ${args.bboxTol}mm tolerance.\n` +
        (bboxWorst < TESSELLATION_GAP
          ? `  A gap that small can be a coarser tessellation clipping a curved part's extremes ` +
            `rather than a\n  different part -- if you have independent reason to believe these ` +
            `match, re-run with\n  --bbox-tol ${(bboxWorst + 0.005).toFixed(2)}. `
          : `  That is far too large to be a tessellation difference; these are different parts. `) +
        `Refusing to write.`,
    );
  if (!hit)
    die(
      `bounding boxes line up but the geometry does not (best overlap ${(score * 100).toFixed(1)}%). ` +
        `${args.src} and ${args.alignTo}\n  are not the same mesh in two poses -- likely a ` +
        `different revision or variant. Refusing to write.`,
    );
  if (hit.r.det < 0)
    die(
      `${args.src} is MIRRORED relative to ${args.alignTo} ((x, y, z) -> (${axisName(hit.r)})).\n` +
        `  That is the opposite hand, not the same part. Refusing to write.`,
    );
  soup = applyTransform(soup, hit.r, hit.translate);
  a = analyze(soup);
  const drift = [0, 1, 2].map((k) => Math.abs(a.bb.mn[k] - ref.bb.mn[k]));
  console.log(`  aligned to  ${args.alignTo} (overlap ${(hit.score * 100).toFixed(1)}%)`);
  console.log(`              rotate (x, y, z) -> (${axisName(hit.r)})`);
  console.log(`              translate ${hit.translate.map((v) => v.toFixed(3)).join(', ')}`);
  console.log(`              bbox drift ${drift.map((v) => v.toFixed(4)).join(', ')} mm`);
  if (drift.some((d) => d > args.bboxTol))
    die(
      `aligned mesh is ${Math.max(...drift).toFixed(3)}mm off the reference bbox. Refusing to write.`,
    );
}

// Reframing runs *after* alignment, so --align-to still checks drift against the reference's own
// frame while these move the result into the frame the app wants. A new part has no shipped
// predecessor to align to, so the conversion has to be stated rather than matched.
if (args.rotate) {
  let r;
  try {
    r = parseAxisMap(args.rotate);
  } catch (e) {
    die(`${e.message}\n  ${USAGE}`);
  }
  // Same rule --align-to enforces: a determinant -1 map is the opposite hand, not a pose. It must
  // not become reachable just because this flag states the map instead of deriving it.
  if (r.det < 0)
    die(
      `--rotate "${args.rotate}" is a mirror (determinant -1), not a rotation.\n` +
        `  That would emit the opposite hand of the part. Refusing to write.`,
    );
  soup = applyTransform(soup, r, [0, 0, 0]);
  a = analyze(soup);
  console.log(`  rotated     (x, y, z) -> (${axisName(r)})`);
}

if (args.center) {
  const shift = [0, 1, 2].map((k) => -(a.bb.mn[k] + a.bb.mx[k]) / 2);
  soup = applyTransform(soup, IDENTITY_MAP, shift);
  a = analyze(soup);
  console.log(`  centered    translate ${shift.map((v) => v.toFixed(3)).join(', ')}`);
}

if (args.rotate || args.center) {
  console.log(`              dims ${a.bb.size.map((v) => v.toFixed(3)).join(' x ')}`);
  console.log(
    `              bbox ${a.bb.mn.map((v) => v.toFixed(3)).join(', ')} .. ` +
      `${a.bb.mx.map((v) => v.toFixed(3)).join(', ')}`,
  );
}

// Weld last, on the final posed soup: a rigid reframe never opens or closes a crack, so welding
// before it would just have to be re-checked after. buildModelXML re-indexes the welded soup, so
// the closed vertices ship unified in the file — the app re-reads it as a solid with no runtime
// repair (parts are taken as-is; see asmLoadPartBuffer).
if (args.weld != null) {
  soup = await weldSoup(soup, args.weld);
  a = analyze(soup);
}

const { xml, vertCount } = buildModelXML(soup);
fs.mkdirSync(path.dirname(args.out), { recursive: true });
const outSize = await writeThreeMF(args.out, xml);
const fc = faceCoherence(a);

console.log(`\n  wrote       ${args.out}`);
console.log(`              ${soup.length / 9} triangles, ${vertCount} vertices`);
console.log(`              ${(outSize / 1024).toFixed(0)} KB`);
if (fc)
  console.log(
    `  design face ${fc.patchArea.toFixed(1)} of ${fc.dirArea.toFixed(1)} mm² in ONE patch ` +
      `(${(100 * fc.ratio).toFixed(1)}%)`,
  );
console.log(`  cut engine  ${await manifoldStatus(soup)}\n`);
