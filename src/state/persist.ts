import type { AppState } from './store';
import { MIN_DESIGN_RADIUS_MM, state } from './store';
import type { ArtworkInstance, DesignSource } from '../types';
import {
  allowedArtworkMode,
  announceTrace,
  pruneSettingsToPalette,
  availableZones,
  restoreArtworkPool,
  setActiveArtwork,
  setArtworkZone,
} from './artwork';
import { ASSEMBLY_KINDS, buildParamMax, firstOfferedKind } from '../assembly/kinds';
import { HUBCAP_MIN_DIAMETER_MM } from '../geometry/hubcap';
import { getPrinter } from '../export/printers';
import { asmSwitchKindAndLoad } from '../assembly/switchKind';
import { parseSVGDocument } from '../svg/parse';
import { decodeWorkingImage, encodeWorkingImage } from '../raster/store';
import { parseRasterImage } from '../raster/parse';
import { clearWarnings, warn } from '../warnings';
import type { RasterImage } from '../raster/types';

const STORAGE_KEY = 'tmt-mosaic:session:v1';
const SCHEMA_VERSION = 1;
/** Past this, skip the write rather than risk a QuotaExceededError — the ceiling for sessions storing raw SVG text. */
const MAX_BYTES = 4_000_000;

/**
 * Total data-URL characters all images in a session may take.
 *
 * Measured re-encodes: flat art at 1024px ~24KB of PNG, a photograph at 512px ~703KB, +1/3 for
 * base64 — one photograph is near 950,000 characters. A per-image cap isn't enough: four photographs
 * pass it and together exceed MAX_BYTES, which loses the SVG half of the session too. Images are
 * admitted in order until spent; the rest drop out like an unencodable one. 2.5M of 4M leaves the
 * SVG sources, placements and settings room.
 */
const MAX_IMAGE_CHARS_TOTAL = 2_500_000;

/**
 * Last encode per source, keyed on its pixel buffer. Autosave and beforeunload both snapshot, and
 * re-encoding a photograph each time is wasted main-thread work: working pixels are replaced
 * wholesale on a slider re-run, never mutated, so buffer identity is a sound key.
 */
const pngCache = new WeakMap<Uint8ClampedArray, string>();

function encodedPng(image: RasterImage): string | null {
  const hit = pngCache.get(image.data);
  if (hit !== undefined) return hit;
  const png = encodeWorkingImage(image);
  // Only a success is cached — a failure can be transient, and caching it would drop the image from every later save.
  if (png) pngCache.set(image.data, png);
  return png;
}

type PersistedSource = Pick<DesignSource, 'id' | 'kind' | 'name' | 'svgText'> & {
  /**
   * A raster source's working image as a PNG data URL, plus what the trace needs to reproduce the
   * same result. Absent on an SVG source and on raster sessions saved before this existed.
   *
   * `edgeDensity` can't be re-derived: the same image measures flatter the larger it is decoded, so
   * re-measuring would move the flat-vs-photo thresholds (see RasterImage in raster/types.ts).
   * `mmPerPixel` could be, but the re-trace runs before the parts are back, so the design face
   * doesn't exist yet and per-instance scales are still in the session.
   */
  raster?: {
    png: string;
    colors: number;
    detail: number;
    edgeDensity?: number;
    mmPerPixel?: number;
  };
};
/** `zone` isn't persisted: `AssemblyPart.id` is a per-session counter, so a saved `partId` means nothing after reload. Only the stable `zoneId` survives; restore re-resolves it via setArtworkZone(). */
type PersistedArtwork = Omit<ArtworkInstance, 'zone'> & { zoneId: string | null };

