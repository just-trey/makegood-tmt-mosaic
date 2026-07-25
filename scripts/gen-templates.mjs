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
// Shared by every `designFit: 'rect'` part (footrest, wheel mount): extract the +Y design face's
// holes and place them in the template's coordinate frame. Derivation of the inverse mapping (see
// src/geometry/assembly.ts placeOnPart, rect designFit, +Y-facing part, defaults):
//   x = -(ptx - bboxCx) + faceCx ,  z = -(pty - bboxCy) + faceCz
// so  ptx = bboxCx - (x - faceCx) ,  pty = bboxCy - (z - faceCz)
// The template canvas spans the face 1:1 in mm, so its bbox center (bboxCx, bboxCy) is the canvas
// center. faceC = center of the outer boundary loop bbox in native (x, z) — exactly what the app
// uses as the face center. Only handles a +Y-pointing design face: every rect part shipped so far
// (footrest, wheel mount) auto-detects onto one, per placeOnPart's nsign>0 branch.
// ---------------------------------------------------------------------------

/**
 * @param {string} meshFile filename in public/stl/
 * @param {string} outFile filename in public/templates/
 * @param {string} partLabel short name for log/error lines, e.g. "footrest"
 * @param {number} canvasW expected design-face width (mm) — the canvas is baked to this, not
 *   measured live, so a mesh change that shifts the face size fails loudly instead of shipping a
 *   template that no longer matches what the app cuts.
 * @param {number} canvasH expected design-face height (mm)
 * @param {number} tol max acceptable measured-vs-expected drift (mm) before refusing to write
 * @param {number} minHoleArea interior loops smaller than this (mm²) are tessellation/fillet
 *   slivers, not real holes, and are dropped
 * @param {number[]} [preferFaceNormal] the role's preferFaceNormal in src/assembly/kinds.ts, or
 *   undefined when it declares none — this MUST match the kind's role so the template is drawn for
 *   the exact patch the app's defaultPatchIdx selects
 * @param {number} [spinDeg] the kind's previewSpinDeg in src/assembly/kinds.ts (0/undefined when it
 *   declares none). The canvas is rotated by this in its own plane so it matches the spun viewport;
 *   placeOnPart applies the exact inverse, so a trace of this template still lands on the native
 *   face and the exported cut is unchanged. MUST equal the kind's previewSpinDeg.
 * @param {string} comment the template's leading XML comment, verbatim
 * @param {{x: number, y: number, text: string}[]} labels guide-text labels
 */
