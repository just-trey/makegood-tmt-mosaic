import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import type { AssemblyBuild, IndexedMesh } from '../types';
import { baseColorHex, SCALE_MAX_PCT, state } from '../state/store';
import {
  activeArtworkInstance,
  availableZones,
  netZones,
  retraceMovedSources,
  syncActiveArtworkPlacement,
  zoneCoverage,
  zoneMirrorOf,
} from '../state/artwork';
import { creasedNormalsFromIndex, indexMatchesSoup } from '../geometry/creasedNormals';
import { soupCapArea } from '../geometry/regions';
import { clearBuildWarnings, noticeBuild, warn, warnBuild } from '../warnings';
import {
  asmPartFaceNormal,
  asmPartTransformGroup,
  shippedColorIndices,
  type ArtworkBuildInput,
} from '../geometry/assembly';
import {
  mirroredBuildInput,
  netToZoneBuildInput,
  WHOLE_CHAIR_ZONE,
  type KeepSide,
} from '../geometry/zones';
import { ConformalZoneMapper, type OverlayMesh } from '../geometry/conformal';
import {
  currentAssemblyKind,
  generatedDesignFaceOverride,
  generatedFitFactor,
  hubcapSilhouetteOffset,
} from '../assembly/kinds';
import {
  asmRebuildGeneratedParts,
  generatedPartsNeedRebuild,
  warnMissingParts,
} from '../assembly/parts';
import {
  frameModelIfPending,
  getModelGroup,
  invalidate,
  newModelGroup,
  refreshModelShadows,
  setPreferredViewDir,
} from '../scene/viewport';
import { assemblyViewDir, displayQuaternionFor } from '../scene/displayFrame';
import { refreshGizmo, tokenColor } from '../scene/designGizmo';
import { refreshZonePickMeshes } from '../scene/zonePick';
import { renderColorList, type ColorListEntry } from '../ui/colorList';
import { renderBaseColorSwatches } from '../ui/partPanel';
import { renderWarnings } from '../ui/warningsView';
import { renderArtworkList } from '../ui/artworkListPanel';
import { rebuildSettled, scheduleRebuild } from './scheduler';
import { schedulePersist } from '../state/persist';
import { $ } from '../ui/dom';
import { clearExportStatus, renderExportHint, renderExportSummary } from '../ui/exportPanel';
import { RebuildCancelled } from '../cancel';
import { BuildWorkerCrashed, BuildWorkerFault, runAssemblyBuild } from './buildClient';

let lastAssemblyBuild: AssemblyBuild | null = null;

export function getLastAssemblyBuild(): AssemblyBuild | null {
  return lastAssemblyBuild;
}

let exportReady = false;
let exportHeld = false;
let exportReason: string | null = null;

/** The rebuild's verdict on #btn-export, with the reason when it is off. An export in progress holds the button off over it. */
function setExportReady(on: boolean, reason: string | null = null): void {
  exportReady = on;
  exportReason = on ? null : reason;
  $<HTMLButtonElement>('#btn-export').disabled = !on || exportHeld;
}

/** One line for why Export is off, or null while it is on. A hold during an export is not a reason. */
export function exportBlockedReason(): string | null {
  return exportReady ? null : exportReason;
}

/** Held from the click until the export ends, including its wait for a rebuild to finish. */
export function holdExport(on: boolean): void {
  exportHeld = on;
  setExportReady(exportReady);
}

export function isExportReady(): boolean {
  return exportReady;
}

/**
 * Below this angle between two faces they're a tessellated curve, shaded smooth; at or above, a
 * crisp edge. 30° not three's 60° because the parts carry chamfers: a 45° chamfer meets its face at
 * a 45° normal difference, which 60° smooths away. A blanket `mergeVertices` +
 * `computeVertexNormals` melted the embossed logo on the storage box and softened the seat-clip
 * detail, and ran slower and less predictably (3.8-5.2s against a steady 4.1s for the chair's 13 parts).
 */
const CREASE_ANGLE_RAD = (30 * Math.PI) / 180;

