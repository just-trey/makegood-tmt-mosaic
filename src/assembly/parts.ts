import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import type { AssemblyPart, AssemblyRole, DesignZone, LibraryEntry } from '../types';
import { state } from '../state/store';
import { scheduleRebuild } from '../app/scheduler';
import { beginWork, endWork } from '../app/idle';
import { requestFrame } from '../scene/viewport';
import { hideOverlay, showOverlay } from '../ui/overlay';
import {
  detectFlatPatches,
  extractPatchBoundary,
  excludeTriangles,
  load3MF,
} from '../geometry/meshparts';
import { fingerprintMatches, loadZonesSidecar, reconstructChart } from '../geometry/zoneCharts';
import { dismissNotice, warn } from '../warnings';
import { track } from '../analytics/track';
import { alertDialog, confirmDialog } from '../ui/dialogs';
import {
  asmKindCanAutoLoad,
  currentAssemblyKind,
  currentVariantId,
  roleLibraryPartId,
} from './kinds';

// The assembly panel registers its render functions here, so part management can refresh the
// UI without importing it (keeps the module graph acyclic).
let notifyPartsChanged: () => void = () => {};
export function onAssemblyPartsChanged(fn: () => void): void {
  notifyPartsChanged = fn;
}

export function asmCreateRolePart(role: AssemblyRole): AssemblyPart {
  const id = state.assembly.nextPartId++;
  const part: AssemblyPart = {
    id,
    name: role.name,
    roleId: role.id,
    positions: null,
    patches: null,
    patchIdx: 0,
    boundaryLoop: null,
    topZ: 0,
    baseDepth: 3.0,
    isDuplicateOf: null,
    pivotX: 0,
    pivotZ: 0,
    angleDeg: 180,
    loaded: false,
    cutThrough: !!role.cutThrough,
    cutThroughDepth: role.cutThroughDepth,
  };
  state.assembly.parts.push(part);
  return part;
}

export function asmAddRolePart(role: AssemblyRole): void {
  const part = asmCreateRolePart(role);
  notifyPartsChanged();
  const partId = roleLibraryPartId(role, currentVariantId());
  const entry = partId ? state.assembly.library.find((e) => e.id === partId) : undefined;
  if (entry) void asmLoadLibraryEntryIntoPart(part, entry);
}

/**
 * One-click "load the whole assembly": fetch + face-detect every role's primary, then add its
 * default rotated copies. Awaits each primary's load before duplicating it, since a rotated
 * copy clones the source's (by-then loaded) geometry.
 */
export async function asmLoadFullAssembly(): Promise<void> {
  const kind = currentAssemblyKind();
  if (!kind) return;
  if (!asmKindCanAutoLoad(kind)) {
    await alertDialog(
      `Can't auto-load ${kind.name}: the parts library (stl/parts.json) isn't reachable. Check the deployment or drag the parts in manually.`,
    );
    return;
  }
  if (
    state.assembly.parts.length &&
    !(await confirmDialog(
      `Load the full ${kind.name}? This clears any parts you've already added.`,
    ))
  )
    return;
  state.assembly.parts = [];
  const myParts = state.assembly.parts;
  showOverlay(`Loading ${kind.name}…`);
  try {
    const variantId = currentVariantId();
    for (const role of kind.roles) {
      const partId = roleLibraryPartId(role, variantId);
      const entry = partId ? state.assembly.library.find((e) => e.id === partId) : undefined;
      const primary = asmCreateRolePart(role);
      if (entry) await asmLoadLibraryEntryIntoPart(primary, entry);
      // A part-kind switch mid-load replaces state.assembly.parts with a fresh array and kicks off
      // its own load; if that happened while we awaited the fetch, stop here so we don't push this
      // kind's parts into the new kind's list. The newer load owns the overlay and final refresh.
      if (state.assembly.parts !== myParts) return;
      if (role.allowRotatedCopies) {
        for (let i = 0; i < (role.copies || 0); i++) {
          const dup = asmAddDuplicate(primary.id, role.copyName);
          if (dup && role.copyDefaults) Object.assign(dup, role.copyDefaults);
        }
      }
    }
  } catch (e) {
    console.error(e);
    await alertDialog('Failed to load the assembly: ' + (e as Error).message);
  }
  notifyPartsChanged();
  hideOverlay();
  scheduleRebuild();
}

