import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import type { AssemblyBuild, IndexedMesh } from '../types';
import { baseColorHex, currentBaseParams, SCALE_MAX_PCT, state } from '../state/store';
import {
  activeArtworkInstance,
  availableZones,
  syncActiveArtworkPlacement,
  zoneCoverage,
} from '../state/artwork';
import { creasedNormalsFromIndex, indexMatchesSoup } from '../geometry/creasedNormals';
import { clearBuildWarnings, noticeBuild } from '../warnings';
import { buildGeometry, featureToShapes, footprintFeature, type FlatBuild } from '../geometry/flat';
import {
  asmPartFaceNormal,
  asmPartTransformGroup,
  buildAssemblyGeometry,
  shippedColorIndices,
  type ArtworkBuildInput,
} from '../geometry/assembly';
import { currentAssemblyKind, hubcapSilhouetteOffset } from '../assembly/kinds';
import { asmRebuildGeneratedParts, generatedPartsNeedRebuild } from '../assembly/parts';
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
import { schedulePersist } from '../state/persist';
import { $ } from '../ui/dom';
import { renderExportSummary } from '../ui/exportPanel';
import { RebuildCancelled } from '../cancel';

let lastBuild: FlatBuild | null = null;
let lastAssemblyBuild: AssemblyBuild | null = null;

export function getLastBuild(): FlatBuild | null {
  return lastBuild;
}
export function getLastAssemblyBuild(): AssemblyBuild | null {
  return lastAssemblyBuild;
}

/**
 * Below this angle between two faces, they're taken to be a tessellated curve and shaded as one
 * smooth surface; at or above it, a real edge that stays crisp.
 *
 * 30° rather than three's 60° default because the parts carry chamfers: a 45° chamfer meets its
 * face at a 45° normal difference, which a 60° threshold would smooth away — turning a machined
 * edge into a soft one. Measured against the alternative, a blanket `mergeVertices` +
 * `computeVertexNormals` (no threshold at all): it visibly melted the embossed logo on the
 * storage box and softened the seat-clip detail, and ran slower and less predictably
 * (3.8-5.2s against a steady 4.1s for the chair's 13 parts).
 */
const CREASE_ANGLE_RAD = (30 * Math.PI) / 180;

/**
 * Display geometry for one triangle soup.
 *
 * The soup is non-indexed — every triangle carries its own three vertices — and
 * `computeVertexNormals()` on non-indexed geometry gives each vertex its own face's normal, so it
 * produced flat shading by construction: curved surfaces banded and silhouettes read as polygonal
 * on every part, worst on the chair. Normals are averaged across shared vertices instead, up to
 * the crease angle.
 *
 * **Pass `indexed` whenever the caller has it.** Manifold returns one from every boolean and a
 * packed 3MF carries one in the file, and with it the sharing is read instead of rediscovered by
 * hashing every corner twice: 8.7x measured in Chrome on five chair parts. Without it this falls
 * back to three's `toCreasedNormals`, unchanged, which is what any mesh the user supplies takes.
 * That fallback is the reason this is a swap rather than a migration.
 *
 * Display only. The cut and export paths never read these normals — they work from the same soup
 * this is built from, already cut.
 */
export function bufferGeometryFromTris(
  float32arr: Float32Array,
  indexed?: IndexedMesh,
): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(float32arr, 3));
  if (indexMatchesSoup(indexed, float32arr)) {
    geo.setAttribute(
      'normal',
      new THREE.BufferAttribute(creasedNormalsFromIndex(indexed!, CREASE_ANGLE_RAD), 3),
    );
    return geo;
  }
  return toCreasedNormals(geo, CREASE_ANGLE_RAD);
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
  // Here rather than beside setExportEnabled: assembly mode sets #btn-export.disabled directly in
  // three places and never calls that helper, so hanging the summary off it left the panel blank
  // on exactly the kind whose export needed describing. This is the choke point both modes share.
  renderExportSummary();
  // Every rebuild is the state settling after some edit — the one choke point nearly every
  // mutation already funnels through, so this is the cheapest place to keep the autosave current
  // rather than hooking each individual setter.
  schedulePersist();
}

