import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import type { AssemblyPart, AssemblyRole, LibraryEntry } from '../types';
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
import { asmKindCanAutoLoad, currentAssemblyKind } from './kinds';

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
  const entry = role.libraryPartId
    ? state.assembly.library.find((e) => e.id === role.libraryPartId)
    : undefined;
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
    for (const role of kind.roles) {
      const entry = role.libraryPartId
        ? state.assembly.library.find((e) => e.id === role.libraryPartId)
        : undefined;
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

export async function asmLoadLibraryEntryIntoPart(
  part: AssemblyPart,
  entry: LibraryEntry,
): Promise<void> {
  if (entry.baseDepth) part.baseDepth = entry.baseDepth;
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
    patches: src.patches,
    patchIdx: src.patchIdx,
    boundaryLoop: src.boundaryLoop,
    restPositions: src.restPositions,
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
  part.loaded = true;
  notifyPartsChanged();
  scheduleRebuild();
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
