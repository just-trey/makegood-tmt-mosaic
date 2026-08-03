import * as THREE from 'three';
import type { AssemblyBuild } from '../types';
import { baseColorHex, currentBaseParams, state } from '../state/store';
import { availableZones, syncActiveArtworkPlacement, zoneCoverage } from '../state/artwork';
import { noticeBuild } from '../warnings';
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
import { assemblyViewDir, displayQuaternionFor } from '../scene/displayFrame';
import { refreshGizmo } from '../scene/designGizmo';
import { refreshZonePickMeshes } from '../scene/zonePick';
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
  // The on-face gizmo tracks the just-built geometry (including the assembly's post-rebuild grid
  // lift); a no-op mid-drag so it doesn't fight the pointer.
  refreshGizmo();
  refreshZonePickMeshes();
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
 * Pose the assembly for display: turn it into the kind's authored display frame, then stand it on
 * the grid — centered over it, resting on it.
 *
 * All of it exists because parts are never transformed at load — the wheel's native coordinates
 * are hub-centered and straddle z=0, and the chair's are its CAD frame, whose origin is a CAD datum
 * rather than the middle of the part (the chair's footprint runs 4..662mm along the grid's Y, so
 * uncentered it stood almost entirely off the back edge of the stage). All viewport-only: the cut
 * pipeline, the baked charts and export placement read the parts, not the scene.
 *
 * The rotation has to be applied BEFORE measuring, since it changes both which face is lowest and
 * where the footprint lies — that is the whole point for the chair, whose rearmost face was
 * resting on the grid.
 */
function poseAssemblyForDisplay(): void {
  const modelGroup = getModelGroup();
  modelGroup.quaternion.copy(displayQuaternionFor(currentAssemblyKind()));
  modelGroup.position.set(0, 0, 0);
  modelGroup.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(modelGroup);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  modelGroup.position.set(-center.x, -center.y, -box.min.z);
}

async function rebuildAssemblyScene(): Promise<void> {
  newModelGroup(state.stlRefMesh);

  // No artwork yet: still show the bare wheel so "select the assembly" gives instant feedback.
  if (!state.parsed) {
    renderRawAssemblyParts();
    poseAssemblyForDisplay();
    renderColorList(null);
    renderWarnings();
    $<HTMLButtonElement>('#btn-export').disabled = true;
    if (!state.assembly.parts.some((p) => p.loaded)) $('#stat-tris').textContent = '0 tris';
    const primary = state.assembly.parts.find((p) => p.loaded && !p.isDuplicateOf);
    const nrm = primary ? asmPartFaceNormal(primary, state.assembly.parts) : null;
    setPreferredViewDir(assemblyViewDir(currentAssemblyKind(), nrm && nrm[1] < 0 ? -1 : 1));
    refreshModelShadows();
    frameModelIfPending();
    return;
  }

  // Placement still comes from the global fit sliders (the instance-aware panel wires them to the
  // active instance directly); sync the instance here so assembly-mode code reads placement
  // through it rather than the legacy fields, without changing what value actually reaches the
  // build.
  syncActiveArtworkPlacement();
  // Every instance whose source still resolves, each carrying its own placement and zone binding.
  // With one unbound instance — every flow that exists until the panel can add a second — this is
  // exactly the single global placement the build used to take.
  const artworks = state.artworks.flatMap((a) => {
    const parsed = state.sources.find((s) => s.id === a.sourceId)?.parsed ?? state.parsed;
    if (!parsed) return [];
    return [
      {
        parsed,
        zoneId: a.zone?.zoneId ?? null,
        scaleMult: a.scalePct / 100,
        offX: a.offsetU,
        offZ: a.offsetV,
        flipX: a.flipX,
        flipY: a.flipY,
        rotationDeg: a.rotationDeg,
        mode: a.mode,
      },
    ];
  });
  // state.parsed without an instance shouldn't happen (loadArtworkSource creates one), but the
  // globals remain the source of truth for flat mode, so fall back to them rather than silently
  // building nothing.
  if (!artworks.length && state.parsed)
    artworks.push({
      parsed: state.parsed,
      zoneId: null,
      scaleMult: state.scalePct / 100,
      offX: state.offsetX,
      offZ: state.offsetY,
      flipX: state.flipX,
      flipY: state.flipY,
      rotationDeg: state.rotationDeg,
      mode: 'sticker',
    });
  // The default zone binding (loadArtworkSource) picks the first zone silently, since binding
  // every zone recuts the whole assembly on every nudge — see that function's comment. Surface the
  // decision here instead of leaving it discoverable only via the per-row dropdown: this is what
  // caught scripts/export-chair-examples.mjs's own author, and it produces a print that looks right
  // (a colored patch, a nonzero color count) right up until it's opened in a slicer.
  const { total: zoneTotal, covered: zoneCovered } = zoneCoverage();
  if (zoneTotal > 1 && zoneCovered < zoneTotal) {
    const blank = zoneTotal - zoneCovered;
    const boundNames = availableZones()
      .filter((z) => state.artworks.some((a) => a.zone?.zoneId === z.zoneId))
      .map((z) => z.name);
    const where =
      boundNames.length === 1
        ? `Placed on "${boundNames[0]}"`
        : `${zoneCovered} of ${zoneTotal} surfaces have artwork`;
    noticeBuild(
      `${where} — ${blank} of ${zoneTotal} surface${zoneTotal === 1 ? '' : 's'} still blank. Add more from the zone dropdown, or pick "All zones" to cover every surface.`,
    );
  }
  const built = await buildAssemblyGeometry({
    artworks,
    parts: state.assembly.parts,
    mergeGroups: state.mergeGroups,
    colorSettings: state.colorSettings,
    globalDepth: state.globalDepth,
    radius: state.asmRadius,
    designFit: currentAssemblyKind()?.designFit,
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
    poseAssemblyForDisplay();
    renderColorList(null);
    renderWarnings();
    $<HTMLButtonElement>('#btn-export').disabled = true;
    refreshModelShadows();
    frameModelIfPending();
    return;
  }

  // Open the view looking at the design face (the +normal side), not the blank back of the wheel —
  // or, for a kind that authors a display frame, at its front.
  setPreferredViewDir(assemblyViewDir(currentAssemblyKind(), built.viewSign || 1));

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

  poseAssemblyForDisplay();
  $('#stat-tris').textContent = Math.round(tris) + ' tris';
  renderColorList(colorListEntries, { rawColorCount: built.detectedColors.length });
  renderBaseColorSwatches();
  renderWarnings();
  $<HTMLButtonElement>('#btn-export').disabled = built.partOutputs.length === 0;
  refreshModelShadows();
  frameModelIfPending();
}