/**
 * Run a build, returning null if the user cancelled it.
 *
 * Caught here rather than in the scheduler so the rest of rebuildCurrent still runs: its tail
 * carries the only schedulePersist outside export, and skipping that left a cancelled rebuild's
 * change unsaved, which is the loss this button exists to prevent. Null then takes the same path a
 * refused build does, which is a state the app already knows how to be in.
 */
async function catchCancel<T>(run: () => Promise<T | null>): Promise<T | null> {
  try {
    return await run();
  } catch (e) {
    if (!(e instanceof RebuildCancelled)) throw e;
    // Drop what the aborted build had already said. Its per-part diagnostics ("isn't watertight",
    // "couldn't merge color …") describe parts that were never finished, and leaving them up puts
    // failure pills in front of someone who pressed Cancel.
    clearBuildWarnings();
    return null;
  }
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
  // Captured before the closure: the null check above cannot narrow `state.parsed` inside a
  // callback, since nothing stops the state changing between here and the call.
  const parsed = state.parsed;
  const built = await catchCancel(() =>
    buildGeometry({
      parsed,
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
    }),
  );
  lastBuild = built;
  // Refused: leave the panels describing nothing rather than the previous build, whose meshes
  // newModelGroup() has already removed. catchCancel returns null on a cancel, so a cancel does
  // reach here — this branch is both, and the panels want clearing either way.
  if (!built) {
    renderColorList(null);
    renderWarnings();
    updateTriStat();
    setExportEnabled(false);
    refreshModelShadows();
    frameModelIfPending();
    return;
  }

  modelGroup.add(built.baseGroup);
  built.colorMeshes.forEach((c) => modelGroup.add(c.mesh));
  if (state.stlRefMesh && state.shapeKind === 'stl') modelGroup.add(state.stlRefMesh);

  updateTriStat();
  const listEntries: ColorListEntry[] = built.colorMeshes.map((c) => ({
    color: c.color,
    key: c.key,
    members: c.members,
    isMergeGroup: c.isMergeGroup,
    areaPct: c.areaPct,
    isBackground: c.isBackground,
    appliedDepth: c.depth,
  }));
  if (built.baseAssigned) {
    listEntries.push({
      color: built.baseAssigned.hex,
      key: 'base:' + built.baseAssigned.hex,
      members: state.baseColorMembers,
      isMergeGroup: false,
      areaPct: built.baseAssigned.areaPct,
      isBackground: false,
      isBase: true,
    });
    // keep the dominant member in sync so the top fallback area and the 3D body agree — no
    // scheduleRebuild here, this just mirrors what the build already computed
    state.baseColorKey = built.baseAssigned.hex;
  }
  // The background recess is a colour the app adds rather than one found in the artwork, so
  // detectedColors doesn't carry it. It still prints, and still costs a slot, so leaving it out
  // made the line read "3 colors -> 5 AMS slots" beside a "4 colors" chip: two numbers for one
  // word, and a +2 where the help dialog promises the body's +1.
  const bgColors = built.colorMeshes.filter((c) => c.isBackground).length;
  renderColorList(listEntries, { rawColorCount: built.detectedColors.length + bgColors });
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
    const soup = Float32Array.from(part.positions);
    xf.add(new THREE.Mesh(bufferGeometryFromTris(soup, part.indexed), rawMat));
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

  // The fit sliders and the gizmo write the legacy globals; the instance is where the rest of
  // assembly mode reads placement from. Sync FIRST, because a part whose shape follows the artwork
  // is regenerated below and reads that instance — left until its usual spot further down, the
  // outline was built from the previous scale/rotation/offset and the picture from the new one,
  // which is the drift the whole placement seam exists to prevent. Idempotent, and the call below
  // stays where it is so the non-generated path is unchanged.
  syncActiveArtworkPlacement();

  // BEFORE the no-artwork branch below, not after it. A part whose shape follows the artwork has
  // to be rebuilt when the artwork goes away, and that is exactly the case that branch returns
  // early for — so removing the last image left the hubcap still cut to its silhouette, with
  // nothing on screen to explain why.
  if (generatedPartsNeedRebuild()) await asmRebuildGeneratedParts({ schedule: false });

  // A part cut to its own artwork centres itself on its mounting axis, and the artwork's offset is
  // then solved for rather than chosen — moving the picture relative to a part that IS the picture
  // isn't a meaningful request, and honouring one can't be made consistent anyway (the cut adds the
  // design face's own centre, which for a silhouette is the thing being offset). Written back to
  // both the instance and the legacy globals so the Fit sliders show what is actually in force.
  const silOff = hubcapSilhouetteOffset();
  if (silOff) {
    state.offsetX = silOff.x;
    state.offsetY = silOff.z;
    const active = activeArtworkInstance();
    if (active) {
      active.offsetU = silOff.x;
      active.offsetV = silOff.z;
    }
  }

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
  const artworks: ArtworkBuildInput[] = state.artworks.flatMap((a) => {
    const source = state.sources.find((s) => s.id === a.sourceId);
    const parsed = source?.parsed ?? state.parsed;
    if (!parsed) return [];
    return [
      {
        parsed,
        name: source?.name,
        zoneId: a.zone?.zoneId ?? null,
        scaleMult: a.scalePct / 100,
        maxScaleMult: SCALE_MAX_PCT / 100,
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
      maxScaleMult: SCALE_MAX_PCT / 100,
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
        : `${zoneCovered} of ${zoneTotal} zones have artwork`;
    noticeBuild(
      `${where}: ${blank} of ${zoneTotal} zone${zoneTotal === 1 ? '' : 's'} still blank. Add more from the zone dropdown, or pick "All zones" to cover every zone.`,
    );
  }
  // A cancel is caught here, not left to the scheduler, and lands on the `!built` path below.
  // Letting it escape skipped the tail of rebuildCurrent — including the one schedulePersist call
  // outside export, so a cancelled rebuild left the autosave stale and lost the change on reload,
  // which is the failure this button exists to prevent. It also left the stage blank, because
  // newModelGroup() has already torn the old meshes down by this point, and left #btn-export
  // enabled over the previous build's geometry.
  const built = await catchCancel(() =>
    buildAssemblyGeometry({
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
    }),
  );
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

  built.partOutputs.forEach(({ part, bodySoup, inlaySoups, bodyIndexed, inlayIndexed }) => {
    const xf = asmPartTransformGroup(part); // identity for primaries; pivot-rotates duplicates to their real position
    modelGroup.add(xf.outer);
    // the modified body IS the whole real part (pockets cut in) — no separate context mesh
    // `bodyIndexed` is absent whenever the part never went through a boolean: no artwork on it, or
    // a cut that failed. Its soup is then `part.positions` verbatim, which `part.indexed` already
    // describes, so shading still gets the fast path. Read here rather than filled in on the build
    // output because `bodyIndexed` is also what 3MF export writes, and this must not change what
    // an uncut part exports.
    xf.add(new THREE.Mesh(bufferGeometryFromTris(bodySoup, bodyIndexed ?? part.indexed), baseMat));
    tris += bodySoup.length / 9;
    Object.entries(inlaySoups).forEach(([ci, soup]) => {
      const hex = built.palette[+ci].hex;
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(hex),
        roughness: 0.55,
        metalness: 0.05,
        side: THREE.DoubleSide,
      });
      xf.add(new THREE.Mesh(bufferGeometryFromTris(soup, inlayIndexed?.[+ci]), mat));
      tris += soup.length / 9;
    });
  });

  // aggregate color list across the whole assembly (one shared design/palette), keeping exactly
  // the colors the export will write as materials so the rows, the slot count, and the file agree
  const shipped = shippedColorIndices(built.partOutputs);
  const colorListEntries: ColorListEntry[] = [];
  built.palette.forEach((c, ci) => {
    if (!shipped.has(ci)) return;
    let area = 0;
    built.partOutputs.forEach(({ bodySoup, inlaySoups }) => {
      if (bodySoup.length && inlaySoups[ci]) area += inlaySoups[ci].length / 9;
    });
    colorListEntries.push({
      color: c.hex,
      key: c.key,
      members: c.members,
      isMergeGroup: c.isMerge,
      areaPct: area,
      isBackground: false,
      appliedDepth: c.appliedDepth,
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
