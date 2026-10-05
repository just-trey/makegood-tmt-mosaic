import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import type { AssemblyPart, AssemblyRole, DesignZone, IndexedMesh, LibraryEntry } from '../types';
import { state } from '../state/store';
import { scheduleRebuild } from '../app/scheduler';
import { beginWork, endWork } from '../app/idle';
import { requestFrame } from '../scene/viewport';
import { hideOverlay, showOverlay } from '../ui/overlay';
import {
  detectFlatPatches,
  extractPatchBoundary,
  loopXZArea,
  excludeTriangles,
  load3MF,
} from '../geometry/meshparts';
import { fingerprintMatches, loadZonesSidecar, reconstructChart } from '../geometry/zoneCharts';
import { WARNINGS, dismissNotice, warn } from '../warnings';
import { track } from '../analytics/track';
import { alertDialog, confirmDialog } from '../ui/dialogs';
import {
  asmKindCanAutoLoad,
  currentAssemblyKind,
  currentVariantId,
  roleLibraryPartId,
} from './kinds';

// The assembly panel registers its renderer here, keeping the module graph acyclic.
let onPartsChanged: () => void = () => {};
export function onAssemblyPartsChanged(fn: () => void): void {
  onPartsChanged = fn;
}
// Every path that drops a part ends here, so stale face-edge notices are retracted here; doing it
// at the six removal sites left notices naming parts that were gone.
function notifyPartsChanged(): void {
  const live = new Set(state.assembly.parts.map((p) => faceEdgeKey(p)));
  const stale: string[] = [];
  for (const w of WARNINGS)
    if (w.key && w.key.startsWith(FACE_EDGE_PREFIX) && !live.has(w.key)) stale.push(w.key);
  for (const k of stale) dismissNotice('', k);
  onPartsChanged();
}

const FACE_EDGE_PREFIX = 'face-edge:';
const faceEdgeKey = (part: AssemblyPart): string => FACE_EDGE_PREFIX + part.id;