/**
 * Switch the chair's hardware variant (Standard/Kit): reloads only the roles that actually differ
 * per variant (today, the two caster mounts — see `AssemblyRole.libraryPartIdByVariant`), leaving
 * every other loaded part untouched. Confirms first if any of those roles already has a part
 * loaded, since a re-fetch discards whatever per-part edits (face pick, base thickness) the user
 * made on it. A no-op if `variantId` is already current, or the kind has no variants at all.
 */
export async function switchChairVariant(variantId: string): Promise<void> {
  const kind = currentAssemblyKind();
  if (!kind?.variants?.length || variantId === currentVariantId()) return;
  const variantRoles = kind.roles.filter((r) => r.libraryPartIdByVariant);
  const affected = state.assembly.parts.filter((p) => variantRoles.some((r) => r.id === p.roleId));
  if (
    affected.length &&
    !(await confirmDialog(
      `Switch to ${kind.variants.find((v) => v.id === variantId)?.name}? This reloads the caster mounts.`,
    ))
  )
    return;

  state.assembly.variantId = variantId;
  state.assembly.parts = state.assembly.parts.filter(
    (p) => !variantRoles.some((r) => r.id === p.roleId),
  );
  notifyPartsChanged();
  showOverlay('Loading caster mounts…');
  try {
    for (const role of variantRoles) {
      const partId = roleLibraryPartId(role, variantId);
      const entry = partId ? state.assembly.library.find((e) => e.id === partId) : undefined;
      const part = asmCreateRolePart(role);
      if (entry) await asmLoadLibraryEntryIntoPart(part, entry);
    }
  } catch (e) {
    console.error(e);
    await alertDialog('Failed to load the caster mounts: ' + (e as Error).message);
  }
  notifyPartsChanged();
  hideOverlay();
  scheduleRebuild();
  track('chair_variant_selected', { variant: variantId });
}

export async function asmLoadLibraryEntryIntoPart(
  part: AssemblyPart,
  entry: LibraryEntry,
): Promise<void> {
  if (entry.baseDepth) part.baseDepth = entry.baseDepth;
  part.libraryPartId = entry.id;
  part.meshFromUpload = false;
  beginWork();
  try {
    const res = await fetch(entry.file);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = await res.arrayBuffer();
    await asmLoadPartBuffer(part, buf, entry.file);
  } catch (e) {
    await alertDialog(
      `Could not load library part "${entry.name}" from ${entry.file}: ${(e as Error).message}`,
    );
  } finally {
    endWork();
  }
}

export function asmAddRoleDuplicate(role: AssemblyRole): void {
  const src = state.assembly.parts.find((p) => p.roleId === role.id && !p.isDuplicateOf);
  if (!src) return;
  asmAddDuplicate(src.id, role.copyName);
}

