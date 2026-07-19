import * as THREE from 'three';
import type { AssemblyBuild } from '../types';
import { baseColorHex, currentBaseParams, state } from '../state/store';
import { buildGeometry, featureToShapes, footprintFeature, type FlatBuild } from '../geometry/flat';
import {
  asmPartFaceNormal,
  asmPartTransformGroup,
  buildAssemblyGeometry,
} from '../geometry/assembly';
import { currentAssemblyKind } from '../assembly/kinds';
import {
  frameModelIfPending,
  getModelGroup,
  newModelGroup,
  refreshModelShadows,
  setPreferredViewDir,
} from '../scene/viewport';
import { renderColorList, type ColorListEntry } from '../ui/colorList';
import { renderBaseColorSwatches } from '../ui/partPanel';
import { renderWarnings } from '../ui/warningsView';
import { $ } from '../ui/dom';

let lastBuild: FlatBuild | null = null;
let lastAssemblyBuild: AssemblyBuild | null = null;

export function getLastBuild(): FlatBuild | null {
  return lastBuild;
}
export function getLastAssemblyBuild(): AssemblyBuild | null {
  return lastAssemblyBuild;
}

export function bufferGeometryFromTris(float32arr: Float32Array): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(float32arr, 3));
  geo.computeVertexNormals();
  return geo;
}

function updateTriStat(): void {
  let tris = 0;
  getModelGroup().traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) tris += mesh.geometry.attributes.position.count / 3;
  });
  $('#stat-tris').textContent = Math.round(tris) + ' tris';
}

function setExportEnabled(enabled: boolean): void {
  $<HTMLButtonElement>('#btn-export').disabled = !enabled;
  $<HTMLButtonElement>('#btn-export-stl').disabled = !enabled;
}

/**
 * Assembly rebuilds do 3D boolean CSG per part and are always heavy enough (hundreds of
 * ms) to warrant the "Rebuilding…" curtain. Flat rebuilds are a 2D extrude and usually
 * fast, but a very dense design still bites — so gauge those by the artwork's total
 * polygon-vertex count, which is what the boolean/extrude cost scales with. Calibrated so
 * the sample badge (fast) stays under and a detailed multi-hundred-point SVG goes over.
 */
const SLOW_FLAT_POINTS = 4000;

/**
 * Up-front guess of whether the next rebuild will be slow, from the current design/mode —
 * see setRebuildCostHint. Cheap: a point-count sum, no geometry work.
 */
export function estimateRebuildSlow(): boolean {
  if (!state.parsed) return false; // no artwork yet — bare plate/wheel render is fast
  if (state.shapeKind === 'assembly') return true;
  let points = 0;
  for (const shape of state.parsed.shapes) for (const loop of shape.loops) points += loop.length;
  return points > SLOW_FLAT_POINTS;
}

/** Entry point the scheduler debounces into. */
export async function rebuildCurrent(): Promise<void> {
  if (state.shapeKind === 'assembly') await rebuildAssemblyScene();
  else await rebuildScene();
}