/**
 * Display geometry for one triangle soup.
 *
 * The soup is non-indexed, so `computeVertexNormals()` gives each vertex its own face's normal —
 * flat shading by construction, curved surfaces banded. Normals are averaged across shared vertices
 * up to the crease angle instead.
 *
 * **Pass `indexed` whenever the caller has it** (Manifold returns one from every boolean, a packed
 * 3MF carries one): the sharing is read instead of rediscovered by hashing every corner twice, 8.7x
 * measured in Chrome on five chair parts. Without it this falls back to three's `toCreasedNormals`
 * unchanged, which any user-supplied mesh takes — why this is a swap, not a migration.
 *
 * Display only: the cut and export paths work from the already-cut soup, never these normals.
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

/** Up-front guess of whether the next rebuild will be slow (setRebuildCostHint). Every rebuild with artwork does per-part 3D boolean CSG, always heavy enough for the curtain. */
export function estimateRebuildSlow(): boolean {
  return !!state.parsed; // no artwork yet — a bare part render is fast
}

/** Entry point the scheduler debounces into. */
export async function rebuildCurrent(): Promise<void> {
  clearExportStatus();
  await rebuildAssemblyScene();
  // Tracks the just-built geometry (incl. the assembly's post-rebuild grid lift); a no-op mid-drag so it doesn't fight the pointer.
  refreshGizmo();
  refreshZonePickMeshes();
  // Here, not beside each setExportReady, so the summary follows every one.
  renderExportSummary();
  renderExportHint();
  // Every rebuild is the state settling after an edit — the one choke point nearly every mutation funnels through, cheaper than hooking each setter.
  schedulePersist();
}

/** Stripe texture size (px) and stroke width, and the surface pitch (mm) one tile repeats over. */
const HATCH_TILE_PX = 64;
const HATCH_STROKE_PX = 12;
const HATCH_PITCH_MM = 8;

/**
 * One material and its stripe texture per hatch kind, shared by every zone on every part.
 *
 * Dropped on the material's own dispose event, not held forever: `newModelGroup` disposes the
 * materials of everything it clears, so a kept handle would be a material with a released GPU
 * program. The cache lasts as long as the scene, so the accent is re-read once per rebuild and a
 * theme change lands.
 *
 * **The texture goes with it.** The stripes are DRAWN in the accent, so the colour lives in the
 * texture; cached separately it outlived every dispose and the rebuilt material kept the old
 * accent's stripes. Dropped together and disposed, since `newModelGroup` frees the material, never its texture.
 */
type HatchKind = 'dead' | 'yielded';
const hatches = new Map<
  HatchKind,
  { material: THREE.MeshBasicMaterial; texture: THREE.CanvasTexture | null }
