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
} from '../../../scripts/lib/mesh.mjs';

const PATCHES_SHOWN = 6;

function summarize(file, a) {
  console.log(`\n=== ${file}`);
  console.log(`  triangles   ${a.positions.length / 9}`);
  console.log(`  file size   ${(fs.statSync(file).size / 1e6).toFixed(2)} MB`);
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
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node .claude/skills/add-part/compare-meshes.mjs <a> [b]');
  process.exit(1);
}

const stats = [];
for (const f of files) {
  const a = analyze(await readMesh(f));
  summarize(f, a);
  stats.push(a);
}

if (files.length === 2) {
  const [a, b] = stats;
  const hit = findTransform(a, b);
  console.log('\n=== comparison');
  console.log(
    `  surface area differs by ${((100 * Math.abs(a.total - b.total)) / Math.max(a.total, b.total)).toFixed(3)}%`,
  );
  if (hit && hit.r.det > 0) {
    console.log(`  SAME PART — direction-spectrum overlap ${(hit.score * 100).toFixed(1)}%.`);
    console.log(`  ${files[0]} -> ${files[1]} is:`);
    console.log(`    rotate     (x, y, z) -> (${axisName(hit.r)})`);
    console.log(`    translate  (${hit.translate.map((v) => v.toFixed(3)).join(', ')})`);
    console.log(
      '\n  Pack the lower-triangle mesh with scripts/pack-part.mjs --align-to the other.',
    );
  } else if (hit) {
    console.log(`  MIRRORED, not rotated: (x, y, z) -> (${axisName(hit.r)}) has determinant -1,`);
    console.log(
      `  and it beats every rotation by a real margin (overlap ${(hit.score * 100).toFixed(1)}%).`,
    );
    console.log(
      '  These are opposite hands (left vs right). NOT interchangeable — each hand needs',
    );
    console.log('  its own mesh, its own kind, and its own verified reference pose.');
  } else {
    console.log('  NO axis-aligned rigid map found — not the same mesh in two poses. Either the');
    console.log('  part genuinely differs (revision, different variant), or the rotation is not');
    console.log('  axis-aligned. Do not assume they are interchangeable.');
  }
}