export function asmAddDuplicate(sourceId: number, copyName?: string): AssemblyPart | null {
  const src = state.assembly.parts.find((p) => p.id === sourceId);
  if (!src) return null;
  const id = state.assembly.nextPartId++;
  const dup: AssemblyPart = {
    id,
    name: copyName ?? `${src.name} (rotated copy)`,
    roleId: src.roleId,
    positions: src.positions,
    vertices: src.vertices,
    libraryPartId: src.libraryPartId,
    meshFromUpload: src.meshFromUpload,
    patches: src.patches,
    patchIdx: src.patchIdx,
    boundaryLoop: src.boundaryLoop,
    restPositions: src.restPositions,
    // Conformal charts are baked in the source's native frame and (unlike the flat placer) carry
    // no inverse-rotation remap, so a *rotated* copy of a charted part would cut in the wrong
    // place. Unreachable today — every role on the only zoned kind sets allowRotatedCopies:false.
    zones: src.zones,
    topZ: src.topZ,
    baseDepth: src.baseDepth,
    patchNormal: src.patchNormal,
    isDuplicateOf: sourceId,
    pivotX: 0,
    pivotZ: 0,
    angleDeg: 180,
    loaded: src.loaded,
    cutThrough: src.cutThrough,
    cutThroughDepth: src.cutThroughDepth,
    edgeCutThroughDepth: src.edgeCutThroughDepth,
  };
  state.assembly.parts.push(dup);
  notifyPartsChanged();
  return dup;
}

export function asmRemovePart(id: number): void {
  state.assembly.parts = state.assembly.parts.filter((p) => p.id !== id && p.isDuplicateOf !== id);
  notifyPartsChanged();
  requestFrame();
  scheduleRebuild();
}

/**
 * Default design-face patch for a freshly loaded part: the role's preferred-normal face if it
 * declares one (patches are area-ranked, so the first match is the largest such face), otherwise
 * the overall largest patch. Falls back to 0 when nothing points the preferred way.
 */
function defaultPatchIdx(part: AssemblyPart): number {
  const patches = part.patches;
  if (!patches || !patches.length) return 0;
  const pref = currentAssemblyKind()?.roles.find((r) => r.id === part.roleId)?.preferFaceNormal;
  if (!pref) return 0;
  const idx = patches.findIndex((p) => {
    const dot = p.normal[0] * pref[0] + p.normal[1] * pref[1] + p.normal[2] * pref[2];
    return dot > 0.9;
  });
  return idx >= 0 ? idx : 0;
}

/** Core mesh-buffer loader, shared by drag-and-drop upload and the parts library (fetch()). */
export async function asmLoadPartBuffer(
  part: AssemblyPart,
  buf: ArrayBuffer,
  filename: string,
): Promise<void> {
  const lower = filename.toLowerCase();
  let positions: Float32Array;
  if (lower.endsWith('.3mf')) {
    const r = await load3MF(buf);
    positions = r.positions;
    part.vertices = r.vertices;
  } else if (lower.endsWith('.stl')) {
    const geo = new STLLoader().parse(buf);
    positions = geo.attributes.position.array as Float32Array;
  } else {
    throw new Error('Unsupported file type — use .stl or .3mf');
  }
  await asmAdoptMesh(part, positions);
}

/**
 * Take a mesh as the part's geometry: detect its faces, pick a design face, attach baked zones,
 * and get the scene moving. Shared by the file loader above and by generated parts, so the two
 * can't drift — the ordering at the end of this function is load-bearing and was got wrong once
 * already (see the requestFrame comment).
 *
 * For a role that builds its own mesh (AssemblyRole.buildMesh), `positions` is the *asset*, and
 * the built result is what the part actually keeps.
 */