export function asmCreateRolePart(role: AssemblyRole): AssemblyPart {
  const id = state.assembly.nextPartId++;
  const part: AssemblyPart = {
    id,
    name: role.name,
    roleId: role.id,
    positions: null,
    patches: null,
    patchIdx: 0,
    boundaryLoops: null,
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

export type AssemblyLoadOutcome = 'loaded' | 'skipped' | 'superseded' | 'failed';

/** Part lists whose load stopped part-way because another load replaced them. */
const abandonedLists = new WeakSet<AssemblyPart[]>();
export function asmLoadWasAbandoned(list: AssemblyPart[]): boolean {
  return abandonedLists.has(list);
}

/**
 * Load every role's primary, then its rotated copies (awaited: a copy clones loaded geometry).
 * Failures are already alerted; the result is for asmSwitchKindAndLoad. `skipped`: manifest in
 * flight or confirm cancelled; `superseded`: a newer load took the list mid-way.
 */
export async function asmLoadFullAssembly({ quiet = false } = {}): Promise<AssemblyLoadOutcome> {
  const kind = currentAssemblyKind();
  if (!kind) return 'skipped';
  if (!asmKindCanAutoLoad(kind)) {
    // In flight, return quietly: loadPartsLibrary calls back via maybeAutoLoadAssembly, so a
    // restore accepted mid-flight loads instead of showing a "reload the page" dialog.
    if (!partsLibrarySettled()) return 'skipped';
    if (!quiet) await alertDialog("Couldn't load this part. Reload the page to try again.");
    return 'failed';
  }
  if (
    state.assembly.parts.length &&
    !(await confirmDialog(
      `Load the full ${kind.name}? This clears any parts you've already added.`,
    ))
  )
    return 'skipped';
  state.assembly.parts = [];
  const myParts = state.assembly.parts;
  const curtain = showOverlay(`Loading ${kind.name}…`);
  let outcome: 'loaded' | 'failed' = 'loaded';
  try {
    const variantId = currentVariantId();
    for (const role of kind.roles) {
      const partId = roleLibraryPartId(role, variantId);
      const entry = partId ? state.assembly.library.find((e) => e.id === partId) : undefined;
      const primary = asmCreateRolePart(role);
      const primaryFailed =
        !!entry && !(await asmLoadLibraryEntryIntoPart(primary, entry, { quiet }));
      if (primaryFailed) outcome = 'failed';
      // A kind switch mid-await replaced the list; stop before pushing into it. The newer load
      // owns the final refresh, and its own curtain.
      if (state.assembly.parts !== myParts) {
        abandonedLists.add(myParts);
        hideOverlay(curtain);
        return 'superseded';
      }
      // A copy clones its primary's mesh, so a failed primary's copies would have none.
      if (role.allowRotatedCopies && !primaryFailed) {
        for (let i = 0; i < (role.copies || 0); i++) {
          const dup = asmAddDuplicate(primary.id, role.copyName);
          if (dup && role.copyDefaults) Object.assign(dup, role.copyDefaults);
        }
      }
    }
  } catch (e) {
    console.error(e);
    outcome = 'failed';
    if (!quiet) await alertDialog('Failed to load the assembly: ' + (e as Error).message);
  }
  notifyPartsChanged();
  hideOverlay(curtain);
  scheduleRebuild();
  return outcome;
}

/**
 * Switch Standard/Kit, reloading only the variant roles (the caster mounts). Confirms first if one
 * is loaded, since a re-fetch discards per-part edits (face pick, base thickness).
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

  const { variantId: prevVariant, parts: prevParts } = state.assembly;
  state.assembly.variantId = variantId;
  state.assembly.parts = prevParts.filter((p) => !variantRoles.some((r) => r.id === p.roleId));
  notifyPartsChanged();
  const curtain = showOverlay('Loading caster mounts…');
  const failedFiles: string[] = [];
  let thrown: Error | null = null;
  try {
    for (const role of variantRoles) {
      const partId = roleLibraryPartId(role, variantId);
      const entry = partId ? state.assembly.library.find((e) => e.id === partId) : undefined;
      const part = asmCreateRolePart(role);
      if (entry && !(await asmLoadLibraryEntryIntoPart(part, entry, { quiet: true })))
        failedFiles.push(entry.file);
    }
  } catch (e) {
    console.error(e);
    thrown = e as Error;
  }
  // Rolled back like asmSwitchKindAndLoad: a chair left on the new variant with a mount missing
  // would render and export without it once the alert was dismissed.
  const rolledBack = failedFiles.length > 0 || thrown !== null;
  if (rolledBack) {
    state.assembly.variantId = prevVariant;
    state.assembly.parts = prevParts;
  }
  notifyPartsChanged();
  hideOverlay(curtain);
  scheduleRebuild();
  if (rolledBack) {
    const was = kind.variants.find((v) => v.id === prevVariant)?.name ?? 'the old variant';
    const what = failedFiles.length
      ? `Couldn't load ${failedFiles.join(' or ')}.`
      : `Couldn't load the caster mounts: ${thrown!.message}.`;
    await alertDialog(`${what} The switch was undone: the chair is still on ${was}.`);
    return;
  }
  track('chair_variant_selected', { variant: variantId });
}

export async function asmLoadLibraryEntryIntoPart(
  part: AssemblyPart,
  entry: LibraryEntry,
  { quiet = false } = {},
): Promise<boolean> {
  if (entry.baseDepth) part.baseDepth = entry.baseDepth;
  part.libraryPartId = entry.id;
  beginWork();
  try {
    const res = await fetch(entry.file);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = await res.arrayBuffer();
    await asmLoadPartBuffer(part, buf, entry.file);
    return true;
  } catch (e) {
    const msg = `Could not load library part "${entry.name}" from ${entry.file}: ${(e as Error).message}`;
    if (quiet) console.error(msg);
    else await alertDialog(msg);
    return false;
  } finally {
    endWork();
  }
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
    // Same mesh, different pose: without the index it silently loses the fast shading path.
    indexed: src.indexed,
    libraryPartId: src.libraryPartId,
    patches: src.patches,
    // These three, `topZ` and `patchNormal` are the source's face, re-pushed by
    // `syncDuplicateFaces`. Change one list, change both.
    patchIdx: src.patchIdx,
    boundaryLoops: src.boundaryLoops,
    restPositions: src.restPositions,
    // Charts carry no inverse-rotation remap, so a *rotated* charted copy would cut in the wrong
    // place. Unreachable: every role on the only zoned kind sets allowRotatedCopies:false.
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

/** The role's preferred-normal face (patches are area-ranked, so the first match), else the largest. */
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

/** Core mesh-buffer loader. Every mesh the app takes comes through here, from the parts library. */
export async function asmLoadPartBuffer(
  part: AssemblyPart,
  buf: ArrayBuffer,
  filename: string,
): Promise<void> {
  const lower = filename.toLowerCase();
  let positions: Float32Array;
  let indexed: IndexedMesh | undefined;
  if (lower.endsWith('.3mf')) {
    const r = await load3MF(buf);
    positions = r.positions;
    part.vertices = r.vertices;
    // The index is a *claim* of shared corners; shading honours it, where the fallback welds at
    // 0.01mm regardless. Our parts are welded (all 19 at a 0.500 vertex-to-triangle ratio). On a 10
    // degree fold: cross-seam dot 0.9848 from an unwelded index vs 1.0000 from toCreasedNormals.
    // Passed to asmAdoptMesh to land with `part.positions`: a throw between would pair the
    // *previous* mesh with *this* index.
    indexed = { positions: r.vertices, indices: r.indices };
  } else if (lower.endsWith('.stl')) {
    const geo = new STLLoader().parse(buf);
    positions = geo.attributes.position.array as Float32Array;
    // STL is soup, so no index: three's toCreasedNormals fallback (1x, vs 8.7x indexed, see
    // CREASE_ANGLE_RAD). Every shipped entry is a 3MF. Welding first costs about what that hashing
    // does (358ms bench on the chair), so it would land near 1.5x, not 8.7x.
    //
    // **`part.vertices` deliberately stays.** `attachBakedZones` returns at `!part.vertices`
    // *before* clearing `part.zones`, so an STL over a 3MF would keep stale charts; left, the
    // fingerprint check sees the mismatch, drops the zones, and says so.
  } else {
    throw new Error('Unsupported file type: use .stl or .3mf');
  }
  await asmAdoptMesh(part, positions, {}, indexed);
}

/**
 * Adopt a mesh as the part's geometry. Shared by the loader and generated parts because the
 * ordering at the end is load-bearing (see requestFrame). With AssemblyRole.buildMesh, `positions`
 * is the *asset* and the part keeps the built result.
 */
async function asmAdoptMesh(
  part: AssemblyPart,
  positions: Float32Array,
  opts: { schedule?: boolean } = {},
  indexed?: IndexedMesh,
): Promise<void> {
  const role = currentAssemblyKind()?.roles.find((r) => r.id === part.roleId);
  if (role?.buildMesh) {
    part.assetPositions = positions;
    const built = await role.buildMesh(positions);
    positions = built.positions;
    part.vertices = built.vertices;
    // A different mesh, so the asset's index goes; undefined falls back to hashing.
    indexed = built.indexed;
    // Unconditional: a rebuild falling back to a circle must clear the previous silhouette's rule.
    part.edgeCutThroughDepth = built.edgeCutThroughDepth;
    if (part.buildWarning) dismissNotice(part.buildWarning);
    part.buildWarning = built.warning;
    if (built.warning) warn(built.warning);
  }
  // Committed together once nothing can throw: `indexed` must describe exactly this soup.
  part.positions = positions;
  part.indexed = indexed;
  part.patches = detectFlatPatches(positions);
  part.patchIdx = defaultPatchIdx(part); // largest-area patch, or the role's preferred face
  applyAsmPatchChoice(part);
  await attachBakedZones(part, positions.length / 9);
  part.loaded = true;
  // After `loaded`: rebuild.ts renders only loaded parts, and an earlier frame could be consumed
  // without this one. The chair's thirteen concurrent loads fitted the view to a subset.
  requestFrame();
  notifyPartsChanged();
  // Skipped when a rebuild is the caller, or a part following the artwork re-queues every pass.
  if (opts.schedule !== false) scheduleRebuild();
}

/**
 * Per-object id for a parse. `parsed` is immutable (regions.ts memoises on it), so a re-trace is a
 * new object and identity is the right test. A WeakMap so ids don't keep a discarded parse alive.
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
 * What a generated part's shape depends on: the artwork changes in too many places to hook, so the
 * rebuild compares this. Parse identity, not shape COUNT: a new Detail setting often keeps the
 * colour count while the outline changes. Placement terms too, as they move the silhouette.
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
 * Re-run generated parts' builders from the cached asset. Reports failure rather than rejecting:
 * the caller uses `void`, and the control would show the new size over the old mesh silently.
 */
export async function asmRebuildGeneratedParts(
  opts: { schedule?: boolean } = {},
): Promise<boolean> {
  const kind = currentAssemblyKind();
  const parts = state.assembly.parts.filter((p) => {
    const role = kind?.roles.find((r) => r.id === p.roleId);
    return role?.buildMesh && p.assetPositions;
  });
  // Read before, stored only after success: storing up front marked a FAILED rebuild current, so
  // the stale mesh was never retried.
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
    // The caller stored the new parameter over an old mesh; readers (the verified-plate lookup,
    // the 1:1 template) would describe a part that doesn't exist, so it must put the value back.
    return false;
  } finally {
    endWork();
  }
}

/**
 * Attach baked zones. Every part of a sidecar kind gets `part.zones`, `[]` meaning plain; others
 * keep the implicit flat zone. A failure (no sidecar, fingerprint mismatch) warns and leaves it
 * zoneless rather than cutting against stale UVs.
 */
async function attachBakedZones(part: AssemblyPart, triCount: number): Promise<void> {
  const zonesFile = currentAssemblyKind()?.zonesFile;
  // The one place that runs on every part of every kind, so clear the previous kind's net here.
  if (!zonesFile) state.assembly.net = null;
  if (!zonesFile || !part.libraryPartId || !part.vertices) return;
  const partId = part.libraryPartId;
  const vertices = part.vertices;
  let sidecar;
  try {
    sidecar = await loadZonesSidecar(zonesFile);
  } catch (e) {
    warn(
      `Couldn't load the design zones for "${part.name}" (${zonesFile}: ${(e as Error).message}). It will load without design zones.`,
    );
    // Zoneless, not sidecar-less: undefined would stamp artwork onto the largest flat patch.
    part.zones = [];
    return;
  }
  state.assembly.net = sidecar.net ?? null;
  // Set even when empty: no zone means no artwork, unlike no sidecar (see AssemblyPart.zones).
  const baked = sidecar.zones.flatMap((zone) =>
    zone.charts.filter((c) => c.libraryPartId === partId).map((chart) => ({ zone, chart })),
  );
  part.zones = [];
  if (!baked.length) return;

  // One fingerprint check for the part, not one per chart — it rescans every vertex.
  if (!fingerprintMatches(sidecar, partId, vertices, triCount)) {
    warn(
      `Part "${part.name}" doesn't match the mesh its design zones were baked against, so its design zones are unavailable. Re-run the zone bake for this part.`,
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
        // The relation only: the bake's residual isn't a runtime input; it'd read as a tolerance.
        ...(zone.mirror
          ? { mirror: 'twin' in zone.mirror ? { twin: zone.mirror.twin } : { self: true } }
          : {}),
        chart: reconstructChart(zone, chart, vertices, sidecar.net?.zones[zone.id]?.excluded),
      });
    } catch (e) {
      warn(
        `Design zone "${zone.name}" couldn't be applied to "${part.name}": ${(e as Error).message}`,
      );
    }
  }
  part.zones = zones;
}

