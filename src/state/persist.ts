import type { AppState } from './store';
import { state } from './store';
import type { ArtworkInstance, DesignSource } from '../types';
import {
  pruneSettingsToPalette,
  restoreArtworkPool,
  setActiveArtwork,
  setArtworkZone,
} from './artwork';
import { ASSEMBLY_KINDS } from '../assembly/kinds';
import { asmLoadFullAssembly } from '../assembly/parts';
import { parseSVGDocument } from '../svg/parse';

const STORAGE_KEY = 'tmt-mosaic:session:v1';
const SCHEMA_VERSION = 1;
/** Past this, skip the write rather than risk a QuotaExceededError mid-session — localStorage's
 * per-origin quota is commonly ~5-10MB and this app is the only thing using it, but a
 * dense/multi-design session storing raw SVG text should still have a hard ceiling. */
const MAX_BYTES = 4_000_000;

type PersistedSource = Pick<DesignSource, 'id' | 'kind' | 'name' | 'svgText'>;
/** `zone` isn't persisted directly — `AssemblyPart.id` is a fresh per-session counter
 * (asmCreateRolePart), so a saved `partId` can't mean anything after a reload. Only `zoneId`
 * (the zone's stable string id from the zone sidecar) survives; the restore path re-resolves it
 * against the freshly reloaded parts via setArtworkZone(), exactly like a live zone-dropdown pick. */
type PersistedArtwork = Omit<ArtworkInstance, 'zone'> & { zoneId: string | null };

export interface PersistedSession {
  version: typeof SCHEMA_VERSION;
  savedAt: number;
  shapeKind: AppState['shapeKind'];
  disc: AppState['disc'];
  rect: AppState['rect'];
  round: AppState['round'];
  stlPlate: AppState['stlPlate'];
  marginPct: number;
  scalePct: number;
  offsetX: number;
  offsetY: number;
  flipX: boolean;
  flipY: boolean;
  rotationDeg: number;
  globalDepth: number;
  recessBg: boolean;
  printerId: string;
  asmRadius: number;
  assembly: { kindId: string | null; variantId: string | null };
  baseFilamentId: string | null;
  autoMergeLevel: number;
  baseColorKey: string | null;
  baseColorMembers: string[];
  mergeGroups: string[][];
  colorSettings: AppState['colorSettings'];
  /**
   * Marks a session whose `colorSettings` holds only depths the user deliberately set. Sessions
   * saved before that was true carry a machine-written override for every color — the color list
   * used to seed each row from the built (already clamped) depth — which restores as if every
   * depth had been typed by hand: the global Depth field moves nothing, and an out-of-range depth
   * stops warning because the stored value already equals its own clamp. The two are
   * indistinguishable after the fact, so a session without this flag has its depths dropped back
   * to the global rather than restored as fake overrides.
   */
  explicitDepths?: true;
  keptApart: string[];
  sources: PersistedSource[];
  artworks: PersistedArtwork[];
  activeArtworkId: string | null;
}

/**
 * Whether there's anything worth losing — gates both the beforeunload prompt and whether
 * saveSession() writes anything. Deliberately just "is a design loaded," not "are assembly parts
 * loaded": every assembly kind auto-loads its parts on boot with zero user effort (maybeAutoLoadAssembly),
 * so that alone is true on nearly every visit and would defeat both gates — warning on a bare
 * unmodified wheel, and re-arming the restore banner within a second of the user dismissing it
 * (the default boot's own rebuild reaching saveSession() with nothing else to save).
 */
export function hasLoadedWork(): boolean {
  return state.artworks.length > 0;
}

/**
 * Standard cross-browser beforeunload prompt — every browser ignores the actual returnValue text
 * and shows its own generic "leave site?" copy, so the string here is only for the handful that
 * still don't. Only arms once there's real work to lose, and only once flushPendingSave() has
 * already tried and failed to land it on disk — a session that autosaved successfully is already
 * recoverable via the restore banner, so warning about it too would just teach makers to reflexively
 * click through the one case (a failed save) where the warning is actually true.
 */
export function initBeforeUnloadGuard(): void {
  window.addEventListener('beforeunload', (e) => {
    if (!hasLoadedWork()) return;
    flushPendingSave();
    if (!lastSaveFailed) return;
    e.preventDefault();
    e.returnValue = "TMT Mosaic couldn't save this session — leaving now loses it.";
  });
  // beforeunload is skipped outright on mobile backgrounding and bfcache eviction, so this is the
  // flush that actually runs there.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPendingSave();
  });
}

