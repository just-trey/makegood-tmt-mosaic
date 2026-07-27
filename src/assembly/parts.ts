import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import type { AssemblyPart, AssemblyRole, DesignZone, LibraryEntry } from '../types';
import { state } from '../state/store';
import { scheduleRebuild } from '../app/scheduler';
import { requestFrame } from '../scene/viewport';
import { hideOverlay, showOverlay } from '../ui/overlay';
import {
  detectFlatPatches,
  extractPatchBoundary,
  excludeTriangles,
  load3MF,
} from '../geometry/meshparts';
import { fingerprintMatches, loadZonesSidecar, reconstructChart } from '../geometry/zoneCharts';
import { warn } from '../warnings';
import { track } from '../analytics/track';
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
    alert(
      `Can't auto-load ${kind.name}: the parts library (stl/parts.json) isn't reachable. Check the deployment or drag the parts in manually.`,
    );
    return;
  }
  if (
    state.assembly.parts.length &&
    !confirm(`Load the full ${kind.name}? This clears any parts you've already added.`)
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
    alert('Failed to load the assembly: ' + (e as Error).message);
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
    !confirm(
      `Switch to ${kind.variants.find((v) => v.id === variantId)?.name}? This reloads the caster mounts.`,
    )
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
    alert('Failed to load the caster mounts: ' + (e as Error).message);
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
  try {
    const res = await fetch(entry.file);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = await res.arrayBuffer();
    await asmLoadPartBuffer(part, buf, entry.file);
  } catch (e) {
    alert(
      `Could not load library part "${entry.name}" from ${entry.file}: ${(e as Error).message}`,
    );
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
  part.positions = positions;
  part.patches = detectFlatPatches(positions);
  requestFrame(); // new part geometry — re-fit the view
  part.patchIdx = defaultPatchIdx(part); // largest-area patch, or the role's preferred face
  applyAsmPatchChoice(part);
  await attachBakedZones(part, positions.length / 9);
  part.loaded = true;
  notifyPartsChanged();
  scheduleRebuild();
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
  try {
    await asmLoadPartBuffer(part, buf, file.name);
  } catch (e) {
    alert((e as Error).message);
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