/**
 * A copy's face fields cache its source's choice (it has no face control); without this,
 * re-picking the face cut the two halves on different faces.
 */
function syncDuplicateFaces(src: AssemblyPart): void {
  for (const dup of state.assembly.parts) {
    if (dup.isDuplicateOf !== src.id) continue;
    dup.patchIdx = src.patchIdx;
    dup.topZ = src.topZ;
    dup.patchNormal = src.patchNormal;
    dup.boundaryLoops = src.boundaryLoops;
    dup.restPositions = src.restPositions;
  }
}

export function applyAsmPatchChoice(part: AssemblyPart): void {
  if (!part.patches || !part.patches.length || !part.positions) return;
  const patch = part.patches[part.patchIdx];
  part.topZ = patch.offset;
  part.patchNormal = patch.normal;
  const { loops, openEdges } = extractPatchBoundary(part.positions, patch.triIndices);
  // Area, not vertex count: readers take loops[0] as the outline, and a hole always ranks after its
  // parent. scripts/gen-templates.mjs uses the same rule and must stay in step.
  loops.sort((a, b) => loopXZArea(b) - loopXZArea(a));
  part.boundaryLoops = loops.length ? loops : null;
  // Keyed per part so a re-pick replaces it. With no ring the build skips the part (assembly.ts
  // checks `boundaryLoops`), so that case says so.
  const key = faceEdgeKey(part);
  if (!loops.length)
    warn(
      `Couldn't trace the edge of the design face on "${part.name}", so no artwork will be cut on it. Try another design face.`,
      key,
    );
  else if (openEdges)
    warn(
      `Couldn't trace the whole edge of the design face on "${part.name}". Artwork may be cut to the wrong shape there. Try another design face.`,
      key,
    );
  else dismissNotice('', key);
  part.restPositions = excludeTriangles(part.positions, patch.triIndices);
  syncDuplicateFaces(part);
}

