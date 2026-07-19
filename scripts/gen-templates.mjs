// Generates the design templates in public/templates/ from the verified part
// meshes in public/stl/. The committed SVGs are the real artifacts; this script
// is the reproducible recipe for them (re-run when a source mesh changes).
//
//   npx vite-node scripts/gen-templates.mjs
//
// It reuses the app's geometry-critical functions (detectFlatPatches /
// extractPatchBoundary) so the extracted hole loops match what the app derives
// at runtime. The app's load3MF builds a DOMParser DOM, which is unusably slow on
// the footrest's 235k-triangle model under Node/jsdom, so we parse the 3MF's
// simple <vertex>/<triangle> XML with a fast streaming reader here instead — same
// triangle soup, feeding the same downstream geometry code.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import JSZip from 'jszip';

const { detectFlatPatches, extractPatchBoundary } = await import('../src/geometry/meshparts.ts');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const stl = (f) => resolve(REPO, 'public/stl', f);
const tpl = (f) => resolve(REPO, 'public/templates', f);

const GRAY = '#bcbcbc'; // printable-surface canvas gray (between old #808080 / #e8e8e8)
// One blue "guide ink" for every non-printing template mark (labels, hole
// outlines, the cap reference ring) — consistent across both templates. Deep
// enough to keep the small "no print" text readable on GRAY. The hole-vs-ring
// meaning is carried by fill + dash style, not colour.
const ACCENT = '#1a4f8f';
// Shared guide-label size (mm) so the footrest FRONT/BACK labels and the wheel's
// cap-ring label read as one matched set across both templates.
const LABEL_SIZE = 8;

// Fast 3MF reader: unzip 3D/3dmodel.model and scrape vertex/triangle attributes
// with a regex, producing the same flat triangle soup (Float32Array, 9 floats
// per triangle) that meshparts.load3MF yields.
async function readSoup(path) {
  const zip = await JSZip.loadAsync(readFileSync(path));
  const xml = await zip.file('3D/3dmodel.model').async('string');
  const verts = [];
  const vRe = /<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/g;
  for (let m; (m = vRe.exec(xml));) verts.push([+m[1], +m[2], +m[3]]);
  const tris = [];
  const tRe = /<triangle\s+v1="([^"]+)"\s+v2="([^"]+)"\s+v3="([^"]+)"/g;
  for (let m; (m = tRe.exec(xml));) tris.push([+m[1], +m[2], +m[3]]);
  const positions = new Float32Array(tris.length * 9);
  tris.forEach((t, i) => {
    for (let k = 0; k < 3; k++) {
      const v = verts[t[k]];
      positions[i * 9 + k * 3] = v[0];
      positions[i * 9 + k * 3 + 1] = v[1];
      positions[i * 9 + k * 3 + 2] = v[2];
    }
  });
  return { positions, triCount: tris.length };
}

function bbox2d(pts) {
  let minA = Infinity,
    maxA = -Infinity,
    minB = Infinity,
    maxB = -Infinity;
  for (const [a, b] of pts) {
    if (a < minA) minA = a;
    if (a > maxA) maxA = a;
    if (b < minB) minB = b;
    if (b > maxB) maxB = b;
  }
  return { minA, maxA, minB, maxB, w: maxA - minA, h: maxB - minB };
}