async function rebuildScene(): Promise<void> {
  setPreferredViewDir(null); // flat mode: keep the user's current view direction when re-framing
  const modelGroup = newModelGroup(state.stlRefMesh);
  const baseParams = currentBaseParams();

  if (!state.parsed) {
    // No artwork yet: still show the bare plate (and STL reference) so picking a shape gives
    // instant feedback instead of an empty viewport.
    if (baseParams) {
      const shapes = featureToShapes(footprintFeature(state.shapeKind, baseParams));
      if (shapes.length) {
        const geo = new THREE.ExtrudeGeometry(shapes, {
          depth: baseParams.thickness,
          bevelEnabled: false,
          curveSegments: 1,
        });
        const mat = new THREE.MeshStandardMaterial({
          color: new THREE.Color(baseColorHex()),
          roughness: 0.75,
          metalness: 0.05,
          side: THREE.DoubleSide,
        });
        modelGroup.add(new THREE.Mesh(geo, mat));
      }
    }
    if (state.stlRefMesh && state.shapeKind === 'stl') modelGroup.add(state.stlRefMesh);
    renderColorList(null);
    renderWarnings();
    updateTriStat();
    setExportEnabled(false);
    refreshModelShadows();
    frameModelIfPending();
    return;
  }

  if (!baseParams) return;
  const built = await buildGeometry({
    parsed: state.parsed,
    colorSettings: state.colorSettings,
    baseParams,
    shapeKind: state.shapeKind,
    globalDepth: state.globalDepth,
    recessBg: state.recessBg,
    mergeGroups: state.mergeGroups,
    baseColorHex: baseColorHex(),
    autoMergeLevel: state.autoMergeLevel,
    baseColorKey: state.baseColorKey,
    baseColorMembers: state.baseColorMembers,
    keptApart: state.keptApart,
  });
  lastBuild = built;
  if (!built) return;

  modelGroup.add(built.baseGroup);
  built.colorMeshes.forEach((c) => modelGroup.add(c.mesh));
  if (state.stlRefMesh && state.shapeKind === 'stl') modelGroup.add(state.stlRefMesh);

  updateTriStat();
  const listEntries: ColorListEntry[] = built.colorMeshes.map((c) => ({
    color: c.color,
    key: c.key,
    members: c.members,
    isMergeGroup: c.isMergeGroup,
    depth: c.depth,
    areaPct: c.areaPct,
    isBackground: c.isBackground,
  }));
  if (built.baseAssigned) {
    listEntries.push({
      color: built.baseAssigned.hex,
      key: 'base:' + built.baseAssigned.hex,
      members: state.baseColorMembers,
      isMergeGroup: false,
      depth: 0,
      areaPct: built.baseAssigned.areaPct,
      isBackground: false,
      isBase: true,
    });
    // keep the dominant member in sync so the top fallback area and the 3D body agree — no
    // scheduleRebuild here, this just mirrors what the build already computed
    state.baseColorKey = built.baseAssigned.hex;
  }
  renderColorList(listEntries, { rawColorCount: built.detectedColors.length });
  renderBaseColorSwatches();
  renderWarnings();
  setExportEnabled(true);
  refreshModelShadows();
  frameModelIfPending();
}

/**
 * Show the bare loaded parts (no cuts) so the wheel is visible as soon as it loads, before any
 * artwork is applied — otherwise selecting the assembly leaves the viewport empty until an SVG
 * is dropped in.
 */
function renderRawAssemblyParts(): void {
  const modelGroup = getModelGroup();
  const rawMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(baseColorHex()),
    roughness: 0.8,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });
  let tris = 0;
  state.assembly.parts.forEach((part) => {
    if (!part.loaded || !part.positions) return;
    const xf = asmPartTransformGroup(part);
    modelGroup.add(xf.outer);
    xf.add(new THREE.Mesh(bufferGeometryFromTris(Float32Array.from(part.positions)), rawMat));
    tris += part.positions.length / 9;
  });
  $('#stat-tris').textContent = Math.round(tris) + ' tris';
}

/**
 * The wheel parts live in their native (hub-centered) coordinates, which straddle the z=0 grid
 * plane — lift the whole group so the assembly rests on the grid like the flat plates do.
 */
function restAssemblyOnGrid(): void {
  const modelGroup = getModelGroup();
  const box = new THREE.Box3().setFromObject(modelGroup);
  if (!box.isEmpty()) modelGroup.position.z = -box.min.z;
}