function snapshotSession(): PersistedSession {
  const persistedSources = state.sources.filter((s) => !s.raster);
  const persistedIds = new Set(persistedSources.map((s) => s.id));
  const persistedArtworks = state.artworks.filter((a) => persistedIds.has(a.sourceId));
  const persistedActiveId = persistedArtworks.some((a) => a.id === state.activeArtworkId)
    ? state.activeArtworkId
    : (persistedArtworks[0]?.id ?? null);
  return {
    version: SCHEMA_VERSION,
    savedAt: Date.now(),
    shapeKind: state.shapeKind,
    disc: state.disc,
    rect: state.rect,
    round: state.round,
    stlPlate: state.stlPlate,
    marginPct: state.marginPct,
    scalePct: state.scalePct,
    offsetX: state.offsetX,
    offsetY: state.offsetY,
    flipX: state.flipX,
    flipY: state.flipY,
    rotationDeg: state.rotationDeg,
    globalDepth: state.globalDepth,
    recessBg: state.recessBg,
    printerId: state.printerId,
    asmRadius: state.asmRadius,
    assembly: { kindId: state.assembly.kindId, variantId: state.assembly.variantId },
    baseFilamentId: state.baseFilamentId,
    autoMergeLevel: state.autoMergeLevel,
    baseColorKey: state.baseColorKey,
    baseColorMembers: state.baseColorMembers,
    mergeGroups: state.mergeGroups,
    colorSettings: state.colorSettings,
    explicitDepths: true,
    keptApart: state.keptApart,
    // A raster source is skipped, not persisted: restore re-derives `parsed` by re-parsing
    // `svgText`, and an image has none — it came from pixels. Storing the pixels instead is not an
    // option either, since one decoded image is ~1MB before JSON encoding against a MAX_BYTES of
    // 4MB. Its instances go with it, or restore would rebuild placements pointing at a source that
    // no longer exists. The user re-drops the image; everything else about the session survives.
    sources: persistedSources.map((s) => ({
      id: s.id,
      kind: s.kind,
      name: s.name,
      svgText: s.svgText,
    })),
    artworks: persistedArtworks.map(({ zone, ...rest }) => ({
      ...rest,
      zoneId: zone?.zoneId ?? null,
    })),
    // May have pointed at a raster instance that just got filtered out — fall back to a surviving
    // one rather than restoring a selection that references nothing.
    activeArtworkId: persistedActiveId,
  };
}

/**
 * Whether the most recent saveSession() call actually landed the write — read by
 * initBeforeUnloadGuard() to decide whether leaving is safe. Not surfaced anywhere mid-work; see
 * the degrade-silently note on saveSession().
 */
let lastSaveFailed = false;

/**
 * Write the current session, swallowing every failure — private browsing with storage disabled,
 * a quota already full of other sites' data, a circular/unserializable value that shouldn't exist
 * but shouldn't crash a rebuild if it did. A session that fails to save just means the next
 * restore-banner check finds nothing, same as a first visit; never worth surfacing to the user
 * mid-work. Mirrors helpPanel.ts's degrade-silently pattern for the same reason. lastSaveFailed
 * is the one exception — read only at unload, to decide whether the native prompt is warranted.
 */
export function saveSession(): void {
  // An empty snapshot (no artwork, no loaded parts) isn't worth restoring — and saving one
  // unconditionally would re-arm the restore banner within a second of a user dismissing it, since
  // the default boot's own bare-wheel rebuild reaches this same path. Clear instead, so "Start
  // fresh" actually stays fresh, and so removing the last artwork instance doesn't leave a stale
  // save behind either.
  if (!hasLoadedWork()) {
    clearSavedSession();
    lastSaveFailed = false;
    return;
  }
  try {
    const json = JSON.stringify(snapshotSession());
    if (json.length > MAX_BYTES) {
      lastSaveFailed = true;
      return;
    }
    localStorage.setItem(STORAGE_KEY, json);
    lastSaveFailed = false;
  } catch {
    // storage unavailable, full, or the write threw for some other reason — nothing to do
    lastSaveFailed = true;
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Set for the duration of applyRestoredSession() — its own asmLoadFullAssembly() call schedules a
 * rebuild of the *bare* reloaded parts (artwork isn't reconstructed until after it resolves), and
 * that rebuild's own schedulePersist() call would otherwise autosave that half-restored state,
 * overwriting the very session being restored, before restore finishes.
 */
let restoring = false;

/** Debounced save — called after every rebuild (see app/rebuild.ts) and a couple of state changes
 * that don't go through one (the printer picker). One save per burst of activity, not one per
 * keystroke/slider tick. */
export function schedulePersist(): void {
  if (restoring) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    saveSession();
  }, 1000);
}

/**
 * Runs a fresh save immediately, cancelling any pending debounce, so a reload mid-debounce
 * doesn't lose the last second of edits — and so lastSaveFailed reflects an attempt against
 * *current* state rather than a stale flag from whenever the last debounced save happened to
 * fire (or from before any save was ever attempted this session). Called from
 * initBeforeUnloadGuard() (localStorage writes complete synchronously, so this reliably lands
 * before the page actually unloads) and on visibilitychange, since beforeunload itself is
 * skipped outright on mobile backgrounding and bfcache eviction.
 */
function flushPendingSave(): void {
  if (restoring) return;
  clearTimeout(saveTimer);
  saveTimer = undefined;
  saveSession();
}

export function clearSavedSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // nothing to do
  }
}

