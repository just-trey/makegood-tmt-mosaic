// Bake the chair's export placement out of a slicer-verified Bambu project into
// src/export/chairPlacement.ts.
//
// CLAUDE.md is firm that export placement is baked from a reference file whose print pose a human
// actually checked in the slicer -- never invented, derived, or read at runtime. The wheel and the
// footrest each got their handful of constants that way by hand. The chair has 15 pieces across 12
// plates, which is too many to transcribe by hand without a typo, so this script does the
// transcription and proves it landed.
//
// The reference's meshes are not the meshes the app ships: each <object> in the project is that
// part re-origined about its own centroid, with the shift recorded as source_offset_x/y/z. The app's
// public/stl/chair-*.3mf are the same geometry left in the assembled-chair frame. The two differ by
// exactly that translation -- no rotation, no mirror -- so the app-frame plate transform is
//
//     p_plate = (p_app - source_offset) * R_item + t_item
//
// with R_item/t_item the reference <item transform>. That is what gets emitted: R_item as plateR,
// and (t_item - source_offset * R_item) minus the plate's grid origin as the pre-stride fixedPos
// build3MFCombined expects. Z needs no constant -- every part rests flat on the plate, so the
// existing tz = -minZ recovers it.
//
// Nothing here is trusted on faith: every run transforms each shipped mesh by the constants about
// to be written and compares its plate-space bounding box against the reference object's own. A
// disagreement over BBOX_TOL means the shipped mesh is no longer the part the reference placed
// (a re-pack, a revision bump), and the script refuses to write rather than emit a pose that
// silently prints in the wrong orientation.
//
// The prime tower cannot come from that same reference -- it is a 1-2 filament project, so ten of
// its twelve plates carry the untouched preset default and the tower was never positioned against
// real multi-color geometry. It is baked from a second verified file instead (--towers): one of the
// four-filament exports scripts/export-chair-examples.mjs builds, after a human has dragged each
// plate's tower where it belongs and saved. Stored per plate as an offset from that plate's anchor
// part rather than as a bed coordinate, so it survives the group re-centering a different bed size
// applies -- the tower keeps its position relative to the part, which is the thing that was
// actually checked.
//
// Usage:
//   npx vite-node scripts/bake-chair-placement.mjs [<reference.3mf>] [--towers <verified.3mf>]
//                                                  [--out <file.ts>] [--tol <mm>]
import fs from 'fs';
import JSZip from 'jszip';
import { BBOX_TOL, readMesh } from './lib/mesh.mjs';

const DEFAULT_REF = 'stubs/chair-body-all-parts.3mf';
// One verified tower file per bed size that was actually checked, first one first: its deltas are
// the default and the rest contribute only where they disagree. Deliberately not the
// chair-example-*.3mf names -- those are the export script's own output and get overwritten on the
// next run, which would silently take the verified towers with them.
const DEFAULT_TOWERS = [
  'stubs/chair-tower-reference-snapmaker.3mf',
  'stubs/chair-tower-reference-a1.3mf',
];
const DEFAULT_OUT = 'src/export/chairPlacement.ts';
const USAGE =
  'usage: bake-chair-placement.mjs [<reference.3mf>] [--towers <verified.3mf>]\n' +
  '                                [--out <file.ts>] [--tol <mm>]\n' +
  `       reference defaults to ${DEFAULT_REF}, towers to ${DEFAULT_TOWERS},\n` +
  `       out to ${DEFAULT_OUT}`;

/**
 * Export display name -> library part id, for reading the tower file back. That file is one of our
 * own exports, so its <object> names are the assembly roles' `name` from src/assembly/kinds.ts, not
 * MakeGood's part codes. Every name resolved here is cross-checked against the placement row's own
 * plateR and plate before its tower is used, so a rename shows up as a hard failure, not a tower
 * silently baked against the wrong part.
 */
const PART_BY_EXPORT_NAME = {
  'Handle (left)': 'chair-handle-left',
  'Handle (right)': 'chair-handle-right',
  'Storage (left)': 'chair-storage-left',
  'Storage (right)': 'chair-storage-right',
  'Wing (left)': 'chair-wing-left',
  'Wing (right)': 'chair-wing-right',
  'Wheel mount (left)': 'chair-wheel-mount-left',
  'Wheel mount (right)': 'chair-wheel-mount-right',
  'Seat center': 'chair-seat-center',
  'Seat back (bottom)': 'chair-seat-back-bottom',
  'Seat back (top)': 'chair-seat-back-top',
};