function shoelace(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

const n2 = (v) => Number(v.toFixed(2));

// ---------------------------------------------------------------------------
// Footrest: extract the +Y seat face's holes and place them in the template's
// coordinate frame. Derivation of the inverse mapping (see src/geometry/
// assembly.ts placeOnPart, footrest = rect face, +Y normal, defaults):
//   x = -(ptx - bboxCx) + faceCx ,  z = -(pty - bboxCy) + faceCz
// so  ptx = bboxCx - (x - faceCx) ,  pty = bboxCy - (z - faceCz)
// The template canvas spans the face 1:1 in mm, so its bbox center (bboxCx,
// bboxCy) is the canvas center. faceC = center of the outer boundary loop bbox
// in native (x, z) — exactly what the app uses as the face center.
// ---------------------------------------------------------------------------
const FOOT_W = 266; // template canvas mm (matches the verified size already shipped)
const FOOT_H = 185;
// The canvas dimensions above are baked, but every extracted point is mapped through
// FOOT_W/2, FOOT_H/2 as the face center — so if the source mesh's face no longer measures
// FOOT_W x FOOT_H, the whole outline shifts inside a canvas still declaring the old size.
// Fail loudly instead of writing a quietly misaligned template.
const FOOT_TOL = 0.5;

async function genFootrest() {
  const { positions } = await readSoup(stl('footrest.3mf'));
  const patches = detectFlatPatches(positions);
  // Seat design face = the dominant +Y-facing flat patch. Match the app's own selection test
  // (defaultPatchIdx in src/assembly/parts.ts: first area-ranked patch with dot > 0.9 against the
  // role's preferFaceNormal [0,1,0]) — a stricter threshold here would silently pick a different
  // face than the app cuts on, or none at all, if the seat ever gets a slight draft. Its outer
  // boundary is the real printable outline the app clips artwork to — NOT a plain rectangle: the
  // BACK edge carries the mounting slots and the FRONT edge is the curved-lip transition.
  const up = patches.filter((p) => p.normal[1] > 0.9);
  if (!up.length)
    throw new Error(
      `no +Y-facing flat patch in footrest.3mf (best normal.y=${n2(
        Math.max(...patches.map((p) => p.normal[1])),
      )}) — the seat face is not where this script expects it`,
    );
  const loops3d = extractPatchBoundary(positions, up[0].triIndices);
  // Project to native (x, z) — the two axes the app uses for the rect face.
  const loopsXZ = loops3d.map((loop) => loop.map((p) => [p[0], p[2]]));
  loopsXZ.sort((a, b) => b.length - a.length); // app keeps loops[0] (most points) as the outer
  const outer = loopsXZ[0];
  const ob = bbox2d(outer);
  const faceCx = (ob.minA + ob.maxA) / 2;
  const faceCz = (ob.minB + ob.maxB) / 2;
  console.log(
    `[footrest] loops=${loopsXZ.length} outerPts=${outer.length} faceExtent x=${n2(ob.w)} z=${n2(
      ob.h,
    )} (expect ~${FOOT_W} x ${FOOT_H})`,
  );
  if (Math.abs(ob.w - FOOT_W) > FOOT_TOL || Math.abs(ob.h - FOOT_H) > FOOT_TOL)
    throw new Error(
      `footrest face measures ${n2(ob.w)} x ${n2(ob.h)}mm but the template canvas is ` +
        `${FOOT_W} x ${FOOT_H}mm — re-verify the part and update FOOT_W/FOOT_H before regenerating`,
    );

  const bboxCx = FOOT_W / 2;
  const bboxCy = FOOT_H / 2;
  const toTpl = ([x, z]) => [n2(bboxCx - (x - faceCx)), n2(bboxCy - (z - faceCz))];
  const toD = (pts) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ') + ' Z';

  const holes = loopsXZ
    .slice(1)
    .map((loop) => loop.map(toTpl))
    .map((pts) => ({ pts, area: shoelace(pts) }))
    .filter((h) => h.area >= 15) // drop sliver/noise loops (< ~4x4mm)
    .sort((a, b) => b.area - a.area);
  console.log(
    `[footrest] interior holes kept=${holes.length} areas=${holes
      .map((h) => n2(h.area))
      .join(', ')}`,
  );

  // Punch the interior holes out of the canvas (fill-rule evenodd) so they read
  // as real gaps in the printable silhouette — the same way the two BACK-corner
  // slots are already notches in the outer boundary. All four mounting slots then
  // look identical; an absence of material is self-explanatory, so no fill,
  // outline, or "no print" label is needed.
  const canvasD = [outer.map(toTpl), ...holes.map((h) => h.pts)].map(toD).join(' ');

  const svg = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!--
  Footrest design template — true-to-size at 1:1 mm (${FOOT_W} x ${FOOT_H}mm). The grey
  shape is the footrest's REAL printable design face (the app clips artwork to exactly
  this outline). Load with the Footrest assembly kind at Scale 100%, Offset 0/0 and it
  lands centered on the face without adjustment.

  GENERATED by scripts/gen-templates.mjs from public/stl/footrest.3mf — do not
  hand-edit; re-run "npx vite-node scripts/gen-templates.mjs" to regenerate.

  Orientation: BACK is the seat-mount edge (carries the 4 mounting slots — two
  through-holes plus the two notches in the BACK corners; all read as gaps in the
  grey); FRONT is the curved-lip edge. If your finished design prints mirrored
  front-to-back, toggle "Flip V" in the Fit panel.

  Grey = printable surface. The gaps punched in it (the four mounting slots) are
  real holes — nothing prints there, so keep artwork clear of them. All blue text
  is guide labels (ignored by the cut pipeline); no need to delete before export.
-->
<svg width="${FOOT_W}mm" height="${FOOT_H}mm" viewBox="0 0 ${FOOT_W} ${FOOT_H}" version="1.1"
     xmlns="http://www.w3.org/2000/svg">
  <path d="${canvasD}" fill="${GRAY}" fill-rule="evenodd" />
  <text x="${FOOT_W / 2}" y="20" text-anchor="middle" font-family="sans-serif" font-size="${LABEL_SIZE}"
        fill="${ACCENT}">▴ FRONT (lip edge)</text>
  <text x="${FOOT_W / 2}" y="150" text-anchor="middle" font-family="sans-serif" font-size="${LABEL_SIZE}"
        fill="${ACCENT}">BACK (seat-mount edge) ▾</text>
</svg>
`;
  writeFileSync(tpl('footrest-template.svg'), svg);
  console.log('[footrest] wrote footrest-template.svg');
}

// ---------------------------------------------------------------------------
// Wheel: the whole cover prints, so this is a reference ring for where the
// center cap lands, not a hole. Both circles are measured — the outer disc from
// top.3mf, the cap ring from cap.3mf as the max radial distance in the cap's
// broad (footprint) plane.
// ---------------------------------------------------------------------------

// top.3mf is ONE HALF of the cover: the assembly places a second copy rotated 180° about the Y
// axis through the origin (ASSEMBLY_KINDS wheel copyDefaults). So the assembled disc is centered
// on x=0,z=0 by construction, and its outer radius is the half's max radius about that origin —
// measuring about the half's own bbox center instead would give ~153mm, its diagonal reach.
async function wheelOuterR() {
  const { positions } = await readSoup(stl('top.3mf'));
  let r = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const d = Math.hypot(positions[i], positions[i + 2]);
    if (d > r) r = d;
  }
  return r;
}

async function genWheel() {
  const WHEEL_C = n2(await wheelOuterR());
  const WHEEL_D = n2(WHEEL_C * 2);
  const { positions } = await readSoup(stl('cap.3mf'));
  // Find the thin (axis) dimension; the other two axes are the footprint plane.
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  const ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const axis = ext.indexOf(Math.min(...ext)); // thickness axis
  const planeAxes = [0, 1, 2].filter((k) => k !== axis);
  const c = planeAxes.map((k) => (min[k] + max[k]) / 2);
  let capR = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const a = positions[i + planeAxes[0]] - c[0];
    const b = positions[i + planeAxes[1]] - c[1];
    const r = Math.hypot(a, b);
    if (r > capR) capR = r;
  }
  console.log(
    `[wheel] outer R=${WHEEL_C} (D=${WHEEL_D}, from top.3mf) cap ext=${ext
      .map(n2)
      .join(',')} axis=${axis} footprint R=${n2(capR)}`,
  );
  if (!(WHEEL_C > 0)) throw new Error('top.3mf gave no outer radius — check the mesh');
  if (capR >= WHEEL_C)
    throw new Error('cap footprint radius >= wheel radius — check axis detection');

  const R = n2(capR);
  const labelY = n2(WHEEL_C - R - 4); // just above the ring, clear of the dotted stroke
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"
     width="${WHEEL_D}mm" height="${WHEEL_D}mm"
     viewBox="0 0 ${WHEEL_D} ${WHEEL_D}">
  <!-- GENERATED by scripts/gen-templates.mjs. Outer disc = wheel cover footprint
       (diameter ${WHEEL_D} mm, from top.3mf + cap.3mf). The whole disc prints; the
       dotted ring is a reference for where the center cap (cap.3mf, footprint
       radius ${R} mm) lands — NOT a no-print hole. Re-run:
       npx vite-node scripts/gen-templates.mjs -->
  <circle cx="${WHEEL_C}" cy="${WHEEL_C}" r="${WHEEL_C}" fill="${GRAY}"/>
  <circle cx="${WHEEL_C}" cy="${WHEEL_C}" r="${R}" fill="none" stroke="${ACCENT}"
          stroke-width="1" stroke-linecap="round" stroke-dasharray="0.5 4"/>
  <text x="${WHEEL_C}" y="${labelY}" text-anchor="middle" font-family="sans-serif"
        font-size="${LABEL_SIZE}" fill="${ACCENT}">center cap — prints</text>
</svg>
`;
  writeFileSync(tpl('wheel-cover-circle.svg'), svg);
  console.log('[wheel] wrote wheel-cover-circle.svg');
}

await genFootrest();
await genWheel();
console.log('done.');