>();
function hatchMaterial(kind: HatchKind): THREE.MeshBasicMaterial {
  const held = hatches.get(kind);
  if (held) return held.material;
  const yielded = kind === 'yielded';
  const accent = new THREE.Color(
    yielded ? tokenColor('--accent-2', 0x5eead4) : tokenColor('--accent', 0x6d93ff),
  );
  const c = document.createElement('canvas');
  c.width = c.height = HATCH_TILE_PX;
  // jsdom has no 2D canvas; a plain translucent tint is the same signal minus the stripes
  const ctx = c.getContext('2d');
  let texture: THREE.CanvasTexture | null = null;
  if (ctx) {
    ctx.clearRect(0, 0, HATCH_TILE_PX, HATCH_TILE_PX);
    ctx.strokeStyle = `#${accent.getHexString()}`;
    ctx.lineWidth = HATCH_STROKE_PX;
    for (const x of [-HATCH_TILE_PX, 0, HATCH_TILE_PX]) {
      ctx.beginPath();
      ctx.moveTo(x, HATCH_TILE_PX);
      ctx.lineTo(x + HATCH_TILE_PX, 0);
      // The yielded hatch is the dead one plus the perpendicular set at the same pitch, width and
      // opacity — the relation the printed net template's `shared` pattern has to its `hidden` one
      // (`M0 4 L4 0 M0 0 L4 4` against `M0 4 L4 0`, zonebake.mjs). The second accent carries it at a
      // glance; the crossing still separates them when a theme moves the hues together.
      if (yielded) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x + HATCH_TILE_PX, HATCH_TILE_PX);
      }
      ctx.stroke();
    }
    texture = new THREE.CanvasTexture(c);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  }
  const mat = new THREE.MeshBasicMaterial({
    ...(texture ? { map: texture } : { color: accent }),
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  mat.addEventListener('dispose', () => {
    if (hatches.get(kind)?.material !== mat) return;
    hatches.get(kind)!.texture?.dispose();
    hatches.delete(kind);
  });
  hatches.set(kind, { material: mat, texture });
  return mat;
}

// The warp (triangulate, subdivide, per-vertex surface lookup) is static per chart but every rebuild
// disposes scene geometry (newModelGroup), so the computed arrays are cached and a fresh
// BufferGeometry built from them each time, keyed by chart (which lives as long as its part).
//
// `uv` is already divided by the stripe pitch. BufferAttribute never writes its array and disposal
// frees the GPU buffer, not the array, so both are handed to each rebuild's attributes uncopied.
const overlayCache = new WeakMap<
  object,
  { dead: OverlayMesh | null; yielded: OverlayMesh | null }
>();

/** The mapper hands back true surface mm; one texture tile spans HATCH_PITCH_MM of it. */
const scaleToPitch = (m: OverlayMesh | null): OverlayMesh | null =>
  m && { positions: m.positions, uv: m.uv.map((x) => x / HATCH_PITCH_MM) };

/**
 * Whether the yielded-canvas hatch tells the truth right now: only while the edited row is bound to
 * the whole part. A zone-bound row reaches all of that zone's surface, yielded patches included, so
 * hatching them there lies the other way.
 *
 * **Nothing selected shows nothing**, like a per-zone row: the hatch means "the design you are
 * placing won't cut here", and with no row in focus it would mark live surface dead unexplained.
 * Barely reachable: `setActiveArtwork` keeps a row in focus while any exists.
 */
function yieldedHatchVisible(): boolean {
  return activeArtworkInstance()?.zone?.zoneId === WHOLE_CHAIR_ZONE;
}

/** Marks the meshes `refreshNetYieldOverlays` toggles, so a selection change costs no rebuild. */
const YIELD_OVERLAY = 'netYieldOverlay';

/**
 * Re-answer `yieldedHatchVisible()` for overlays already in the scene. Binding changes schedule a
 * rebuild, which rebuilds them correctly; clicking another artwork row doesn't, and is the one path
 * that changes the active binding without touching geometry.
 */
export function refreshNetYieldOverlays(): void {
  const show = yieldedHatchVisible();
  let changed = false;
  getModelGroup().traverse((o) => {
    if (!o.userData[YIELD_OVERLAY] || o.visible === show) return;
    o.visible = show;
    changed = true;
  });
  if (changed) invalidate();
}

/**
 * Hatch each zone's hidden surface (chart deadRegions) onto the part, and the canvas it yields to
 * another net sheet, floating just off the mesh. Drawn in both render paths so the "artwork stops
 * here" line shows before anything is placed.
 *
 * The yielded overlay is built whatever the binding and hidden when it doesn't apply: the warp is
 * cached per chart, so the per-rebuild cost is the BufferGeometry, and a `visible` flip lets a row
 * click refresh it without a rebuild.
 */
function addZoneOverlays(
  xf: ReturnType<typeof asmPartTransformGroup>,
  part: (typeof state.assembly.parts)[number],
): void {
  if (!part.zones?.length) return;
  const showYield = yieldedHatchVisible();
  for (const z of part.zones) {
    const chart = z.chart;
    if (!chart) continue;
    const hasDead = !!chart.deadRegions?.length;
    const hasYield = !!chart.netExcluded?.length;
    if (!hasDead && !hasYield) continue;
    let built = overlayCache.get(chart);
    if (built === undefined) {
      // Caught per zone: this decoration must never cost the model. renderRawAssemblyParts is the
      // fallback that keeps bare parts on screen and calls here too, so a throw would empty that
      // viewport. The mapper's constructor is the first real validation of the chart
      // (reconstructChart only range-checks indices) and deadOverlayMesh reads ring[0] directly, so a
      // malformed sidecar arrives as a TypeError, not a null.
      // One mapper for both hatches, builds caught apart: a malformed ring in one list mustn't take
      // the other's hatch, and only the hidden-surface one warrants a warning, and only on a zone that
      // HAS hidden surface (a refused chart on a yield-only zone loses a hatch about surface that
      // still cuts elsewhere — the silence netExcludedOverlayMesh records).
      let mapper: ConformalZoneMapper | null = null;
      let dead: OverlayMesh | null = null;
      let yielded: OverlayMesh | null;
      let deadFailed = false;
      try {
        mapper = new ConformalZoneMapper(null, chart, z.id);
      } catch {
        deadFailed = true;
      }
      try {
        dead = mapper && hasDead ? scaleToPitch(mapper.deadOverlayMesh()) : null;
      } catch {
        deadFailed = true;
      }
      if (hasDead && deadFailed)
        // z.id, or every zone shares the dedupe key and the second failure is swallowed.
        warn(
          `Couldn't shade the hidden surface on "${z.id}". Artwork still won't cut there. ` +
            `Only the hatching is missing. Please report this.`,
          `dead-overlay-${z.id}`,
        );
      try {
        yielded = mapper && hasYield ? scaleToPitch(mapper.netExcludedOverlayMesh()) : null;
      } catch {
        yielded = null;
      }
      built = { dead, yielded };
      overlayCache.set(chart, built);
    }
    const { dead, yielded } = built;
    for (const [built, kind] of [
      [dead, 'dead'],
      [yielded, 'yielded'],
    ] as const) {
      if (!built) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(built.positions, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(built.uv, 2));
      const mesh = new THREE.Mesh(geo, hatchMaterial(kind));
      // Invisible to every raycast: floating 0.4mm proud, it reads to zone picking's occlusion test
      // (OCCLUSION_TOL_MM = 0.05) as a solid part covering the chart. Measured on the chair over a
      // 61x61 NDC grid at 1440x900, default view: without this the seat drops from 50 pickable points
      // to 18, the front zone 111 to 76, the left fender 63 to 52 — a click on hatch selects nothing.
      mesh.raycast = () => {};
      if (kind === 'yielded') {
        mesh.userData[YIELD_OVERLAY] = true;
        mesh.visible = showYield;
      }
      xf.add(mesh);
    }
  }
}

/** Show the bare loaded parts (no cuts) as soon as they load, so selecting the assembly doesn't leave the viewport empty until an SVG is dropped in. */
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
    addZoneOverlays(xf, part);
    tris += part.positions.length / 9;
  });
  $('#stat-tris').textContent = Math.round(tris) + ' tris';
}