async function rebuildAssemblyScene(): Promise<void> {
  newModelGroup(state.stlRefMesh);

  // No artwork yet: still show the bare wheel so "select the assembly" gives instant feedback.
  if (!state.parsed) {
    renderRawAssemblyParts();
    restAssemblyOnGrid();
    renderColorList(null);
    renderWarnings();
    $<HTMLButtonElement>('#btn-export').disabled = true;
    if (!state.assembly.parts.some((p) => p.loaded)) $('#stat-tris').textContent = '0 tris';
    const primary = state.assembly.parts.find((p) => p.loaded && !p.isDuplicateOf);
    const nrm = primary ? asmPartFaceNormal(primary, state.assembly.parts) : null;
    setPreferredViewDir(new THREE.Vector3(0.35, 0.9 * (nrm && nrm[1] < 0 ? -1 : 1), 0.4));
    refreshModelShadows();
    frameModelIfPending();
    return;
  }

  const built = await buildAssemblyGeometry({
    parsed: state.parsed,
    parts: state.assembly.parts,
    mergeGroups: state.mergeGroups,
    colorSettings: state.colorSettings,
    globalDepth: state.globalDepth,
    radius: state.asmRadius,
    designFit: currentAssemblyKind()?.designFit,
    scaleMult: state.scalePct / 100,
    offX: state.offsetX,
    offZ: state.offsetY,
    flipX: state.flipX,
    flipY: state.flipY,
    autoMergeLevel: state.autoMergeLevel,
    baseColorKey: state.baseColorKey,
    baseColorMembers: state.baseColorMembers,
    keptApart: state.keptApart,
  });
  lastAssemblyBuild = built;
  const modelGroup = getModelGroup();
  if (!built) {
    // Build failed/refused: keep the bare wheel on screen and surface whatever warn()s the
    // build pushed — a silently emptied viewport reads as a crash.
    renderRawAssemblyParts();
    restAssemblyOnGrid();
    renderColorList(null);
    renderWarnings();
    $<HTMLButtonElement>('#btn-export').disabled = true;
    refreshModelShadows();
    frameModelIfPending();
    return;
  }

  // Open the view looking at the design face (the +normal side), not the blank back of the wheel.
  const vs = built.viewSign || 1;
  setPreferredViewDir(new THREE.Vector3(0.35, 0.9 * vs, 0.4));

  const baseMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(baseColorHex()),
    roughness: 0.75,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });
  let tris = 0;

  built.partOutputs.forEach(({ part, bodySoup, inlaySoups }) => {
    const xf = asmPartTransformGroup(part); // identity for primaries; pivot-rotates duplicates to their real position
    modelGroup.add(xf.outer);
    // the modified body IS the whole real part (pockets cut in) — no separate context mesh
    xf.add(new THREE.Mesh(bufferGeometryFromTris(bodySoup), baseMat));
    tris += bodySoup.length / 9;
    Object.entries(inlaySoups).forEach(([ci, soup]) => {
      const hex = built.palette[+ci].hex;
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(hex),
        roughness: 0.55,
        metalness: 0.05,
        side: THREE.DoubleSide,
      });
      xf.add(new THREE.Mesh(bufferGeometryFromTris(soup), mat));
      tris += soup.length / 9;
    });
  });

  // aggregate color list across the whole assembly (one shared design/palette)
  const colorListEntries: ColorListEntry[] = [];
  built.palette.forEach((c, ci) => {
    let area = 0;
    built.partOutputs.forEach(({ inlaySoups }) => {
      if (inlaySoups[ci]) area += inlaySoups[ci].length / 9;
    });
    if (area > 0)
      colorListEntries.push({
        color: c.hex,
        key: c.key,
        members: c.members,
        isMergeGroup: c.isMerge,
        depth:
          (state.colorSettings[c.key] && state.colorSettings[c.key].depth) || state.globalDepth,
        areaPct: area,
        isBackground: false,
      });
  });
  const totalArea = colorListEntries.reduce((s, c) => s + c.areaPct, 0) || 1;
  colorListEntries.forEach((c) => {
    c.areaPct = (100 * c.areaPct) / totalArea;
  });
  if (built.baseAssigned) {
    // Note: this areaPct is on the 2D-design scale (matches detectedColors), while the rows
    // above are triangle-count-based — both are 0-100 percentages but not on the same footing.
    // Assembly-mode area is already an approximation; exact parity isn't worth the extra pass.
    colorListEntries.push({
      color: built.baseAssigned.hex,
      key: 'base:' + built.baseAssigned.hex,
      members: state.baseColorMembers,
      isMergeGroup: false,
      depth: 0,
      areaPct: built.baseAssigned.areaPct,
      isBackground: false,
      isBase: true,
    });
    // keep the dominant member in sync so the top fallback area and the 3D body agree — no
    // scheduleRebuild here, this just mirrors what the build already computed
    state.baseColorKey = built.baseAssigned.hex;
  }

  restAssemblyOnGrid();
  $('#stat-tris').textContent = Math.round(tris) + ' tris';
  renderColorList(colorListEntries, { rawColorCount: built.detectedColors.length });
  renderBaseColorSwatches();
  renderWarnings();
  $<HTMLButtonElement>('#btn-export').disabled = built.partOutputs.length === 0;
  refreshModelShadows();
  frameModelIfPending();
}