async function asmAdoptMesh(
  part: AssemblyPart,
  positions: Float32Array,
  opts: { schedule?: boolean } = {},
): Promise<void> {
  const role = currentAssemblyKind()?.roles.find((r) => r.id === part.roleId);
  // A dropped file REPLACES the part, on a generated role as much as any other — running the
  // builder over it would hand back the user's mesh with a generated disc fused onto it, which is
  // not what dropping in a mesh means anywhere else in the app. Clearing assetPositions also keeps
  // resolvePlacement reporting it as the upload it is rather than as a generated part.
  if (role?.buildMesh && !part.meshFromUpload) {
    part.assetPositions = positions;
    const built = await role.buildMesh(positions);
    positions = built.positions;
    part.vertices = built.vertices;
    // Assigned unconditionally, including when the generator returns undefined: the rule belongs
    // to the mesh currently on the part, so a rebuild that falls back to a plain circle has to
    // clear the rule the previous silhouette set rather than leave it standing.
    part.edgeCutThroughDepth = built.edgeCutThroughDepth;
    if (part.buildWarning) dismissNotice(part.buildWarning);
    part.buildWarning = built.warning;
    if (built.warning) warn(built.warning);
  } else if (part.meshFromUpload) {
    part.assetPositions = undefined;
    part.edgeCutThroughDepth = undefined;
    if (part.buildWarning) dismissNotice(part.buildWarning);
    part.buildWarning = undefined;
  }
  part.positions = positions;
  part.patches = detectFlatPatches(positions);
  part.patchIdx = defaultPatchIdx(part); // largest-area patch, or the role's preferred face
  applyAsmPatchChoice(part);
  await attachBakedZones(part, positions.length / 9);
  part.loaded = true;
  // After `loaded`, not before: rebuild.ts renders only loaded parts, so a frame requested
  // earlier can be consumed by a rebuild this part isn't in yet — and nothing requests another.
  // The chair's thirteen parts load concurrently, which is what made that window reachable: the
  // view ended up fitted to whichever subset had finished.
  requestFrame();
  notifyPartsChanged();
  // Skipped when a rebuild is already the caller — otherwise regenerating a part *during* a
  // rebuild queues another one, and a part whose shape follows the artwork would do that on
  // every single pass.
  if (opts.schedule !== false) scheduleRebuild();
}

/**
 * A stable per-object id for a parsed artwork, so the signature below can say "this is a different
 * parse" without comparing contents.
 *
 * `parsed` is treated as immutable once parsed (regions.ts memoises on it), so a re-trace produces
 * a new object and a mere re-render does not — which makes identity exactly the right test. A
 * WeakMap because the ids must not keep a discarded parse alive.
 */
const parsedIds = new WeakMap<object, number>();
let nextParsedId = 1;
function parsedId(parsed: object | null | undefined): number {
  if (!parsed) return 0;
  let id = parsedIds.get(parsed);
  if (id === undefined) parsedIds.set(parsed, (id = nextParsedId++));
  return id;
}

/**
 * What a generated part's shape currently depends on, as a string.
 *
 * The hubcap's silhouette follows the artwork, so its mesh has to be rebuilt whenever the artwork
 * changes — and "the artwork changed" happens through a load, a re-trace, a removal, a restored
 * session and a zone rebinding, which is too many places to hook one at a time. The rebuild runs
 * for all of them, so it asks this instead, and rebuilds only when the answer moved.
 *
 * Identity rather than shape COUNT, which is what this compared first and is not the same test:
 * re-quantizing an image at a new Detail setting usually lands on the same number of colours, so
 * the count held still while the outline underneath it changed, and the part stayed cut to the
 * previous trace while the picture on it updated.
 *
 * The placement terms are here for the same reason: the silhouette is placed by the artwork's own
 * scale, rotation, flips and offset (see hubcapShapeFromState), so each of them changes the SHAPE
 * of the part and not just where the cut lands on it.
 */
function generatedShapeSignature(): string {
  const kind = currentAssemblyKind();
  if (!kind?.roles.some((r) => r.buildMesh)) return '';
  const sil = state.hubcapSilhouette;
  const art = state.artworks[0];
  return [
    sil ? 'sil' : 'circle',
    state.hubcapDiameterMm,
    state.artworks.length,
    state.sources.length,
    state.sources.map((src) => parsedId(src.parsed)).join(','),
    sil ? parsedId(state.parsed) : 0,
    // every one of these moves the outline, not just the artwork on it
    sil ? (art?.scalePct ?? state.scalePct) : 0,
    sil ? (art?.rotationDeg ?? state.rotationDeg) : 0,
    sil ? (art?.offsetU ?? state.offsetX) : 0,
    sil ? (art?.offsetV ?? state.offsetY) : 0,
    sil ? `${art?.flipX ?? state.flipX}${art?.flipY ?? state.flipY}` : '',
  ].join('|');
}