export interface PersistedSession {
  version: typeof SCHEMA_VERSION;
  savedAt: number;
  /** Always 'assembly' when written. Older sessions may hold 'disc', 'rect', 'round' or 'stl' and restore onto the first offered kind. */
  shapeKind: string;
  scalePct: number;
  offsetX: number;
  offsetY: number;
  flipX: boolean;
  flipY: boolean;
  rotationDeg: number;
  globalDepth: number;
  printerId: string;
  asmRadius: number;
  /** Optional: sessions written before the hubcap kind existed have no value for it. */
  hubcapDiameterMm?: number;
  /** Optional for the same reason, and separately for sessions predating the silhouette toggle. */
  hubcapSilhouette?: boolean;
  assembly: { kindId: string | null; variantId: string | null };
  baseFilamentId: string | null;
  autoMergeLevel: number;
  baseColorKey: string | null;
  baseColorMembers: string[];
  mergeGroups: string[][];
  colorSettings: AppState['colorSettings'];
  /**
   * Marks `colorSettings` as holding only deliberately set depths. Older sessions carry a
   * machine-written override per color (seeded from the clamped built depth), which restores as if
   * typed by hand: the global Depth field moves nothing and an out-of-range depth stops warning.
   * The two are indistinguishable after the fact, so without this flag depths drop back to the global.
   */
  explicitDepths?: true;
  keptApart: string[];
  sources: PersistedSource[];
  artworks: PersistedArtwork[];
  activeArtworkId: string | null;
}

/**
 * Whether there's anything worth losing — gates the beforeunload prompt and separates "nothing
 * loaded" from "couldn't be persisted" in saveSession(). Deliberately "is a design loaded", not "are
 * parts loaded": every kind auto-loads its parts on boot, so that would warn on a bare wheel and
 * re-arm the restore banner right after dismissal.
 */
export function hasLoadedWork(): boolean {
  return state.artworks.length > 0;
}

/**
 * Standard beforeunload prompt; browsers show their own copy. Arms only when flushPendingSave()
 * finds something the restore banner won't bring back (write failed, or an image was dropped) — a
 * fully autosaved session is recoverable, and warning anyway would teach makers to click through.
 */
export function initBeforeUnloadGuard(): void {
  window.addEventListener('beforeunload', (e) => {
    if (!hasLoadedWork()) return;
    flushPendingSave();
    if (!lastSaveFailed && !lastSaveDropped) return;
    e.preventDefault();
    e.returnValue = lastSaveFailed
      ? "TMT Mosaic couldn't save this session. Leaving now loses it."
      : 'TMT Mosaic saved this session, but an image could not be saved. Leaving now means ' +
        're-dropping it.';
  });
  // beforeunload is skipped on mobile backgrounding and bfcache eviction, so this is the flush that runs there.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPendingSave();
  });
}

function snapshotSession(): PersistedSession {
  // Encoded first: a source whose image won't encode is left out with its instances, or restore rebuilds placements pointing at nothing.
  const rasterPayloads = new Map<string, NonNullable<PersistedSource['raster']>>();
  let imageChars = 0;
  for (const s of state.sources) {
    // Unreachable from the app, but a malformed source must drop out rather than throw — snapshotSession runs outside saveSession's try.
    if (!s.raster?.image) continue;
    const png = encodedPng(s.raster.image);
    // Over budget, this image is left out rather than failing the whole save; the data URL's length is its JSON cost.
    if (png && imageChars + png.length <= MAX_IMAGE_CHARS_TOTAL) {
      imageChars += png.length;
      rasterPayloads.set(s.id, {
        png,
        colors: s.raster.colors,
        detail: s.raster.detail,
        edgeDensity: s.raster.image.edgeDensity,
        mmPerPixel: s.raster.mmPerPixel,
      });
    }
  }
  const persistedSources = state.sources.filter((s) => !s.raster || rasterPayloads.has(s.id));
  const persistedIds = new Set(persistedSources.map((s) => s.id));
  const persistedArtworks = state.artworks.filter((a) => persistedIds.has(a.sourceId));
  const persistedActiveId = persistedArtworks.some((a) => a.id === state.activeArtworkId)
    ? state.activeArtworkId
    : (persistedArtworks[0]?.id ?? null);
  return {
    version: SCHEMA_VERSION,
    savedAt: Date.now(),
    shapeKind: 'assembly',
    scalePct: state.scalePct,
    offsetX: state.offsetX,
    offsetY: state.offsetY,
    flipX: state.flipX,
    flipY: state.flipY,
    rotationDeg: state.rotationDeg,
    globalDepth: state.globalDepth,
    printerId: state.printerId,
    asmRadius: state.asmRadius,
    hubcapDiameterMm: state.hubcapDiameterMm,
    hubcapSilhouette: state.hubcapSilhouette,
    assembly: { kindId: state.assembly.kindId, variantId: state.assembly.variantId },
    baseFilamentId: state.baseFilamentId,
    autoMergeLevel: state.autoMergeLevel,
    baseColorKey: state.baseColorKey,
    baseColorMembers: state.baseColorMembers,
    mergeGroups: state.mergeGroups,
    colorSettings: state.colorSettings,
    explicitDepths: true,
    keptApart: state.keptApart,
    // SVG sources restore by re-parsing `svgText`; a raster source carries its working image as PNG,
    // re-decoded and re-traced. Raw pixels rejected: 1024x1024 RGBA is 4.0MB vs MAX_BYTES 4MB, PNG is
    // 24KB flat / 703KB photo (raster/store.ts). Re-trace measured ~830ms on a 512px photograph
    // (scripts/bench-raster.ts); caching traced regions instead would put MAX_BYTES back in play.
    sources: persistedSources.map((s) => ({
      id: s.id,
      kind: s.kind,
      name: s.name,
      svgText: s.svgText,
      ...(rasterPayloads.has(s.id) ? { raster: rasterPayloads.get(s.id) } : {}),
    })),
    artworks: persistedArtworks.map(({ zone, ...rest }) => ({
      ...rest,
      zoneId: zone?.zoneId ?? null,
    })),
    // May point at a filtered-out raster instance — fall back to a survivor.
    activeArtworkId: persistedActiveId,
  };
}