/**
 * Reference object name fragment -> the public/stl/ part it is. Matched as a substring of the
 * <object>'s name metadata, which carries MakeGood's own part codes ("3DTMT C1 WING LEFT REV A").
 * The two caster rows have to be ordered KIT-first: the Standard names are a prefix of the Kit
 * ones ("...REV A.STEP" vs "...REV A KIT.step"), so a Standard-first scan claims both.
 */
const PART_BY_REF_NAME = [
  ['E1 CASTER MOUNT REAR LEFT REV A KIT', 'chair-caster-kit-left'],
  ['E2 CASTER MOUNT REAR RIGHT REV A KIT', 'chair-caster-kit-right'],
  ['E1 CASTER MOUNT REAR LEFT REV A', 'chair-caster-std-left'],
  ['E2 CASTER MOUNT REAR RIGHT REV A', 'chair-caster-std-right'],
  ['A1 HANDLE LEFT', 'chair-handle-left'],
  ['A2 HANDLE RIGHT', 'chair-handle-right'],
  ['B1 WHEEL MOUNT LEFT', 'chair-wheel-mount-left'],
  ['B2 WHEEL MOUNT RIGHT', 'chair-wheel-mount-right'],
  ['C1 WING LEFT', 'chair-wing-left'],
  ['C2 WING RIGHT', 'chair-wing-right'],
  ['D1 STORAGE LEFT', 'chair-storage-left'],
  ['D2 STORAGE RIGHT', 'chair-storage-right'],
  ['F SEAT BACK CENTER TOP', 'chair-seat-back-top'],
  ['G SEAT BACK CENTER BOTTOM', 'chair-seat-back-bottom'],
  ['H SEAT CENTER', 'chair-seat-center'],
];

/**
 * Per-object print overrides worth carrying across. The reference sets a few keys Bambu writes for
 * every object regardless (name, extruder, face_count); those are the export's own business, so
 * only genuine print settings are copied.
 */
const CARRY_SETTINGS = [
  'brim_type',
  'brim_width',
  'support_type',
  'support_style',
  'enable_support',
  'sparse_infill_density',
  'skin_infill_density',
  'skeleton_infill_density',
  'wall_loops',
];

/** Bambu's PartPlateList::compute_colum_count -- the logical-plate grid is square-ish, not a row. */
export function plateColumns(count) {
  const value = Math.sqrt(count);
  const rounded = Math.round(value);
  return value > rounded ? rounded + 1 : rounded;
}