/**
 * Pose the assembly for display: turn it into the kind's display frame, then stand it on the grid,
 * centered and resting on it.
 *
 * Parts are never transformed at load: the wheel's native coordinates straddle z=0 and the chair's
 * are a CAD frame whose origin is a datum, not the middle (its footprint runs 4..662mm along grid Y,
 * so uncentered it stood almost entirely off the back edge). Viewport-only: cuts, baked charts and
 * export placement read the parts, not the scene.
 *
 * Rotation is applied BEFORE measuring, since it changes which face is lowest and where the
 * footprint lies — the chair's rearmost face was resting on the grid.
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

/**
 * Every instance whose source still resolves, each with its own placement and zone binding.
 * Exported for tests: it is the whole of the whole-part and mirror expansion, and every branch
 * produces a placement or says why not.
 */
export function artworkBuildInputs(): ArtworkBuildInput[] {
  const artworks: ArtworkBuildInput[] = state.artworks.flatMap((a) => {
    const source = state.sources.find((s) => s.id === a.sourceId);
    const parsed = source?.parsed ?? state.parsed;
    if (!parsed) return [];
    const primary: ArtworkBuildInput = {
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
    };
    // A whole-part instance is one placement per net zone, each moved onto its own sheet. Same shape as the mirror expansion: the build sees ordinary artworks and the geometry never knows the net exists.
    if (a.zone?.zoneId === WHOLE_CHAIR_ZONE) {
      const net = netZones();
      // The binding survives a part switch and a restore, so it can outlive its net. Cutting nothing unsaid is what rule 1 forbids.
      if (!net) {
        warnBuild(
          `"${source?.name ?? 'This design'}" is set to cover the whole part, but this part has no ` +
            `whole-part sheet. Pick a single zone for it from the list.`,
        );
        return [];
      }
      // Named, not id'd: "wing-left" is the bake's word; everything beside it reads the dropdown's name.
      for (const z of net.missing)
        warnBuild(
          `The "${z.name}" zone isn't loaded, so "${source?.name ?? 'this design'}" won't be cut ` +
            `there. Reload the page to try again.`,
        );
      for (const z of net.unplaced)
        noticeBuild(
          `The "${z.name}" zone isn't on the whole-part sheet, so "${source?.name ?? 'this design'}" ` +
            `won't reach it. Add another design and target that zone.`,
        );
      return net.zones.map((z) =>
        netToZoneBuildInput(primary, z.zoneId, z.place, net.netCentre, z.zoneCentre),
      );
    }
    // A mirrored instance is two placements: its own and its reflection on the twin zone (or the other half of a self-mirrored one); the geometry never knows they're related. A flag on a zone with no mirror is ignored, not guessed at; state clears it on rebind.
    const mirror = a.mirror && a.zone ? zoneMirrorOf(a.zone.zoneId) : undefined;
    if (!mirror) return [primary];
    const paired = { ...primary, mirrorPair: a.id };
    if ('twin' in mirror) return [paired, mirroredBuildInput(paired, mirror.twin)];
    // Tie rule only (ArtworkBuildInput.keepSide): at Offset 0 the right half is kept, as the template's "design the right half" promises.
    const keepSide: KeepSide = primary.offX >= 0 ? 'right' : 'left';
    const own = { ...paired, keepSide };
    return [own, mirroredBuildInput(own, own.zoneId ?? null)];
  });
  // state.parsed without an instance shouldn't happen (loadArtworkSource creates one), so fall back
  // to the globals rather than build nothing.
  //
  // Gated on no instance at all, not an empty expansion: an instance that expanded to nothing has
  // already said why, and this would cut it across every zone — the opposite of what was said.
  if (!state.artworks.length && state.parsed)
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
  return artworks;
}