/** Whether the latest saveSession() landed its write — read by initBeforeUnloadGuard(). Not surfaced mid-work; see saveSession(). */
let lastSaveFailed = false;

/**
 * Whether the latest snapshot left a loaded design out. A raster source that doesn't fit is only
 * partly recoverable even when the write succeeds, which lastSaveFailed can't see (one SVG plus one
 * image saves cleanly and drops the image silently). Separate so each flag says what happened.
 */
let lastSaveDropped = false;

/**
 * Whether a session already in storage at page load is still unanswered. The empty-snapshot clear
 * destroys a saved session about a second into any bare boot, so until the offer is answered
 * clearing is premature — three losses measured 2026-08-24: a `?kind=` link (banner never shown),
 * a reload with the banner unanswered, and a restore that threw.
 */
let unansweredSavedSession = false;

/**
 * Arm the hold if the user arrived with a saved session. Called once at boot, before anything
 * decides whether to offer it — including the paths that decide not to (`?kind=`, a withheld kind).
 * Armed rather than default-on: defaulting to held kept an emptied session from a visitor who
 * loaded a design and deleted it, and offered it back next visit.
 */
export function holdSavedSessionUntilAnswered(): void {
  try {
    unansweredSavedSession = localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    unansweredSavedSession = false;
  }
}

/** Called by the restore banner when the user accepts or dismisses the offer. */
export function markSavedSessionAnswered(): void {
  unansweredSavedSession = false;
}

/**
 * Whether the stored session is on an assembly kind currently withheld (`AssemblyKind.hidden`).
 * Never offered back, so the empty-snapshot clear would destroy it silently about a second after a
 * bare boot. Held until the kind is offered again or real work overwrites it.
 */
function savedSessionIsOnHiddenKind(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const parsed: unknown = JSON.parse(raw);
    if (!isPersistedSession(parsed) || parsed.shapeKind !== 'assembly') return false;
    return !!ASSEMBLY_KINDS.find((k) => k.id === parsed.assembly.kindId)?.hidden;
  } catch {
    return false;
  }
}

/**
 * A restore stopped before its designs were applied (the part failed to load, or the user switched
 * part meanwhile). Nothing reached `state`, so storage is left alone and the session can be offered again.
 */
export class SessionPartsError extends Error {
  constructor(partName: string, why: 'failed' | 'superseded') {
    super(
      why === 'failed'
        ? `Couldn't restore your session: the ${partName} didn't load. Reload the page to try again.`
        : `Your session wasn't restored: the part changed before the ${partName} loaded. Reload the page to try again.`,
    );
    this.name = 'SessionPartsError';
  }
}

/** The notice shown when a restore failed; shared by the banner and the re-announce. */
export const SESSION_WRITES_DISABLED_MSG =
  'That saved session could not be opened, so it was cleared. Reload the page to start clean.';

/**
 * Write the current session, swallowing every failure (storage disabled, quota full, unserializable
 * value) — a failed save just means the next restore check finds nothing, as on a first visit.
 * Mirrors helpPanel.ts; lastSaveFailed is the one exception, read only at unload.
 */