function die(msg) {
  console.error(`\n  ERROR: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { ref: null, towers: null, out: DEFAULT_OUT, tol: BBOX_TOL };
  for (let i = 0; i < argv.length; i++) {
    const value = (flag) => {
      const v = argv[++i];
      if (!v || v.startsWith('--')) die(`${flag} needs a value\n  ${USAGE}`);
      return v;
    };
    if (argv[i] === '--out') out.out = value('--out');
    else if (argv[i] === '--towers') out.towers = [...(out.towers ?? []), value('--towers')];
    else if (argv[i] === '--tol') out.tol = Number(value('--tol'));
    else if (!out.ref) out.ref = argv[i];
    else die(`unexpected argument: ${argv[i]}\n  ${USAGE}`);
  }
  out.ref ??= DEFAULT_REF;
  out.towers ??= DEFAULT_TOWERS;
  if (!(out.tol > 0)) die('--tol must be a positive number of mm');
  return out;
}

/**
 * Float noise in a slicer-written rotation is an exact 0 or ±1 that went through a float multiply.
 * It arrives at two very different magnitudes -- 2.22e-16 from a single multiply, but up to ~1e-6
 * on the handles, whose pose was set by dragging a rotation gizmo rather than typing an angle. The
 * threshold has to clear the larger one, so it sits at 1e-5: an off-diagonal that small is a
 * rotation of 6e-4 degrees, which over the longest chair part is under a micron. No angle anyone
 * chose can hide below it, and snapping leaves the matrix more orthonormal than it arrived.
 */
const ROT_NOISE = 1e-5;
const snap = (v) => {
  for (const t of [0, 1, -1]) if (Math.abs(v - t) < ROT_NOISE) return t;
  return +v.toFixed(9);
};

/** p * M for a row-vector p and a row-major 3x3 -- the convention 3MF item transforms use. */
const rowMul = (p, M) => [0, 1, 2].map((k) => p[0] * M[0][k] + p[1] * M[1][k] + p[2] * M[2][k]);

function bboxOf(iter) {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (const p of iter)
    for (let k = 0; k < 3; k++) {
      if (p[k] < mn[k]) mn[k] = p[k];
      if (p[k] > mx[k]) mx[k] = p[k];
    }
  return { mn, mx };
}

/** Plate-space bbox of a triangle soup under p' = (p - offset) * R + t. */
function placedBox(soup, offset, R, t) {
  function* pts() {
    for (let i = 0; i < soup.length; i += 3) {
      const v = [soup[i] - offset[0], soup[i + 1] - offset[1], soup[i + 2] - offset[2]];
      const r = rowMul(v, R);
      yield [r[0] + t[0], r[1] + t[1], r[2] + t[2]];
    }
  }
  return bboxOf(pts());
}

const VERTEX_RE = /<vertex x="([^"]*)" y="([^"]*)" z="([^"]*)"/g;

/** Plate-space bbox of a reference <object>'s own mesh (already in the re-origined frame). */
function placedRefBox(xml, R, t) {
  function* pts() {
    for (const m of xml.matchAll(VERTEX_RE)) {
      const r = rowMul([+m[1], +m[2], +m[3]], R);
      yield [r[0] + t[0], r[1] + t[1], r[2] + t[2]];
    }
  }
  return bboxOf(pts());
}

async function readReference(file) {
  if (!fs.existsSync(file))
    die(
      `${file} not found.\n  This is the human-verified slicer project the placement is baked ` +
        `from; it lives outside the repo (stubs/ is gitignored).`,
    );
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const root = await zip.file('3D/3dmodel.model')?.async('string');
  const settings = await zip.file('Metadata/model_settings.config')?.async('string');
  if (!root || !settings) die(`${file} is not a Bambu Studio project (missing model/settings XML)`);

  // objectid -> the entry holding its mesh. A Bambu project keeps every object in its own
  // 3D/Objects/*.model and references it by p:path, which is why load3MF cannot read one directly.
  const meshPath = {};
  for (const m of root.matchAll(
    /<object id="(\d+)"[^>]*>\s*<components>\s*<component p:path="([^"]+)"/g,
  ))
    meshPath[m[1]] = m[2].replace(/^\//, '');

  const items = {};
  for (const m of root.matchAll(/<item objectid="(\d+)"[^>]*transform="([^"]+)"/g))
    items[m[1]] = m[2].trim().split(/\s+/).map(Number);

  const objects = {};
  for (const m of settings.matchAll(/<object id="(\d+)">([\s\S]*?)<\/object>/g)) {
    const body = m[2];
    const meta = {};
    for (const kv of body.matchAll(/<metadata key="([^"]+)" value="([^"]*)"\/>/g))
      meta[kv[1]] ??= kv[2]; // first wins: object-level keys precede the nested <part>'s
    const offset = ['x', 'y', 'z'].map((a) => Number(meta[`source_offset_${a}`]));
    if (offset.some((v) => !Number.isFinite(v)))
      die(
        `object ${m[1]} ("${meta.name}") has no source_offset -- cannot relate it to the app frame`,
      );
    objects[m[1]] = { name: meta.name ?? '', offset, meta };
  }

  const plateOf = {};
  let plateCount = 0;
  for (const m of settings.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
    plateCount++;
    for (const o of m[1].matchAll(/key="object_id" value="(\d+)"/g)) plateOf[o[1]] = plateCount;
  }

  return { zip, meshPath, items, objects, plateOf, plateCount };
}

const fmt = (v) => {
  const s = Number(v).toFixed(6);
  return s.replace(/\.?0+$/, '') || '0';
};

/**
 * One `objectSettings` line, or an expanded object when that would run past Prettier's printWidth.
 * The generated file is checked in and `format:check` runs over it in CI, so it has to come out of
 * here already formatted -- the casters' four infill/wall keys are what overflow.
 */
const PRINT_WIDTH = 100;
function emitSettings(settings) {
  const oneLine = `    objectSettings: { ${settings.map(([k, v]) => `${k}: '${v}'`).join(', ')} },\n`;
  if (oneLine.length - 1 <= PRINT_WIDTH) return oneLine;
  return (
    '    objectSettings: {\n' +
    settings.map(([k, v]) => `      ${k}: '${v}',\n`).join('') +
    '    },\n'
  );
}

function emit(rows, refFile, plateCount, worst, towerFiles, towers, towerBeds) {
  const entries = rows
    .map((r) => {
      const R = r.plateR.map((row) => `      [${row.map(fmt).join(', ')}],`).join('\n');
      const settings = Object.entries(r.objectSettings);
      return (
        `  '${r.partId}': {\n` +
        `    plateHint: ${r.plateHint},\n` +
        `    plateR: [\n${R}\n    ],\n` +
        `    fixedPos: { x: ${fmt(r.fixedPos.x)}, y: ${fmt(r.fixedPos.y)} },\n` +
        (r.primeTowerDelta
          ? `    primeTowerDelta: { x: ${fmt(r.primeTowerDelta.x)}, y: ${fmt(r.primeTowerDelta.y)} },\n`
          : '') +
        (r.primeTowerDeltaByPlate
          ? `    primeTowerDeltaByPlate: {\n` +
            Object.entries(r.primeTowerDeltaByPlate)
              .map(([bed, d]) => `      '${bed}': { x: ${fmt(d.x)}, y: ${fmt(d.y)} },\n`)
              .join('') +
            `    },\n`
          : '') +
        (settings.length ? emitSettings(settings) : '') +
        `  },`
      );
    })
    .join('\n');

  return `// GENERATED by scripts/bake-chair-placement.mjs -- do not hand-edit.
//
// Chair-body export placement, baked from ${refFile}: MakeGood's own Bambu Studio project for the
// complete chair, ${plateCount} plates whose part orientations, plate packing and per-part print
// overrides were checked in the slicer by a human. Same rule as FOOTREST_PLATE_R and WHEEL_TOP_POS
// in threemf.ts -- these numbers come from a file someone verified, and are never re-derived per
// printer or recomputed at export time.
//
// Keyed by library part id (not role id) because the caster roles resolve to a different mesh per
// hardware variant, and Standard and Kit sit on different plates.
//
//   plateR    the reference <item transform>'s rotation, verbatim (noise snapped to exact 0/+-1).
//             Overrides the default face-down tilt, so nsign/rotZdeg do not apply.
//   fixedPos  the matching translation, moved into the app's assembled-chair mesh frame
//             (t_item - source_offset * plateR) and made plate-local. Applied verbatim on a
//             256x256 plate -- the plate the reference was authored on -- and re-centered per
//             plate group on any other bed size by placeHintedGroup.
//   plateHint 1-based reference plate. Values are not contiguous: one caster variant is active at
//             a time, so a real export skips whichever caster plate is unused.
//   primeTowerDelta
//             where that plate's prime tower goes, as an offset from this part's placed
//             translation. Baked from four-filament exports with every plate's tower dragged into
//             place in the slicer and saved back, because the placement reference above prints in
//             one or two filaments and never had a real tower on it:
${towerFiles.map((f, i) => `//               ${f}${i ? '' : '  (default)'}`).join('\n')}
//             Held relative, not as a bed coordinate: a different bed re-centers each plate's
//             group, and the tower has to travel with the part it was checked against. Present on
//             exactly one part per plate (the plate's anchor); ${plateCount - Object.keys(towers).length} plate(s) have none and fall
//             back to threemf.ts's suggestTowerPos.
//   primeTowerDeltaByPlate
//             a bed size where that transfer did not hold and the tower had to be re-checked, keyed
//             "<w>x<d>". Verified beds: ${towerBeds.join(', ')}. Only the plates that actually
//             disagreed carry a key -- one that merely restated the default would bury the ones
//             that matter. Any other bed size uses primeTowerDelta and is unverified.
//
// Z is deliberately absent: every part rests flat on the plate in the reference (verified minZ 0),
// so build3MFCombined's tz = -minZ reproduces it exactly.
//
// Regenerate (needs both files above, neither of which is in the repo):
//   npx vite-node scripts/bake-chair-placement.mjs
// It re-verifies every shipped mesh against the reference before writing; the worst plate-space
// bounding-box disagreement at the last bake was ${worst.toFixed(3)}mm.

export interface ChairPartPlacement {
  plateHint: number;
  plateR: number[][];
  fixedPos: { x: number; y: number };
  primeTowerDelta?: { x: number; y: number };
  primeTowerDeltaByPlate?: Record<string, { x: number; y: number }>;
  objectSettings?: Record<string, string>;
}

export const CHAIR_PLACEMENT: Record<string, ChairPartPlacement> = {
${entries}
};
`;
}

/**
 * Plate size from a project's printable_area, as the span of its corners rather than the top-right
 * one. Our own exports write the area as 0x0..WxD, but Bambu Studio rewrites it to its printer
 * profile's real area when it saves -- the Snapmaker U1's is 0.5x1..270.5x271 -- and reading the
 * corner alone would then take a 270mm plate for a 270.5mm one and mis-stride the plate grid.
 */
function plateSize(printableArea) {
  const xs = printableArea.map((p) => Number(p.split('x')[0]));
  const ys = printableArea.map((p) => Number(p.split('x')[1]));
  return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
}

/**
 * Per-plate prime-tower position from a verified four-filament export, returned as a
 * `partId -> {x, y}` offset from that plate's anchor part -- the same quantity build3MFCombined
 * adds back to the anchor's placed translation.
 *
 * Single-filament plates are skipped: the slicer prints no tower there, so whatever coordinate the
 * file carries for them was never looked at, let alone verified. That is the caster plate today.
 */
async function readTowers(file, placementByPart) {
  if (!fs.existsSync(file))
    die(
      `${file} not found.\n  This is the verified prime-tower file (a four-filament export with ` +
        `each plate's tower\n  positioned by hand); it lives outside the repo. Build one with\n` +
        `  scripts/export-chair-examples.mjs, place the towers in a slicer, and save it back.`,
    );
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const model = await zip.file('3D/3dmodel.model')?.async('string');
  const settings = await zip.file('Metadata/model_settings.config')?.async('string');
  const project = await zip.file('Metadata/project_settings.config')?.async('string');
  if (!model || !settings || !project) die(`${file} is not a Bambu Studio project`);
  const proj = JSON.parse(project);

  const objects = {};
  for (const m of settings.matchAll(/<object id="(\d+)">([\s\S]*?)<\/object>/g))
    objects[m[1]] = {
      name: m[2].match(/<metadata key="name" value="([^"]*)"/)?.[1] ?? '',
      extruders: new Set(
        [...m[2].matchAll(/<metadata key="extruder" value="(\d+)"\/>/g)].map((e) => e[1]),
      ),
    };
  const items = {};
  for (const m of model.matchAll(/<item objectid="(\d+)"[^>]*transform="([^"]+)"/g))
    items[m[1]] = m[2].trim().split(/\s+/).map(Number);
  const plates = [...settings.matchAll(/<plate>([\s\S]*?)<\/plate>/g)].map((p) =>
    [...p[1].matchAll(/key="object_id" value="(\d+)"/g)].map((o) => o[1]),
  );

  const [bedW, bedD] = plateSize(proj.printable_area);
  const cols = plateColumns(plates.length);
  console.log(`\ntowers: ${file}`);
  console.log(`  ${plates.length} plates on a ${bedW}x${bedD}mm bed (${cols}-column grid)\n`);

  const bedKey = `${bedW}x${bedD}`;
  const towers = {};
  plates.forEach((ids, pi) => {
    const filaments = new Set(ids.flatMap((id) => [...objects[id].extruders]));
    const names = ids.map((id) => objects[id].name).join(' + ');
    if (filaments.size < 2) {
      console.log(`  skip plate ${String(pi + 1).padStart(2)}  ${names} (single filament)`);
      return;
    }
    const anchorId = ids[0];
    const partId = PART_BY_EXPORT_NAME[objects[anchorId].name];
    if (!partId)
      die(
        `plate ${pi + 1}'s first object is named "${objects[anchorId].name}", which is not a ` +
          `chair part.\n  PART_BY_EXPORT_NAME is out of step with the role names in ` +
          `src/assembly/kinds.ts.`,
      );
    const placement = placementByPart[partId];
    if (!placement) die(`plate ${pi + 1} anchors on ${partId}, which has no placement row`);

    // The tower file is our own export, so its parts must sit at the poses just baked. Checking the
    // rotation catches a name map that resolved to the wrong part, and a stale tower file taken
    // from before a placement change -- either would bake a tower against a translation that is
    // not the one the exporter will add it to.
    const R = [0, 1, 2].map((r) => [0, 1, 2].map((c) => snap(items[anchorId][3 * r + c])));
    const rotGap = Math.max(
      ...[0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => Math.abs(R[r][c] - placement.plateR[r][c]))),
    );
    if (rotGap > ROT_NOISE)
      die(
        `${partId} is rotated differently in ${file} than the placement being baked ` +
          `(worst element ${rotGap.toExponential(2)}).\n  The tower file predates the current ` +
          `placement -- re-export it, re-place the towers, and re-run.`,
      );

    // Undo the plate-grid stride to get the anchor's plate-local translation, which is the frame
    // wipe_tower_x/y is written in.
    const tx = items[anchorId][9] - (pi % cols) * bedW * 1.2;
    const ty = items[anchorId][10] + Math.floor(pi / cols) * bedD * 1.2;
    const tower = { x: Number(proj.wipe_tower_x[pi]), y: Number(proj.wipe_tower_y[pi]) };
    towers[partId] = { x: tower.x - tx, y: tower.y - ty };
    console.log(
      `  ok   plate ${String(pi + 1).padStart(2)}  ${partId.padEnd(26)} ` +
        `tower (${tower.x.toFixed(1)}, ${tower.y.toFixed(1)})  ` +
        `delta (${towers[partId].x.toFixed(1)}, ${towers[partId].y.toFixed(1)})`,
    );
  });
  return { bedKey, towers };
}