let lastGeneratedSignature: string | null = null;

/** Whether a generated part's inputs have moved since it was last built. */
export function generatedPartsNeedRebuild(): boolean {
  return generatedShapeSignature() !== lastGeneratedSignature;
}

/**
 * Re-run every generated part's builder — for when a build parameter (the hubcap's diameter) or
 * the artwork its shape follows changes. Rebuilds from the cached asset, so no part is re-fetched.
 *
 * Reports a failure the same way the load path does rather than letting it reject. The caller
 * fires this off with `void`, so an unhandled rejection would be invisible — and the state and the
 * control would already be showing the new size while the part in the scene, and in any export,
 * was still the old mesh. Saying nothing there is worse than the failure.
 */
export async function asmRebuildGeneratedParts(
  opts: { schedule?: boolean } = {},
): Promise<boolean> {
  const kind = currentAssemblyKind();
  const parts = state.assembly.parts.filter((p) => {
    const role = kind?.roles.find((r) => r.id === p.roleId);
    return role?.buildMesh && p.assetPositions;
  });
  // Read before the build, stored only after one that worked: the inputs can't move mid-await
  // (this is all one task), and recording them up front marked a FAILED rebuild as done. The
  // rebuild caller has nothing to put back, so the part kept its stale mesh and was never retried
  // — the signature said it was already current.
  const signature = generatedShapeSignature();
  if (!parts.length) {
    lastGeneratedSignature = signature;
    return true;
  }
  beginWork();
  try {
    for (const part of parts) await asmAdoptMesh(part, part.assetPositions!, opts);
    lastGeneratedSignature = signature;
    return true;
  } catch (e) {
    console.error(e);
    await alertDialog(
      `Could not rebuild "${kind?.name ?? 'the part'}" at the size you asked for: ` +
        `${(e as Error).message}. The part on screen is still the previous size.`,
    );
    // Reported rather than swallowed: the caller has already stored the new parameter, and the
    // mesh in the scene is still built from the old one. Anything reading the parameter to
    // describe the mesh -- the verified-plate lookup, the 1:1 template -- would be describing a
    // part that does not exist, so the caller has to be able to put the value back.
    return false;
  } finally {
    endWork();
  }
}

/**
 * Attach the kind's baked design zones to a freshly loaded part, when it has any. Sets
 * `part.zones` for every part of a sidecar-backed kind — including to `[]` for a piece the bake
 * gave no zone, which is what tells the build to leave that piece plain (see AssemblyPart.zones).
 * Parts of a kind with no sidecar are left untouched and keep the implicit flat zone.
 *
 * A failure here (unreachable sidecar, or a part re-packed since the bake so its fingerprint no
 * longer matches) warns and leaves the part zoneless rather than cutting against stale UV data.
 */