export function saveSession(): void {
  if (writesDisabledAfterFailedRestore !== null) {
    // `lastSaveFailed` drives the beforeunload prompt; leaving it false would go quiet exactly when nothing is saved.
    lastSaveFailed = true;
    // Re-stated because a user-initiated SVG load calls clearWarnings() (applyParsedSVG) and would
    // drop the notice, leaving a healthy-looking app that persists nothing. warn() dedupes; same as
    // csgFault.ts. Lands one render late — this runs on the debounced save, not inside a build.
    warn(writesDisabledAfterFailedRestore);
    return;
  }
  // An empty snapshot isn't worth restoring, and saving one would re-arm the restore banner within a
  // second of dismissal (the default boot's bare-wheel rebuild reaches here). Clear instead, so
  // "Start fresh" stays fresh and removing the last artwork leaves no stale save. Judged on the
  // snapshot, not hasLoadedWork(), because the snapshot is what reaches storage.
  const session = snapshotSession();
  // Any dropped image counts, not only all failing — otherwise the second of two images is dropped in silence.
  const savedRasterIds = new Set(session.sources.filter((s) => s.raster).map((s) => s.id));
  lastSaveDropped = state.sources.some((s) => s.raster && !savedRasterIds.has(s.id));
  if (!session.artworks.length) {
    // Held only while nothing is loaded: on a bare boot the stored session is the user's only copy,
    // but one they've moved past (loaded something unsaveable) genuinely supersedes it.
    const held = savedSessionIsOnHiddenKind() || (unansweredSavedSession && !hasLoadedWork());
    if (!held) clearSavedSession();
    lastSaveFailed = hasLoadedWork();
    return;
  }
  try {
    const json = JSON.stringify(session);
    if (json.length > MAX_BYTES) {
      lastSaveFailed = true;
      return;
    }
    localStorage.setItem(STORAGE_KEY, json);
    // Storage now holds this page's own work, so the hold has nothing left to protect. Without this
    // it never ended on an unanswered-banner boot, and deleting the last design offered the earlier work back.
    unansweredSavedSession = false;
    lastSaveFailed = false;
  } catch {
    // storage unavailable, full, or threw — nothing to do
    lastSaveFailed = true;
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Set during applyRestoredSession(): its asmLoadFullAssembly() schedules a rebuild of the bare
 * parts, whose schedulePersist() would autosave that half-restored state over the session being restored.
 */
let restoring = false;

/**
 * Set when a restore failed and never cleared: writes stay off until reload. Holds the notice,
 * re-stated on every skipped save. Memory isn't trusted — most throws land after the parts loaded
 * but before artwork was applied, and the next debounced save would write that state back. A
 * SessionPartsError rolls back cleanly, but "reload and try again" only holds if storage keeps the session.
 */
let writesDisabledAfterFailedRestore: string | null = null;

/** Called by the restore banner when a restore throws. */
export function disableSessionWritesAfterFailedRestore(notice = SESSION_WRITES_DISABLED_MSG): void {
  writesDisabledAfterFailedRestore = notice;
}

/** Called by the restore banner after a SessionPartsError. Written back because a save before the click may already have replaced it. */
export function keepSessionForRetry(session: PersistedSession, notice: string): void {
  disableSessionWritesAfterFailedRestore(notice);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // storage unavailable or full: the session is lost to a reload either way
  }
}

/** Debounced save — called after every rebuild (app/rebuild.ts) and state changes that skip one (the printer picker). */
export function schedulePersist(): void {
  if (restoring) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    // Re-checked: a save armed just before Restore fires mid-restore and writes an empty snapshot over the session.
    if (restoring) return;
    saveSession();
  }, 1000);
}

/**
 * Saves immediately, cancelling any pending debounce, so a reload mid-debounce keeps the last
 * second of edits and lastSaveFailed reflects *current* state. Called from the unload guard
 * (localStorage writes are synchronous) and on visibilitychange.
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

/** Structural sanity — a corrupt or hand-edited value should read as "nothing saved", not throw mid-restore. */
const isObj = (v: unknown): boolean => !!v && typeof v === 'object' && !Array.isArray(v);

function isPersistedSession(v: unknown): v is PersistedSession {
  if (!isObj(v)) return false;
  const s = v as Partial<PersistedSession>;
  return (
    s.version === SCHEMA_VERSION &&
    typeof s.savedAt === 'number' &&
    Array.isArray(s.sources) &&
    Array.isArray(s.artworks)
  );
}