const args = parseArgs(process.argv.slice(2));
const ref = await readReference(args.ref);
const cols = plateColumns(ref.plateCount);

console.log(`reference: ${args.ref}`);
console.log(
  `  ${Object.keys(ref.objects).length} objects on ${ref.plateCount} plates ` +
    `(${cols}-column grid)\n`,
);

// The reference is authored on a 256x256 bed; the grid origin has to be removed with the same
// stride the exporter re-adds. Read it off the reference rather than assuming, so a reference saved
// on another bed size cannot silently shift every part by a plate.
const printableArea = JSON.parse(
  await ref.zip.file('Metadata/project_settings.config').async('string'),
).printable_area;
const [plateW, plateD] = plateSize(printableArea);
console.log(`  plate ${plateW}x${plateD}mm\n`);

const rows = [];
let worst = 0;
let worstPart = '';

for (const [fragment, partId] of PART_BY_REF_NAME) {
  const id = Object.keys(ref.objects).find((k) => ref.objects[k].name.includes(fragment));
  if (!id) die(`no object in the reference is named like "${fragment}" (expected ${partId})`);
  const { offset } = ref.objects[id];
  const T = ref.items[id];
  if (!T) die(`object ${id} ("${fragment}") has no build item -- it is not placed on any plate`);
  const plateHint = ref.plateOf[id];
  if (!plateHint) die(`object ${id} ("${fragment}") is not listed on any plate`);

  const plateR = [0, 1, 2].map((r) => [0, 1, 2].map((c) => snap(T[3 * r + c])));
  const t = [T[9], T[10], T[11]];

  // app-frame translation: the reference translation less the re-origining shift, rotated the
  // same way the mesh is
  const shift = rowMul(offset, plateR);
  const col = (plateHint - 1) % cols;
  const row = Math.floor((plateHint - 1) / cols);
  const fixedPos = {
    x: t[0] - shift[0] - col * plateW * 1.2,
    y: t[1] - shift[1] + row * plateD * 1.2,
  };

  // --- self-check: does the shipped mesh actually land where the reference's does? ---
  const soup = await readMesh(`public/stl/${partId}.3mf`);
  const got = placedBox(soup, offset, plateR, t);
  const want = placedRefBox(await ref.zip.file(ref.meshPath[id]).async('string'), plateR, t);
  const gap = Math.max(
    ...[0, 1, 2].flatMap((k) => [
      Math.abs(got.mn[k] - want.mn[k]),
      Math.abs(got.mx[k] - want.mx[k]),
    ]),
  );
  if (gap > worst) {
    worst = gap;
    worstPart = partId;
  }
  const restsFlat = Math.abs(got.mn[2]) < 1e-3;

  const status = gap <= args.tol && restsFlat ? 'ok  ' : 'FAIL';
  console.log(
    `  ${status} ${partId.padEnd(26)} plate ${String(plateHint).padStart(2)}  ` +
      `bbox ${gap.toFixed(3)}mm  minZ ${got.mn[2].toFixed(3)}`,
  );
  if (gap > args.tol)
    die(
      `${partId} is ${gap.toFixed(3)}mm out of place against the reference (tol ${args.tol}mm).\n` +
        `  The shipped mesh is no longer the part the reference placed -- re-pack it with\n` +
        `  --align-to, or re-verify the layout in the slicer and re-export the reference.`,
    );
  if (!restsFlat)
    die(
      `${partId} sits at minZ ${got.mn[2].toFixed(3)}, not on the plate.\n` +
        `  The exporter recovers Z as -minZ, which only reproduces the reference when the\n` +
        `  reference itself rests flat. This part needs an explicit Z constant.`,
    );

  const objectSettings = {};
  for (const key of CARRY_SETTINGS)
    if (ref.objects[id].meta[key] != null) objectSettings[key] = ref.objects[id].meta[key];

  rows.push({ partId, plateHint, plateR, fixedPos, objectSettings });
}