async function rebuildAssemblyScene(): Promise<void> {
  // Re-stated per pass: every artwork load calls clearWarnings(), which would drop a push-once notice
  // while the part is still missing (same as csgFault's resetCsgFaults).
  warnMissingParts(state.assembly.parts);
  // The sliders and gizmo write the legacy globals; the instance is where assembly mode reads
  // placement. Sync FIRST: a part whose shape follows the artwork is regenerated below and reads the
  // instance, and left later its outline was built from the previous placement and the picture from
  // the new one. Idempotent; the call further down stays so the non-generated path is unchanged.
  syncActiveArtworkPlacement();

  // BEFORE the no-artwork branch: a part whose shape follows the artwork must rebuild when the artwork goes, which that branch returns early for — removing the last image left the hubcap cut to a silhouette unexplained.
  if (generatedPartsNeedRebuild()) await asmRebuildGeneratedParts({ schedule: false });

  // Once per pass, since every input that sizes a design ends in a rebuild (Scale, hubcap diameter,
  // Design radius, kind or Sticker/Fill switch, a second placement). After the generated parts,
  // because a cut-to-artwork hubcap sets the size the trace is read at; then again, since that part
  // follows the new trace. A trace can cost ~830ms, so a live pass only asks for a settled one.
  const traces = retraceMovedSources(rebuildSettled());
  if (traces.retraced) {
    renderArtworkList();
    if (generatedPartsNeedRebuild()) await asmRebuildGeneratedParts({ schedule: false });
  }
  if (traces.owed) scheduleRebuild('typed');

  // A part cut to its own artwork centres on its mounting axis and the offset is solved for, not
  // chosen: moving the picture relative to a part that IS the picture isn't meaningful, and the cut
  // adds the face's own centre, which for a silhouette is what's being offset. Written to the
  // instance and the legacy globals so the Fit sliders show what's in force.
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
    newModelGroup();
    renderRawAssemblyParts();
    poseAssemblyForDisplay();
    renderColorList(null);
    renderWarnings();
    setExportReady(false, 'Load a design to export.');
    if (!state.assembly.parts.some((p) => p.loaded)) $('#stat-tris').textContent = '0 tris';
    const primary = state.assembly.parts.find((p) => p.loaded && !p.isDuplicateOf);
    const nrm = primary ? asmPartFaceNormal(primary, state.assembly.parts) : null;
    setPreferredViewDir(assemblyViewDir(currentAssemblyKind(), nrm && nrm[1] < 0 ? -1 : 1));
    refreshModelShadows();
    frameModelIfPending();
    return;
  }

  // Placement still comes from the global sliders (the panel wires them to the active instance); synced so assembly code reads it through the instance without changing the value reaching the build.
  syncActiveArtworkPlacement();

  const artworks = artworkBuildInputs();
  // The default binding (loadArtworkSource) silently picks the first zone, since binding every zone
  // recuts everything on each nudge. Surfaced here rather than left to the per-row dropdown: it
  // caught scripts/export-chair-examples.mjs's own author, and yields a print that looks right
  // (colored patch, nonzero color count) until opened in a slicer.
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
  // The scene is torn down only once the build has answered: it runs in a worker, so the last
  // result stays on screen, orbitable, until there is something to replace it with.
  let built: AssemblyBuild | null;
  try {
    built = await runAssemblyBuild({
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
      designFaceOverride: generatedDesignFaceOverride(),
      generatedFit: generatedFitFactor(),
    });
  } catch (e) {
    // Whatever went wrong, the last result is still on screen and no longer matches the panels.
    lastAssemblyBuild = null;
    const cancelled = e instanceof RebuildCancelled;
    setExportReady(
      false,
      cancelled
        ? 'The rebuild was cancelled. Change a setting to rebuild.'
        : "The rebuild didn't finish. See the warnings.",
    );
    if (!cancelled && !(e instanceof BuildWorkerCrashed) && !(e instanceof BuildWorkerFault))
      throw e;
    // Caught here, not in the scheduler, so the tail of rebuildCurrent still runs: it has the only
    // schedulePersist outside export, and skipping it left a cancelled change unsaved on reload.
    //
    // Left on screen rather than redrawn bare: that redraw was most of a Cancel's latency on the
    // chair. A cancelled build's diagnostics describe unfinished parts, so they go.
    if (cancelled) clearBuildWarnings();
    else warnBuild((e as Error).message);
    renderWarnings();
    return;
  }
  lastAssemblyBuild = built;
  const modelGroup = newModelGroup();
  if (!built) {
    // Build failed/refused: keep the bare wheel on screen and surface the build's warn()s — an emptied viewport reads as a crash.
    renderRawAssemblyParts();
    poseAssemblyForDisplay();
    renderColorList(null);
    renderWarnings();
    setExportReady(false, "The rebuild didn't finish. See the warnings.");
    refreshModelShadows();
    frameModelIfPending();
    return;
  }

  // Open looking at the design face (+normal side), not the wheel's blank back — or a display-frame kind's front.
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
    // `bodyIndexed` is absent when the part never went through a boolean (no artwork, or a failed
    // cut); its soup is then `part.positions` verbatim, which `part.indexed` describes, so shading
    // still gets the fast path. Read here, not filled in on the build output, because `bodyIndexed`
    // is also what 3MF export writes and an uncut part's export must not change.
    xf.add(new THREE.Mesh(bufferGeometryFromTris(bodySoup, bodyIndexed ?? part.indexed), baseMat));
    addZoneOverlays(xf, part);
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

  // Aggregate color list across the whole assembly (one design/palette), matching the colors export writes as materials so rows, slot count and file agree
  const shipped = shippedColorIndices(built.partOutputs);
  const colorListEntries: ColorListEntry[] = [];
  built.palette.forEach((c, ci) => {
    if (!shipped.has(ci)) return;
    let area = 0;
    built.partOutputs.forEach(({ bodySoup, inlaySoups }) => {
      if (bodySoup.length && inlaySoups[ci]) area += soupCapArea(inlaySoups[ci]);
    });
    colorListEntries.push({
      color: c.hex,
      key: c.key,
      members: c.members,
      isMergeGroup: c.isMerge,
      areaPct: area,
      appliedDepth: c.appliedDepth,
    });
  });
  const totalArea = colorListEntries.reduce((s, c) => s + c.areaPct, 0) || 1;
  colorListEntries.forEach((c) => {
    c.areaPct = (100 * c.areaPct) / totalArea;
  });
  if (built.baseAssigned) {
    // This areaPct is on the 2D-design scale (matches detectedColors), while the rows above are
    // cap areas of the cut inlays (pre-merge, pre-cut vs after both), so the scales differ slightly.
    // Assembly-mode area is already an approximation; exact parity isn't worth the extra pass.
    colorListEntries.push({
      color: built.baseAssigned.hex,
      key: 'base:' + built.baseAssigned.hex,
      members: state.baseColorMembers,
      isMergeGroup: false,
      areaPct: built.baseAssigned.areaPct,
      isBase: true,
    });
    // keep the dominant member in sync so the top fallback area and the 3D body agree; no scheduleRebuild — this mirrors what the build computed
    state.baseColorKey = built.baseAssigned.hex;
  }

  poseAssemblyForDisplay();
  $('#stat-tris').textContent = Math.round(tris) + ' tris';
  renderColorList(colorListEntries, { rawColorCount: built.detectedColors.length });
  renderBaseColorSwatches();
  renderWarnings();
  // No inlay and no color turned body color: the file would print a blank part.
  if (!built.partOutputs.length) setExportReady(false, 'There is no part to print yet.');
  else if (!shipped.size && !built.baseAssigned)
    setExportReady(false, 'No color lands on the part. Move the design or lower Scale.');
  else setExportReady(true);
  refreshModelShadows();
  frameModelIfPending();
}