/**
 * Fill in the containers `applyRestoredSession` dereferences when a session lacks them.
 *
 * **Repaired rather than rejected.** Seven single-field corruptions passed the gate above and threw
 * mid-restore (measured 2026-08-24); three left the app unable to build, showing raw exception text.
 * Rejecting them was wrong: an older build's session isn't corrupt and still holds the artwork.
 * Each default is the app's boot "nothing set".
 */
function repairSessionContainers(s: PersistedSession): PersistedSession {
  const obj = <T>(v: unknown, fallback: T): T => (isObj(v) ? (v as T) : fallback);
  const arr = <T>(v: unknown, fallback: T[]): T[] => (Array.isArray(v) ? (v as T[]) : fallback);
  return {
    ...s,
    colorSettings: obj(s.colorSettings, {}),
    keptApart: arr(s.keptApart, []),
    mergeGroups: arr(s.mergeGroups, []),
    baseColorMembers: arr(s.baseColorMembers, []),
    assembly: obj(s.assembly, { kindId: null, variantId: null }),
  };
}

/**
 * The depth overrides a restore adopts — see PersistedSession.explicitDepths. Split out so a test
 * covers the real rule instead of restating it.
 */
export function restoredColorSettings(session: PersistedSession): AppState['colorSettings'] {
  return session.explicitDepths ? session.colorSettings : {};
}

/** The scalar and settings fields a restore adopts, computed without touching `state` (see `pending` in applyRestoredSessionInner). */
function buildRestoredScalarState(session: PersistedSession): Partial<AppState> {
  // Coerced to an existing printer: an unknown id left `#p-printer` blank while getPrinter() fell
  // back to the default bed, so export would use one plate while the picker named none.
  const printerId = getPrinter(session.printerId).id;
  const pending: Partial<AppState> = {
    scalePct: session.scalePct,
    offsetX: session.offsetX,
    offsetY: session.offsetY,
    flipX: session.flipX,
    flipY: session.flipY,
    rotationDeg: session.rotationDeg,
    printerId,
    baseFilamentId: session.baseFilamentId,
    autoMergeLevel: session.autoMergeLevel,
    baseColorKey: session.baseColorKey,
    baseColorMembers: session.baseColorMembers,
    mergeGroups: session.mergeGroups,
    colorSettings: restoredColorSettings(session),
    keptApart: session.keptApart,
  };
  // Guarded like asmRadius: isPersistedSession checks four fields and repairSessionContainers fixes
  // containers only, so a missing one reached colorList's `shownDepth.toFixed(2)` and threw mid-restore.
  if (Number.isFinite(session.globalDepth)) pending.globalDepth = session.globalDepth;
  // Same floor and constant as the field: a looser guard let 0.2 through and the field snapped to
  // its default while state kept 0.2. Earlier builds can save 0 or negative.
  if (Number.isFinite(session.asmRadius) && session.asmRadius >= MIN_DESIGN_RADIUS_MM)
    pending.asmRadius = session.asmRadius;
  // Older sessions predate the hubcap, so an absent value keeps the default rather than NaN.
  // Clamped at both ends against the resolved printer: a stored value bypasses the control that
  // bounds it. Below the floor the disc misses its mounting clips; above the plate it can't print,
  // and no restore path re-applies the ceiling later.
  if (typeof session.hubcapDiameterMm === 'number' && Number.isFinite(session.hubcapDiameterMm)) {
    // The live field's ceiling (buildParamMax), not a plate-only one — that let a restore land up to
    // 10mm inside PLATE_EDGE_MARGIN_MM and skip a kind's own maxMm. A kind with no buildParam, or
    // one that no longer exists, keeps the plate-only clamp.
    const restoredKind =
      session.shapeKind === 'assembly' && session.assembly.kindId
        ? ASSEMBLY_KINDS.find((k) => k.id === session.assembly.kindId)
        : undefined;
    const plate = getPrinter(printerId).plate;
    const ceiling = restoredKind?.buildParam
      ? buildParamMax(restoredKind.buildParam, printerId)
      : Math.min(plate.w, plate.d);
    pending.hubcapDiameterMm = Math.min(
      ceiling,
      Math.max(HUBCAP_MIN_DIAMETER_MM, session.hubcapDiameterMm),
    );
  }
  // No clamp: every shape check runs at rebuild and falls back to a circle with a message.
  if (typeof session.hubcapSilhouette === 'boolean')
    pending.hubcapSilhouette = session.hubcapSilhouette;
  return pending;
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
    return repairSessionContainers(parsed);
  } catch {
    // Cleared like the schema branch: an unparseable blob was held forever, since no banner renders
    // for it and the suppressed empty-snapshot clear never tidies it.
    clearSavedSession();
    return null;
  }
}