async function genRectTemplate({
  meshFile,
  outFile,
  partLabel,
  canvasW,
  canvasH,
  tol,
  minHoleArea,
  preferFaceNormal,
  spinDeg,
  comment,
  labels,
}) {
  const { positions } = await readSoup(stl(meshFile));
  const patches = detectFlatPatches(positions);
  // Select the exact same patch the app cuts on by replicating defaultPatchIdx (src/assembly/
  // parts.ts): with a preferFaceNormal, the first area-ranked patch whose normal dots > 0.9 with
  // it; without one, the largest patch overall (patches[0], since detectFlatPatches area-ranks).
  // Filtering to +Y ourselves (the old approach) would diverge silently from the app for a part
  // with no preferFaceNormal if a re-pack ever made a non-+Y patch the largest — the app would
  // land there while we still drew the +Y face.
  let idx;
  if (preferFaceNormal) {
    idx = patches.findIndex(
      (p) =>
        p.normal[0] * preferFaceNormal[0] +
          p.normal[1] * preferFaceNormal[1] +
          p.normal[2] * preferFaceNormal[2] >
        0.9,
    );
    if (idx < 0)
      throw new Error(
        `no patch in ${meshFile} points along preferFaceNormal (${preferFaceNormal.join(
          ', ',
        )}) — the design face is not where this script expects it`,
      );
  } else {
    idx = 0; // no preferFaceNormal: the app takes the largest-area patch
  }
  const face = patches[idx];
  // The toTpl mapping below is derived only for a +Y-facing design face (placeOnPart's nsign>0
  // branch). If the app's own selection just landed on a non-+Y patch, the template would be for a
  // face the app never cuts — fail loudly rather than ship that mismatch.
  if (!(face.normal[1] > 0.9))
    throw new Error(
      `selected design face in ${meshFile} points (${face.normal
        .map(n2)
        .join(', ')}), not +Y — the template mapping only handles a +Y-facing face`,
    );
  const loops3d = extractPatchBoundary(positions, face.triIndices);
  // Project to native (x, z) — the two axes the app uses for the rect face.
  const loopsXZ = loops3d.map((loop) => loop.map((p) => [p[0], p[2]]));
  // App keeps the max-AREA loop as the outer (src/assembly/parts.ts, via loopArea) — point count
  // is a broken proxy that a tessellation-dense internal sliver can win. shoelace on the projected
  // loop is the same measure the app's vector-area computes for a +Y face.
  loopsXZ.sort((a, b) => shoelace(b) - shoelace(a));
  const outer = loopsXZ[0];
  const ob = bbox2d(outer);
  const faceCx = (ob.minA + ob.maxA) / 2;
  const faceCz = (ob.minB + ob.maxB) / 2;
  console.log(
    `[${partLabel}] loops=${loopsXZ.length} outerPts=${outer.length} faceExtent x=${n2(
      ob.w,
    )} z=${n2(ob.h)} (expect ~${canvasW} x ${canvasH})`,
  );
  if (Math.abs(ob.w - canvasW) > tol || Math.abs(ob.h - canvasH) > tol)
    throw new Error(
      `${partLabel} face measures ${n2(ob.w)} x ${n2(ob.h)}mm but the template canvas is ` +
        `${canvasW} x ${canvasH}mm — re-verify the part and update its canvas constants before ` +
        `regenerating`,
    );

  const bboxCx = canvasW / 2;
  const bboxCy = canvasH / 2;
  const toTpl = ([x, z]) => [bboxCx - (x - faceCx), bboxCy - (z - faceCz)];
  const toD = (pts) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ') + ' Z';

  let outerPts = outer.map(toTpl);
  const holes = loopsXZ
    .slice(1)
    .map((loop) => loop.map(toTpl))
    .map((pts) => ({ pts, area: shoelace(pts) }))
    .filter((h) => h.area >= minHoleArea)
    .sort((a, b) => b.area - a.area);
  let holePts = holes.map((h) => h.pts);
  let labelPts = labels.map((l) => ({ ...l }));
  let cw = canvasW;
  let ch = canvasH;
  console.log(
    `[${partLabel}] interior holes kept=${holes.length} areas=${holes
      .map((h) => n2(h.area))
      .join(', ')}`,
  );

  // Rotate the whole canvas by the kind's previewSpinDeg so the template reads in the same
  // orientation as the spun viewport. This is exactly the rotation placeOnPart inverts (M vs M⁻¹),
  // so a trace of this template still lands on the native face — see previewSpinDeg. Re-origin to a
  // 0-based viewBox afterward (a 90° spin swaps the canvas W/H); bounds come from the outer outline.
  if (spinDeg) {
    const phi = (spinDeg * Math.PI) / 180;
    const cs = Math.cos(phi);
    const sn = Math.sin(phi);
    const rot = ([x, y]) => [
      (x - bboxCx) * cs + (y - bboxCy) * sn,
      -(x - bboxCx) * sn + (y - bboxCy) * cs,
    ];
    const rotOuter = outerPts.map(rot);
    const bb = bbox2d(rotOuter);
    const shift = ([x, y]) => [n2(x - bb.minA), n2(y - bb.minB)];
    outerPts = rotOuter.map(shift);
    holePts = holePts.map((pts) => pts.map((p) => shift(rot(p))));
    labelPts = labelPts.map((l) => {
      const [x, y] = shift(rot([l.x, l.y]));
      return { ...l, x, y };
    });
    cw = n2(bb.w);
    ch = n2(bb.h);
  } else {
    outerPts = outerPts.map(([x, y]) => [n2(x), n2(y)]);
    holePts = holePts.map((pts) => pts.map(([x, y]) => [n2(x), n2(y)]));
  }

  // Punch the interior holes out of the canvas (fill-rule evenodd) so they read as real gaps in
  // the printable silhouette — same as any notch already cut into the outer boundary. An absence
  // of material is self-explanatory, so no fill, outline, or "no print" label is needed.
  const canvasD = [outerPts, ...holePts].map(toD).join(' ');

  const labelSvg = labelPts
    .map(
      ({ x, y, text }) =>
        `  <text x="${x}" y="${y}" text-anchor="middle" font-family="sans-serif" font-size="${LABEL_SIZE}"\n` +
        `        fill="${ACCENT}">${text}</text>`,
    )
    .join('\n');

  const svg = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!--
${comment}
-->
<svg width="${cw}mm" height="${ch}mm" viewBox="0 0 ${cw} ${ch}" version="1.1"
     xmlns="http://www.w3.org/2000/svg">
  <path d="${canvasD}" fill="${GRAY}" fill-rule="evenodd" />
${labelSvg}
</svg>
`;
  writeFileSync(tpl(outFile), svg);
  console.log(`[${partLabel}] wrote ${outFile}`);
}

const FOOT_W = 266; // template canvas mm (matches the verified size already shipped)
const FOOT_H = 185;
// The canvas dimensions above are baked, but every extracted point is mapped through
// FOOT_W/2, FOOT_H/2 as the face center — so if the source mesh's face no longer measures
// FOOT_W x FOOT_H, the whole outline shifts inside a canvas still declaring the old size.
// Fail loudly instead of writing a quietly misaligned template.
const FOOT_TOL = 0.5;

function genFootrest() {
  return genRectTemplate({
    meshFile: 'footrest.3mf',
    outFile: 'footrest-template.svg',
    partLabel: 'footrest',
    canvasW: FOOT_W,
    canvasH: FOOT_H,
    tol: FOOT_TOL,
    minHoleArea: 15, // drop sliver/noise loops (< ~4x4mm)
    preferFaceNormal: [0, 1, 0], // matches the footrest role in src/assembly/kinds.ts
    comment: `  Footrest design template — true-to-size at 1:1 mm (${FOOT_W} x ${FOOT_H}mm). The grey
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
  is guide labels (ignored by the cut pipeline); no need to delete before export.`,
    labels: [
      { x: FOOT_W / 2, y: 20, text: '▴ FRONT (lip edge)' },
      { x: FOOT_W / 2, y: 150, text: 'BACK (seat-mount edge) ▾' },
    ],
  });
}

// wheel-mount-left.3mf's design face is 209.07 x 208.50mm as packed by pack-part.mjs --rotate
// "-y,-z,x" --center (Phase B) — rounded to one decimal since that's the packer's own output
// precision. One real hole survives the sliver filter: the 1673.5mm² access opening near the
// part's lower edge; three ~3.1mm² loops nearby are tessellated fillets, not through-holes, and
// are correctly dropped by the same minHoleArea threshold the footrest uses.
const MOUNT_W = 209.1;
const MOUNT_H = 208.5;
const MOUNT_TOL = 0.5;

function genWheelMountLeft() {
  return genRectTemplate({
    meshFile: 'wheel-mount-left.3mf',
    outFile: 'wheel-mount-left-template.svg',
    partLabel: 'wheel-mount-left',
    canvasW: MOUNT_W,
    canvasH: MOUNT_H,
    tol: MOUNT_TOL,
    minHoleArea: 15, // same sliver/fillet-noise threshold as the footrest
    // no preferFaceNormal: the role in src/assembly/kinds.ts declares none, so the app takes the
    // largest-area patch — the +Y assertion in genRectTemplate guards that it stays the design face
    preferFaceNormal: undefined,
    comment: `  Wheel mount (left) design template — true-to-size at 1:1 mm (${MOUNT_W} x ${MOUNT_H}mm).
  The grey shape is the mount's REAL printable design face (the app clips artwork to
  exactly this outline). Load with the Wheel mount (left) assembly kind at Scale 100%,
  Offset 0/0 and it lands centered on the face without adjustment.

  GENERATED by scripts/gen-templates.mjs from public/stl/wheel-mount-left.3mf — do not
  hand-edit; re-run "npx vite-node scripts/gen-templates.mjs" to regenerate.

  The gap punched in the grey is a real access hole — nothing prints there, so keep
  artwork clear of it.`,
    // no guide label — see genStorage: it would just restate the part name chosen in the app.
    labels: [],
  });
}

// Storage (left/right): the plate-down design face, packed +Y-up by pack-part.mjs --rotate
// (Right "y,-x,z", Left "y,x,-z") --center. Near-square ~242.7 x 251.8mm face. Mirror halves, so
// each gets its own template with the same canvas.
// Design-face outer boundary, not the part bbox: the flat contact panel is 226.97 x 183.87mm, while
// the part flares out above it to its ~242.7 x 251.8mm printed footprint. The app centers/clips
// artwork on this contact face, so the template canvas must match it.
const STORAGE_W = 226.97;
const STORAGE_H = 183.87;
const STORAGE_TOL = 0.5;

function genStorage(side) {
  return genRectTemplate({
    meshFile: `storage-${side}.3mf`,
    outFile: `storage-${side}-template.svg`,
    partLabel: `storage-${side}`,
    canvasW: STORAGE_W,
    canvasH: STORAGE_H,
    tol: STORAGE_TOL,
    minHoleArea: 15, // same sliver/fillet-noise threshold as the other rect parts
    // no preferFaceNormal: the role in src/assembly/kinds.ts declares none, so the app takes the
    // largest-area patch — the +Y assertion in genRectTemplate guards it stays the design face
    preferFaceNormal: undefined,
    spinDeg: -90, // matches previewSpinDeg on the storage roles in src/assembly/kinds.ts
    comment: `  Storage (${side}) design template — true-to-size at 1:1 mm (${STORAGE_H} x ${STORAGE_W}mm
  canvas; the design face itself is ${STORAGE_W} x ${STORAGE_H}mm, shown rotated to match the app's view).
  The grey shape is the storage panel's REAL printable design face — the flat face that
  rests on the plate (the app clips artwork to exactly this outline). Load with the
  Storage (${side}) assembly kind at Scale 100%, Offset 0/0 and it lands centered on the
  face without adjustment.

  GENERATED by scripts/gen-templates.mjs from public/stl/storage-${side}.3mf — do not
  hand-edit; re-run "npx vite-node scripts/gen-templates.mjs" to regenerate.

  Any gaps punched in the grey are real openings — nothing prints there, so keep artwork
  clear of them.`,
    // no guide label: it would just restate the part name (already chosen in the app), and the
    // -90° canvas spin drags a top-centered label onto the silhouette and off the edge.
    labels: [],
  });
}

// Wing (left/right): the design target is the wing's OUTER face, packed +Y-up by pack-part.mjs
// --rotate (Left "y,x,-z", Right "y,-x,z") --center. The face is domed, so the template covers its
// main flat region (the detected anchor patch); the cut-through inlay spreads the design across it,
// with the raised step and steep curves out of a flat projection's reach. Canvas is that region's
// measured extent.
const WING_W = 239.79;
const WING_H = 95.92;
const WING_TOL = 0.5;

function genWing(side) {
  return genRectTemplate({
    meshFile: `wing-${side}.3mf`,
    outFile: `wing-${side}-template.svg`,
    partLabel: `wing-${side}`,
    canvasW: WING_W,
    canvasH: WING_H,
    tol: WING_TOL,
    minHoleArea: 15,
    preferFaceNormal: [0, 1, 0], // matches the wing role in src/assembly/kinds.ts (outer face)
    spinDeg: -90, // matches previewSpinDeg on the wing roles in src/assembly/kinds.ts
    comment: `  Wing (${side}) design template — true-to-size at 1:1 mm (${WING_H} x ${WING_W}mm canvas;
  the design face itself is ${WING_W} x ${WING_H}mm, shown rotated to match the app's view).
  The grey shape is the main flat region of the wing's OUTER face — the face that prints
  upward. Load with the Wing (${side}) assembly kind at Scale 100%, Offset 0/0 and it lands
  centered on the face. The design is cut through onto the whole main face (not clipped to
  this outline); a raised step and the steeply-curved edges of the wing are beyond a flat
  projection's reach, so keep key detail within this region.

  GENERATED by scripts/gen-templates.mjs from public/stl/wing-${side}.3mf — do not hand-edit;
  re-run "npx vite-node scripts/gen-templates.mjs" to regenerate.

  Any gaps punched in the grey are real openings.`,
    // no guide label — see genStorage: redundant with the part name and displaced by the spin.
    labels: [],
  });
}

// ---------------------------------------------------------------------------
// Wheel: the whole cover prints, so this is a reference ring for where the
// center cap lands, not a hole. Both circles are measured — the outer disc from
// wheel-half.3mf, the cap ring from wheel-hub-cap.3mf as the max radial distance in the cap's
// broad (footprint) plane.
// ---------------------------------------------------------------------------

// wheel-half.3mf is ONE HALF of the cover: the assembly places a second copy rotated 180° about
// the Y axis through the origin (ASSEMBLY_KINDS wheel copyDefaults). So the assembled disc is
// centered on x=0,z=0 by construction, and its outer radius is the half's max radius about that
// origin — measuring about the half's own bbox center instead would give ~153mm, its diagonal
// reach.
async function wheelOuterR() {
  const { positions } = await readSoup(stl('wheel-half.3mf'));
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
  const { positions } = await readSoup(stl('wheel-hub-cap.3mf'));
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
    `[wheel] outer R=${WHEEL_C} (D=${WHEEL_D}, from wheel-half.3mf) cap ext=${ext
      .map(n2)
      .join(',')} axis=${axis} footprint R=${n2(capR)}`,
  );
  if (!(WHEEL_C > 0)) throw new Error('wheel-half.3mf gave no outer radius — check the mesh');
  if (capR >= WHEEL_C)
    throw new Error('cap footprint radius >= wheel radius — check axis detection');

  const R = n2(capR);
  const labelY = n2(WHEEL_C - R - 4); // just above the ring, clear of the dotted stroke
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"
     width="${WHEEL_D}mm" height="${WHEEL_D}mm"
     viewBox="0 0 ${WHEEL_D} ${WHEEL_D}">
  <!-- GENERATED by scripts/gen-templates.mjs. Outer disc = wheel cover footprint
       (diameter ${WHEEL_D} mm, from wheel-half.3mf + wheel-hub-cap.3mf). The whole disc
       prints; the dotted ring is a reference for where the center cap (wheel-hub-cap.3mf,
       footprint radius ${R} mm) lands — NOT a no-print hole. Re-run:
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
await genWheelMountLeft();
await genStorage('left');
await genStorage('right');
await genWing('left');
await genWing('right');
console.log('done.');
