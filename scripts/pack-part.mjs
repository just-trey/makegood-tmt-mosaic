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
// Writes a single inlined <object>, the only form load3MF (src/geometry/meshparts.ts) reads. It
// never has to *resolve* a <component p:path>, because every input here is either a CAD STL or
// an already-flat shipped 3MF.
//
// Usage:
//   npx vite-node scripts/pack-part.mjs <src.stl|src.3mf> [--align-to <ref.3mf>] --out <out.3mf>
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
  readMesh,
  TESSELLATION_GAP,
} from './lib/mesh.mjs';
import { soupToIndexed } from '../src/export/threemf.ts';

const USAGE =
  'usage: pack-part.mjs <src.stl|src.3mf> [--align-to <ref.3mf>] [--bbox-tol <mm>] --out <out.3mf>';

function parseArgs(argv) {
  const out = { src: null, alignTo: null, out: null, bboxTol: BBOX_TOL };
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
    else if (!out.src) out.src = argv[i];
    else die(`unexpected argument: ${argv[i]}`);
  }
  if (!out.src || !out.out) die(USAGE);
  if (!(out.bboxTol > 0)) die(`--bbox-tol must be a positive number of mm`);
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
      `(${(100 * fc.ratio).toFixed(1)}%)\n`,
  );