/**
 * Apply a saved session to `state`. Touches no DOM and triggers no rebuild — the caller
 * (ui/restoreBanner.ts) does that once after this resolves. Re-parses each source's SVG text
 * (see DesignSource.svgText).
 *
 * Awaits the load rather than fire-and-forget maybeAutoLoadAssembly(), because the zone bindings
 * need the restored parts and their fresh ids.
 *
 * **`state.assembly.parts` is not empty on entry**: the boot auto-load filled it, so
 * asmLoadFullAssembly's confirmDialog raised a second question and cancelling exported the boot
 * kind's parts under the restored kind's filename. Both branches below clear it; keep that.
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
  // Once, before any source is touched, not per source (that wiped a raster failure's warning when
  // the next SVG parsed). restoreArtworkPool replaces `state.sources`, so old-id notices would
  // describe sources that no longer exist.
  clearWarnings();

  // Built, then committed once the source loop runs clean, so a failing source (an SVG that no
  // longer parses is the common case) can't leave these committed without the sources they describe.
  const pending = buildRestoredScalarState(session);

  // Raster sources are decoded and re-traced, SVG re-parsed, all before state is touched. This is
  // restore's one real image work: quantize + trace measured ~830ms on a 512px photograph, inside the restore overlay.
  const sources: DesignSource[] = [];
  const lostSources = new Set<string>();
  for (const s of session.sources) {
    if (!s.raster) {
      // Coerced: 'pattern' was a kind in sessions saved before the built-in library was removed.
      sources.push({
        ...s,
        kind: s.kind === 'sample' ? 'sample' : 'upload',
        raster: undefined,
        parsed: parseSVGDocument(s.svgText, s.kind === 'sample' ? 'sample' : undefined),
      });
      continue;
    }
    // Per image: a throw must cost that design, not the restore — the banner treats a rejection as
    // a dead session and clears it, destroying the SVG designs too.
    try {
      const image = await decodeWorkingImage(s.raster.png);
      // Restore the statistic that can't be re-measured from these pixels (see PersistedSource).
      if (s.raster.edgeDensity !== undefined) image.edgeDensity = s.raster.edgeDensity;
      const opts = {
        colors: s.raster.colors,
        detail: s.raster.detail,
        // As saved: a reconstruction, not a fresh trace, and there's no placement to derive one
        // from before the parts are back. The first settled rebuild re-traces if the placement
        // disagrees (`retraceMovedSources`).
        mmPerPixel: s.raster.mmPerPixel,
      };
      // name is passed beside opts, not in it: opts is spread into RasterState, which has no name field.
      const result = parseRasterImage(image, { ...opts, name: s.name });
      // The same notice the first load gave, so a simplified design doesn't look quietly changed.
      announceTrace(s.id, s.name, result);
      sources.push({
        id: s.id,
        kind: s.kind,
        name: s.name,
        svgText: '',
        parsed: result.parsed,
        raster: { image, ...opts, palette: result.palette, regions: result.componentCount },
      });
    } catch {
      lostSources.add(s.id);
      warn(
        `"${s.name}" could not be restored from the saved session. Load the image again to put ` +
          `it back. Everything else in the session was restored.`,
        s.id,
      );
    }
  }

  // Nothing above can throw past here: a failing source is caught per image, or propagated (an SVG's
  // uncaught parseSVGDocument), so `state` never ends up a mix of pre-restore values.
  // Committed before the parts load because the load reads some of these (a generated role's mesh
  // follows `hubcapDiameterMm`), so they're snapshotted and put back if it fails; asmSwitchKindAndLoad restores the kind itself.
  // if that load does not complete; asmSwitchKindAndLoad puts the kind back itself.
  const before = {
    scalars: Object.fromEntries(
      Object.keys(pending).map((k) => [k, state[k as keyof AppState]]),
    ) as Partial<AppState>,
  };
  Object.assign(state, pending);

  const kind =
    session.shapeKind === 'assembly' && session.assembly.kindId
      ? ASSEMBLY_KINDS.find((k) => k.id === session.assembly.kindId)
      : undefined;
  let keepSavedZones = true;
  if (session.shapeKind === 'assembly' && kind) {
    // A load that didn't complete must not leave the kind standing without its designs; a newer
    // part switch owns the kind, so the session's designs aren't applied to a part they weren't saved for.
    const outcome = await asmSwitchKindAndLoad(kind.id, session.assembly.variantId);
    if (outcome === 'failed' || outcome === 'superseded') {
      Object.assign(state, before.scalars);
      throw new SessionPartsError(kind.name, outcome);
    }
  } else {
    // An assembly kind that no longer exists, or a retired flat mode. Neither is in the Part
    // dropdown, so keeping the saved value leaves the select blank and the next switch one-way. Take
    // the first offered kind; restoreBanner's applyPartKind auto-loads the parts (loading here would
    // alert about an unreachable library the caller is about to retry).
    state.assembly.kindId = firstOfferedKind().id;
    state.assembly.variantId = null;
    // Cleared like `#shape-kind`'s handler (ui/partPanel.ts): maybeAutoLoadAssembly no-ops while
    // parts exist, so the dropdown would name the fallback kind while scene and export held the other's.
    state.assembly.parts = [];
    // The saved zone bindings can't be re-applied either: they name zones on a different part, and
    // an instance bound to an unmatched zone is dropped by geometry/partBuild.ts uncut and unwarned.
    keepSavedZones = false;
  }

  // Instances of an unrebuilt source go with it, or lookups by sourceId return undefined. The active
  // selection is re-pointed below: on a dead id setActiveArtwork returns early, leaving no parsed
  // design and Export off while restored artwork sits unselected.
  const zoneOf = new Map(session.artworks.map((a) => [a.id, a.zoneId]));
  const artworks: ArtworkInstance[] = session.artworks
    .filter((a) => !lostSources.has(a.sourceId))
    .map((a) => ({
      id: a.id,
      sourceId: a.sourceId,
      zone: null,
      offsetU: a.offsetU,
      offsetV: a.offsetV,
      scalePct: a.scalePct,
      rotationDeg: a.rotationDeg,
      flipX: a.flipX,
      flipY: a.flipY,
      // Absent stays absent: a pre-Mirror session reads as off.
      ...(a.mirror === true ? { mirror: true } : {}),
      // Clamped: a session saved before its kind withheld Fill still carries 'fill' and would walk
      // into the path the flag keeps users out of. Runs after the kind is set, so it clamps for the restored part.
      mode: allowedArtworkMode(a.mode),
    }));
  restoreArtworkPool(sources, artworks);
  // A saved zoneId the loaded parts no longer offer (a re-bake renamed or dropped it) matches no
  // mapper, so geometry/partBuild.ts cuts that design nowhere, silently, and the dropdown shows no
  // selection. Sent to All zones instead, and said out loud.
  //
  // **An empty zone list is not evidence**, so the check is gated on zones being offered:
  // asmLoadFullAssembly returns quietly while the parts manifest is in flight, making "no zones"
  // far more often "not yet" than "retired", and discarding every binding then loses them before
  // the deferred load lands. A part failing its own fetch already alerts; only the false total wipe needs guarding.
  const offered = new Set(availableZones().map((z) => z.zoneId));
  const judgeable = keepSavedZones && offered.size > 0;
  const resolves = (zoneId: string | null): boolean => zoneId === null || offered.has(zoneId);
  // Over the restored instances: a design whose source couldn't be rebuilt is gone from state and already has its own warning.
  const orphaned = judgeable ? artworks.filter((a) => !resolves(zoneOf.get(a.id) ?? null)) : [];
  artworks.forEach((a) => {
    const zoneId = zoneOf.get(a.id) ?? null;
    setArtworkZone(a.id, keepSavedZones && (!judgeable || resolves(zoneId)) ? zoneId : null);
  });
  if (orphaned.length)
    warn(
      orphaned.length === 1
        ? `1 design was on a zone this part no longer has. It's on All zones now.`
        : `${orphaned.length} designs were on zones this part no longer has. They're on All zones now.`,
    );
  setActiveArtwork(
    artworks.some((a) => a.id === session.activeArtworkId)
      ? session.activeArtworkId
      : (artworks[0]?.id ?? null),
  );
  pruneSettingsToPalette();
}