rows.sort((a, b) => a.plateHint - b.plateHint || a.partId.localeCompare(b.partId));

const byPart = Object.fromEntries(rows.map((r) => [r.partId, r]));

// The first tower file's deltas are the defaults. Every later one contributes a per-bed override
// only where it disagrees -- holding the tower relative to its part usually transfers it across bed
// sizes unchanged, and an override that merely restates the default would hide the two that don't.
const [baseFile, ...otherFiles] = args.towers;
const base = await readTowers(baseFile, byPart);
for (const [partId, delta] of Object.entries(base.towers)) byPart[partId].primeTowerDelta = delta;

/** Below this, two deltas are the same position written twice. */
const TOWER_TOL = 0.05;
const towerBeds = [base.bedKey];
for (const file of otherFiles) {
  const { bedKey, towers } = await readTowers(file, byPart);
  towerBeds.push(bedKey);
  let same = 0;
  for (const [partId, delta] of Object.entries(towers)) {
    const def = byPart[partId].primeTowerDelta;
    // An override is a disagreement with a default, so a plate the base file never gave one has
    // nothing to override -- it printed a single filament there and got no tower to verify.
    if (!def)
      die(
        `${file} has a verified tower on ${partId}'s plate, but the base file ${baseFile} does ` +
          `not.\n  The first --towers file supplies the defaults every later file overrides, so ` +
          `pass the\n  file that covers the most tower plates first -- or re-export and re-place ` +
          `${baseFile}\n  so that plate prints more than one filament there too.`,
      );
    const gap = Math.max(Math.abs(delta.x - def.x), Math.abs(delta.y - def.y));
    if (gap <= TOWER_TOL) {
      same++;
      continue;
    }
    byPart[partId].primeTowerDeltaByPlate ??= {};
    byPart[partId].primeTowerDeltaByPlate[bedKey] = delta;
    console.log(`    ${bedKey} differs by ${gap.toFixed(2)}mm on ${partId} -- baking an override`);
  }
  console.log(`    ${same} plate(s) matched the default and need no ${bedKey} override`);
}

// Every plate that prints more than one filament needs a tower, and one anchor is enough for a
// plate -- but a plate with none falls back to suggestTowerPos, which is a guess, not a verified
// position. Say which, rather than letting a partial tower file pass for a complete one.
const towerPlates = new Set(rows.filter((r) => r.primeTowerDelta).map((r) => r.plateHint));
const missing = [...new Set(rows.map((r) => r.plateHint))].filter((h) => !towerPlates.has(h));
if (missing.length)
  console.log(
    `\n  note: no verified tower on ${missing
      .map(
        (h) =>
          `plate ${h} (${rows
            .filter((r) => r.plateHint === h)
            .map((r) => r.partId)
            .join(', ')})`,
      )
      .join('; ')}\n        -- these fall back to suggestTowerPos`,
  );

fs.writeFileSync(
  args.out,
  emit(rows, args.ref, ref.plateCount, worst, args.towers, base.towers, towerBeds),
);
console.log(
  `\n  wrote ${args.out} -- ${rows.length} parts, worst disagreement ${worst.toFixed(3)}mm (${worstPart})`,
);