async function attachBakedZones(part: AssemblyPart, triCount: number): Promise<void> {
  const zonesFile = currentAssemblyKind()?.zonesFile;
  if (!zonesFile || !part.libraryPartId || !part.vertices) return;
  const partId = part.libraryPartId;
  const vertices = part.vertices;
  let sidecar;
  try {
    sidecar = await loadZonesSidecar(zonesFile);
  } catch (e) {
    warn(
      `Couldn't load the design zones for "${part.name}" (${zonesFile}: ${(e as Error).message}) — it will load without design surfaces.`,
    );
    // Zoneless, not sidecar-less: leaving this undefined would fall back to the implicit flat zone
    // and stamp the artwork orthographically onto the part's largest flat patch.
    part.zones = [];
    return;
  }
  // Every zone/chart pair baked onto this part. Set even when empty: a piece the bake gave no zone
  // takes no artwork at all, which is not the same as having no sidecar (see AssemblyPart.zones).
  const baked = sidecar.zones.flatMap((zone) =>
    zone.charts.filter((c) => c.libraryPartId === partId).map((chart) => ({ zone, chart })),
  );
  part.zones = [];
  if (!baked.length) return;

  // One fingerprint check for the part, not one per chart — it rescans every vertex.
  if (!fingerprintMatches(sidecar, partId, vertices, triCount)) {
    warn(
      `Part "${part.name}" doesn't match the mesh its design zones were baked against, so its artwork surfaces are unavailable. Re-run the zone bake for this part.`,
    );
    return;
  }
  const zones: DesignZone[] = [];
  for (const { zone, chart } of baked) {
    try {
      zones.push({
        id: zone.id,
        name: zone.name,
        templateFile: zone.templateFile,
        chart: reconstructChart(zone, chart, vertices),
      });
    } catch (e) {
      warn(
        `Design zone "${zone.name}" couldn't be applied to "${part.name}": ${(e as Error).message}`,
      );
    }
  }
  part.zones = zones;
}

export async function asmLoadPartFile(part: AssemblyPart, file: File): Promise<void> {
  const buf = await file.arrayBuffer();
  // Set before the load, not after: a throw part-way still leaves whatever mesh state it got to,
  // and that mesh is the user's either way. libraryPartId deliberately stays (see meshFromUpload).
  part.meshFromUpload = true;
  try {
    await asmLoadPartBuffer(part, buf, file.name);
  } catch (e) {
    await alertDialog((e as Error).message);
  }
}

export function applyAsmPatchChoice(part: AssemblyPart): void {
  if (!part.patches || !part.patches.length || !part.positions) return;
  const patch = part.patches[part.patchIdx];
  part.topZ = patch.offset;
  part.patchNormal = patch.normal;
  const loops = extractPatchBoundary(part.positions, patch.triIndices);
  loops.sort((a, b) => b.length - a.length);
  part.boundaryLoop = loops[0] || null;
  part.restPositions = excludeTriangles(part.positions, patch.triIndices);
}

/**
 * Parts library: project-specific STL/3MF files listed in stl/parts.json, so a role with a
 * matching libraryPartId auto-loads instead of requiring drag-and-drop. Purely additive — a
 * missing/unreachable manifest just leaves the library empty and roles fall back to
 * drag-and-drop. Adding a new part is "drop the file in public/stl/ + add one manifest entry".
 */
export async function loadPartsLibrary(): Promise<void> {
  beginWork();
  try {
    // stl/parts.json is a stable (non-content-hashed) URL, unlike the JS bundle — tag it with
    // the app version so a returning visitor's cached pre-release manifest can't silently lag
    // behind a bundle that already knows about a newer part (e.g. the footrest launch).
    const v = typeof __APP_VERSION__ === 'undefined' ? 'dev' : __APP_VERSION__;
    const res = await fetch(`stl/parts.json?v=${v}`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    state.assembly.library = await res.json();
    // the manifest may land after the user already opened Assembly mode — re-render and
    // auto-load now that the library (which auto-load depends on) is available.
    if (state.shapeKind === 'assembly') {
      notifyPartsChanged();
      maybeAutoLoadAssembly();
    }
  } catch {
    // no manifest present — silently do nothing, this is optional
  } finally {
    endWork();
  }
}

/**
 * Auto-load the whole assembly the moment Assembly mode is active and the library is reachable,
 * so the user never has to click "Load full …". No-op if parts are already present or the
 * library isn't available, where manual add buttons are shown instead.
 */
export function maybeAutoLoadAssembly(): void {
  if (state.shapeKind !== 'assembly') return;
  const kind = currentAssemblyKind();
  if (kind && asmKindCanAutoLoad(kind) && state.assembly.parts.length === 0) {
    void asmLoadFullAssembly();
  }
}