/** Basic structural sanity — a corrupt or hand-edited value should read as "nothing saved", not
 * throw partway through a restore. */
function isPersistedSession(v: unknown): v is PersistedSession {
  if (!v || typeof v !== 'object') return false;
  const s = v as Partial<PersistedSession>;
  return (
    s.version === SCHEMA_VERSION &&
    typeof s.savedAt === 'number' &&
    Array.isArray(s.sources) &&
    Array.isArray(s.artworks)
  );
}

/**
 * The depth overrides a restore should adopt. See PersistedSession.explicitDepths: a session saved
 * before per-row depths meant "the user set this" carries one for every color, so it restores with
 * none rather than with overrides nobody typed.
 *
 * Split out from applyRestoredSession so it can be tested against the real rule — inlined, the
 * only way to cover it was to restate the condition in the test, which then passed whatever the
 * source did.
 */
export function restoredColorSettings(session: PersistedSession): AppState['colorSettings'] {
  return session.explicitDepths ? session.colorSettings : {};
}

export function loadSavedSession(): PersistedSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isPersistedSession(parsed)) {
      clearSavedSession(); // won't parse as this schema again either — stop offering to restore it
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Apply a saved session to `state`. Deliberately does not touch the DOM or trigger a rebuild —
 * the caller (ui/restoreBanner.ts) does that once, after this resolves, the same way any other
 * assembly-kind switch does (see setShapeKind). Re-parses each source's saved SVG text rather
 * than trying to persist `ParsedSVG` directly (see the note on DesignSource.svgText).
 *
 * Assembly restore awaits asmLoadFullAssembly() directly rather than going through
 * maybeAutoLoadAssembly()'s fire-and-forget call, because the zone bindings below need the
 * restored parts (and their fresh session-local ids) to already exist. state.assembly.parts is
 * empty at this point (nothing has loaded yet this session), so the confirmDialog() guard in
 * asmLoadFullAssembly — which only fires when parts are already present — never triggers.
 */
export async function applyRestoredSession(session: PersistedSession): Promise<void> {
  restoring = true;
  try {
    await applyRestoredSessionInner(session);
  } finally {
    restoring = false;
  }
}

async function applyRestoredSessionInner(session: PersistedSession): Promise<void> {
  state.disc = session.disc;
  state.rect = session.rect;
  state.round = session.round;
  state.stlPlate = session.stlPlate;
  state.marginPct = session.marginPct;
  state.scalePct = session.scalePct;
  state.offsetX = session.offsetX;
  state.offsetY = session.offsetY;
  state.flipX = session.flipX;
  state.flipY = session.flipY;
  state.rotationDeg = session.rotationDeg;
  state.globalDepth = session.globalDepth;
  state.recessBg = session.recessBg;
  state.printerId = session.printerId;
  state.asmRadius = session.asmRadius;
  state.baseFilamentId = session.baseFilamentId;
  state.autoMergeLevel = session.autoMergeLevel;
  state.baseColorKey = session.baseColorKey;
  state.baseColorMembers = session.baseColorMembers;
  state.mergeGroups = session.mergeGroups;
  state.colorSettings = restoredColorSettings(session);
  state.keptApart = session.keptApart;

  const sources: DesignSource[] = session.sources.map((s) => ({
    ...s,
    parsed: parseSVGDocument(s.svgText),
  }));

  const kind =
    session.shapeKind === 'assembly' && session.assembly.kindId
      ? ASSEMBLY_KINDS.find((k) => k.id === session.assembly.kindId)
      : undefined;
  if (session.shapeKind === 'assembly' && kind) {
    state.shapeKind = 'assembly';
    state.assembly.kindId = kind.id;
    state.assembly.variantId = session.assembly.variantId;
    await asmLoadFullAssembly();
  } else {
    // Either a flat mode, or an assembly kind that no longer exists (renamed/retired since the
    // session was saved) — fall back to the flat default rather than fail the whole restore.
    state.shapeKind = session.shapeKind === 'assembly' ? 'disc' : session.shapeKind;
  }

  const artworks: ArtworkInstance[] = session.artworks.map((a) => ({
    id: a.id,
    sourceId: a.sourceId,
    zone: null,
    offsetU: a.offsetU,
    offsetV: a.offsetV,
    scalePct: a.scalePct,
    rotationDeg: a.rotationDeg,
    flipX: a.flipX,
    flipY: a.flipY,
    mode: a.mode,
  }));
  restoreArtworkPool(sources, artworks);
  session.artworks.forEach((a) => setArtworkZone(a.id, a.zoneId));
  setActiveArtwork(session.activeArtworkId);
  pruneSettingsToPalette();
}
