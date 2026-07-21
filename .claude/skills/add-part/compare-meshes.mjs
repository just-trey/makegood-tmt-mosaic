/**
 * Compare candidate source meshes for the same TMT part.
 *
 * You often get the same part twice — a MakerWorld / Bambu Studio download and a CAD export —
 * and have to decide which ships as geometry. They will not look alike: different axis
 * conventions, different origins, wildly different triangle counts. This prints the numbers that
 * decide it, and given two meshes it searches all 48 signed axis maps for the rigid transform
 * between them, which is what proves "same part, different pose" rather than "similar part".
 *
 * Reporting only — scripts/pack-part.mjs is what writes the chosen mesh into public/stl/.
 *
 * Usage:
 *   node .claude/skills/add-part/compare-meshes.mjs <a.stl|a.3mf> [b.stl|b.3mf]
 */
import fs from 'fs';
import {
  analyze,
  axisName,
  faceCoherence,
  findTransform,
  readMesh,
  TESSELLATION_GAP,
} from '../../../scripts/lib/mesh.mjs';

const PATCHES_SHOWN = 6;

function summarize(file, a) {
  console.log(`\n=== ${file}`);
  console.log(`  triangles   ${a.triCount}`);
  console.log(`  file size   ${(fs.statSync(file).size / 1e6).toFixed(2)} MB`);
  if (!a.list.length) {
    console.log(`  NO READABLE GEOMETRY — nothing to compare. If this is a Bambu multi-part 3MF,`);
    console.log(`  its mesh lives behind a <component p:path> that load3MF cannot resolve either.`);
    return false;
  }
  console.log(`  bbox min    ${a.bb.mn.map((v) => v.toFixed(3)).join(', ')}`);
  console.log(`  bbox max    ${a.bb.mx.map((v) => v.toFixed(3)).join(', ')}`);
  console.log(`  dims        ${a.bb.size.map((v) => v.toFixed(3)).join(' x ')}`);
  console.log(`  surface     ${a.total.toFixed(1)} mm²`);
  console.log(`  top ${PATCHES_SHOWN} flat patches (what detectFlatPatches ranks):`);
  for (const p of a.list.slice(0, PATCHES_SHOWN))
    console.log(
      `    normal [${p.normal.map((v) => v.toFixed(2).padStart(5)).join(' ')}]  ` +
        `offset ${p.offset.toFixed(2).padStart(9)}  area ${p.area.toFixed(1)} mm²`,
    );
  const fc = faceCoherence(a);
  console.log(
    `  face coherence  ${fc.patchArea.toFixed(1)} of ${fc.dirArea.toFixed(1)} mm² facing that ` +
      `direction lands in ONE patch (${(100 * fc.ratio).toFixed(1)}%)`,
  );
  return true;
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node .claude/skills/add-part/compare-meshes.mjs <a> [b]');
  process.exit(1);
}

const stats = [];
let readable = true;
for (const f of files) {
  const a = analyze(await readMesh(f));
  readable = summarize(f, a) && readable;
  stats.push(a);
}

if (files.length === 2 && readable) {
  const [a, b] = stats;
  const { hit, reason, bboxWorst, score } = findTransform(a, b);
  console.log('\n=== comparison');
  console.log(
    `  surface area differs by ${((100 * Math.abs(a.total - b.total)) / Math.max(a.total, b.total)).toFixed(3)}%`,
  );
  if (hit && hit.r.det > 0) {
    console.log(`  SAME PART — direction-spectrum overlap ${(score * 100).toFixed(1)}%.`);
    console.log(`  ${files[0]} -> ${files[1]} is:`);
    console.log(`    rotate     (x, y, z) -> (${axisName(hit.r)})`);
    console.log(`    translate  (${hit.translate.map((v) => v.toFixed(3)).join(', ')})`);
    console.log(
      '\n  Pack the lower-triangle mesh with scripts/pack-part.mjs --align-to the other.',
    );
  } else if (hit) {
    console.log(`  MIRRORED, not rotated: (x, y, z) -> (${axisName(hit.r)}) has determinant -1,`);
    console.log(
      `  and it beats every rotation by a real margin (overlap ${(score * 100).toFixed(1)}%).`,
    );
    console.log(
      '  These are opposite hands (left vs right). NOT interchangeable — each hand needs',
    );
    console.log('  its own mesh, its own kind, and its own verified reference pose.');
  } else if (reason === 'bbox' && bboxWorst < TESSELLATION_GAP) {
    console.log(`  BOUNDING BOXES DO NOT LINE UP — the closest of the 48 axis maps is still`);
    console.log(`  ${bboxWorst.toFixed(3)}mm off on one axis. A gap that small can be a genuinely`);
    console.log(
      '  different part, or just a coarser tessellation of a curved one clipping its own',
    );
    console.log(
      `  extremes; pack-part.mjs --bbox-tol ${(bboxWorst + 0.005).toFixed(2)} would accept it if you`,
    );
    console.log('  have other reasons to believe they match. Do not assume they are.');
  } else if (reason === 'bbox') {
    console.log(`  DIFFERENT PARTS — the closest of the 48 axis maps still leaves the bounding`);
    console.log(`  boxes ${bboxWorst.toFixed(1)}mm apart on one axis, far too much to be a`);
    console.log('  tessellation difference. These are not the same part in two poses.');
  } else {
    console.log(
      `  NO rigid map found — the bounding boxes line up but the geometry disagrees (best`,
    );
    console.log(
      `  overlap ${(score * 100).toFixed(1)}%). Either the part genuinely differs (revision,`,
    );
    console.log('  different variant), or the rotation is not axis-aligned. Do not assume they');
    console.log('  are interchangeable.');
  }
}