/**
 * Whether the stl/parts.json fetch has returned. An empty library alone can't tell "not yet" from
 * "none", and conflating them told every healthy boot it had failed. "Settled", not "failed": a
 * manifest missing a role would otherwise sit on "Loading assembly…" forever.
 */
let librarySettled = false;

/** True once the manifest fetch has returned, whether it succeeded or not. */
export function partsLibrarySettled(): boolean {
  return librarySettled;
}

/**
 * Load stl/parts.json so roles auto-load by libraryPartId. Every shipped role has one, so no
 * manifest means no parts (see `partsLibrarySettled`).
 */
export async function loadPartsLibrary(): Promise<void> {
  // Cleared at the start, so a retry shows "Loading assembly…" rather than the last error.
  librarySettled = false;
  beginWork();
  try {
    try {
      // A stable URL, unlike the hashed bundle: versioned so a cached manifest can't lag a newer
      // bundle's parts (the footrest launch).
      const v = typeof __APP_VERSION__ === 'undefined' ? 'dev' : __APP_VERSION__;
      const res = await fetch(`stl/parts.json?v=${v}`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const manifest: unknown = await res.json();
      // Shape-checked: a non-array threw in the render, freezing the panel on "Loading assembly…".
      if (!Array.isArray(manifest)) throw new Error('parts.json is not a list of parts');
      state.assembly.library = manifest as LibraryEntry[];
    } catch {
      /* no manifest reachable — `librarySettled` is what says so */
    }
    librarySettled = true;
    // Re-render either way; this also loads a restore accepted mid-fetch. Inside the work window on
    // purpose: idle.ts forbids the count touching zero across this handoff to the part fetches,
    // or a settle() resolves in the gap and measures an empty scene.
    notifyPartsChanged();
    maybeAutoLoadAssembly();
  } finally {
    endWork();
  }
}

/** Auto-load once a kind is chosen and the library is reachable; no-op if parts are present. */
export function maybeAutoLoadAssembly(): void {
  const kind = currentAssemblyKind();
  if (kind && asmKindCanAutoLoad(kind) && state.assembly.parts.length === 0) {
    void asmLoadFullAssembly();
  }
}
