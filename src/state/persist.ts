import type { AppState } from './store';
import { state } from './store';
import type { ArtworkInstance, DesignSource } from '../types';
import {
  allowedArtworkMode,
  pruneSettingsToPalette,
  restoreArtworkPool,
  setActiveArtwork,
  setArtworkZone,
} from './artwork';
import { ASSEMBLY_KINDS, firstOfferedKind } from '../assembly/kinds';
import { HUBCAP_MIN_DIAMETER_MM } from '../geometry/hubcap';
import { getPrinter } from '../export/printers';
import { asmLoadFullAssembly } from '../assembly/parts';
import { parseSVGDocument } from '../svg/parse';
import { decodeWorkingImage, encodeWorkingImage } from '../raster/store';
import { parseRasterImage, rasterCappedMessage, rasterTracedMessage } from '../raster/parse';
import { notice, warn } from '../warnings';
import type { RasterImage } from '../raster/types';

const STORAGE_KEY = 'tmt-mosaic:session:v1';
const SCHEMA_VERSION = 1;
/** Past this, skip the write rather than risk a QuotaExceededError mid-session — localStorage's
 * per-origin quota is commonly ~5-10MB and this app is the only thing using it, but a
 * dense/multi-design session storing raw SVG text should still have a hard ceiling. */
const MAX_BYTES = 4_000_000;

/**
 * How much of a session all its images together may take, as data-URL characters.
 *
 * Measured re-encodes: flat art at 1024px is ~24KB of PNG, a photograph at 512px ~703KB, and a
 * data URL is base64, so about a third larger again — one photograph lands near 950,000
 * characters. A per-image cap alone is not enough: four photographs each pass it and together push
 * the JSON past MAX_BYTES, at which point saveSession writes nothing and the SVG half of the
 * session, which saved fine before images were persisted at all, is lost with them.
 *
 * So images are admitted in order until the budget is spent, and the rest drop out the way an
 * unencodable one does, with the unload prompt to say so. 2.5M of the 4M leaves the SVG sources,
 * placements and settings room they will not realistically exceed.
 */
const MAX_IMAGE_CHARS_TOTAL = 2_500_000;

/**
 * Last encode per source, keyed on the pixel buffer it came from.
 *
 * Every debounced autosave runs snapshotSession, and beforeunload runs it again synchronously.
 * Re-encoding a 512px photograph to PNG on each of those is main-thread work for a result that
 * cannot have changed: the working pixels are replaced wholesale when the Colors or Detail sliders
 * re-run, never mutated in place, so buffer identity is a sound key.
 */
const pngCache = new WeakMap<Uint8ClampedArray, string>();

function encodedPng(image: RasterImage): string | null {
  const hit = pngCache.get(image.data);
  if (hit !== undefined) return hit;
  const png = encodeWorkingImage(image);
  // Only a success is remembered. A failure can be transient (an allocation that lost a race), and
  // caching it would drop that image from every later save for the rest of the session.
  if (png) pngCache.set(image.data, png);
  return png;
}

type PersistedSource = Pick<DesignSource, 'id' | 'kind' | 'name' | 'svgText'> & {
  /**
   * A raster source's working image, re-encoded as a PNG data URL, plus what the trace needs to
   * reproduce the same result from it. Absent on an SVG source, and on a raster session saved
   * before this existed.
   *
   * `edgeDensity` travels with the pixels because it cannot be re-derived from them: the same
   * image measures flatter the larger it is decoded, so re-measuring the working image would move
   * the flat-vs-photo thresholds and every blur and despeckle strength hanging off them (see
   * RasterImage in raster/types.ts).
   *
   * `mmPerPixel` travels for a different reason: it *could* be re-derived, but not here. The
   * re-trace below runs before the assembly's parts are back, so the design face it would ask for
   * does not exist yet, and per-instance scales are still in the session rather than in state.
   */
  raster?: {
    png: string;
    colors: number;
    detail: number;
    edgeDensity?: number;
    mmPerPixel?: number;
  };
};
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
 * Whether there's anything worth losing — gates the beforeunload prompt, and separates "nothing
 * was loaded" from "what was loaded couldn't be persisted" in saveSession(). Deliberately just
 * "is a design loaded," not "are assembly parts
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
 * found something the restore banner won't bring back — either the write didn't land at all, or it
 * landed without a loaded image, which never persists. A session that autosaved in full is already
 * recoverable, so warning about it too would just teach makers to reflexively click through the
 * cases where the warning is actually true.
 */
export function initBeforeUnloadGuard(): void {
  window.addEventListener('beforeunload', (e) => {
    if (!hasLoadedWork()) return;
    flushPendingSave();
    if (!lastSaveFailed && !lastSaveDropped) return;
    e.preventDefault();
    e.returnValue = lastSaveFailed
      ? "TMT Mosaic couldn't save this session — leaving now loses it."
      : 'TMT Mosaic saved this session, but an image could not be saved — leaving now means ' +
        're-dropping it.';
  });
  // beforeunload is skipped outright on mobile backgrounding and bfcache eviction, so this is the
  // flush that actually runs there.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPendingSave();
  });
}

function snapshotSession(): PersistedSession {
  // Encoded first, because a source whose image will not encode has to be left out exactly as
  // every image used to be: its instances dropped with it, or restore rebuilds placements pointing
  // at a source that is not there.
  const rasterPayloads = new Map<string, NonNullable<PersistedSource['raster']>>();
  let imageChars = 0;
  for (const s of state.sources) {
    // `!s.raster.image` is not reachable from the app, which always loads pixels with the source,
    // but a malformed source must drop out of the save rather than throw and take the session
    // with it — snapshotSession runs outside saveSession's try.
    if (!s.raster?.image) continue;
    const png = encodedPng(s.raster.image);
    // Over budget, this image is left out rather than the whole save failing. The data URL is
    // already base64, so its length is what it costs in the JSON.
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
    // An SVG source restores by re-parsing `svgText`. A raster source has none — it came from
    // pixels — so it carries its working image re-encoded as PNG, which restore decodes and
    // re-traces. Raw pixels were rejected here and still are: 1024x1024 RGBA is 4.0MB against a
    // MAX_BYTES of 4MB, while the same pixels as PNG measure 24KB for flat art and 703KB for a
    // photograph (see raster/store.ts for why PNG and why the working image).
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
 * Whether the most recent snapshot left a loaded design out of the save.
 *
 * A raster source never round-trips (its pixels are the design, and they don't fit in
 * localStorage), so a session holding one is only ever partly recoverable — even when the write
 * itself succeeds. That is the whole case the unload guard exists for, and lastSaveFailed alone
 * cannot see it: a session with one SVG and one image saves cleanly, reports success, and drops the
 * image with nothing said. Tracked separately rather than folded into lastSaveFailed so the two
 * stay honest about which one happened.
 */
let lastSaveDropped = false;

/**
 * Whether a session that was already in storage when this page loaded is still unanswered.
 *
 * The empty-snapshot clear below is what destroys a saved session, and it fires about a second
 * into any bare boot. Until the offer has been answered there is nothing to act on, so clearing
 * is premature — three separate ways of losing work measured on 2026-08-24 were all this:
 * a `?kind=` link (the banner is never shown, so the session was never offered), a reload while
 * the banner sits unanswered on screen, and a restore that threw.
 */
let unansweredSavedSession = false;

/**
 * Arm the hold if the user arrived with a saved session. Called once at boot, before anything
 * decides whether to offer it — including the paths that decide not to (`?kind=`, a withheld
 * kind), which are the ones that used to destroy it.
 *
 * **Armed rather than defaulting on.** It protects the session the user arrived with, not any
 * session: defaulting to held meant a visitor who arrived with nothing, loaded a design and then
 * deleted it kept an emptied session in storage and was offered it back next visit, which is the
 * exact thing the clear exists to prevent.
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
 * Whether the session already in storage is on an assembly kind that's currently withheld from
 * the UI (`AssemblyKind.hidden`). Such a session is never offered back — initRestoreBanner()
 * skips it — so the empty-snapshot clear in saveSession() would be the thing that destroys it,
 * about a second after a bare default boot and with nothing shown to the user to explain it.
 * Held instead until the kind is offered again, or until real work overwrites it through the
 * normal save path.
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
 * Write the current session, swallowing every failure — private browsing with storage disabled,
 * a quota already full of other sites' data, a circular/unserializable value that shouldn't exist
 * but shouldn't crash a rebuild if it did. A session that fails to save just means the next
 * restore-banner check finds nothing, same as a first visit; never worth surfacing to the user
 * mid-work. Mirrors helpPanel.ts's degrade-silently pattern for the same reason. lastSaveFailed
 * is the one exception — read only at unload, to decide whether the native prompt is warranted.
 */
/** The notice shown when a restore failed. Exported so the banner and the re-announce agree. */
export const SESSION_WRITES_DISABLED_MSG =
  'That saved session could not be opened, so it was cleared. Reload the page to start clean.';

export function saveSession(): void {
  if (writesDisabledAfterFailedRestore) {
    // Two things this must not skip.
    //
    // `lastSaveFailed` drives the beforeunload prompt, so leaving it false meant the guard went
    // quiet exactly when nothing is being saved: work for ten minutes, close the tab, no prompt.
    lastSaveFailed = true;
    // And the notice is re-stated, because loading an SVG calls clearWarnings() (src/svg/parse.ts)
    // and drops it, leaving an app that looks healthy while persisting nothing. warn() dedupes by
    // message, so this is free. Same reason csgFault.ts re-announces rather than pushing once.
    // It lands one render late, since this runs on the debounced save rather than inside a build.
    warn(SESSION_WRITES_DISABLED_MSG);
    return;
  }
  // An empty snapshot (no artwork, no loaded parts) isn't worth restoring — and saving one
  // unconditionally would re-arm the restore banner within a second of a user dismissing it, since
  // the default boot's own bare-wheel rebuild reaches this same path. Clear instead, so "Start
  // fresh" actually stays fresh, and so removing the last artwork instance doesn't leave a stale
  // save behind either.
  //
  // Judged on the snapshot rather than on hasLoadedWork(). The two used to disagree for a session
  // whose only design was an image, because snapshotSession() skipped raster sources; they agree
  // now that those round-trip, and the snapshot is still the honest thing to judge, since it is
  // what actually reaches storage.
  const session = snapshotSession();
  // Any image that did not make it, not only the case where every one failed: with two images and
  // one refusal the second and all its placements would otherwise be dropped in silence.
  const savedRasterIds = new Set(session.sources.filter((s) => s.raster).map((s) => s.id));
  lastSaveDropped = state.sources.some((s) => s.raster && !savedRasterIds.has(s.id));
  if (!session.artworks.length) {
    // Held only while nothing is loaded. `hasLoadedWork()` is the difference between a bare boot,
    // where the stored session is still the user's only copy and the restore offer may not even
    // have been seen yet, and a session the user has actively moved past — they loaded something
    // that could not be saved, which genuinely supersedes what is in storage.
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
    // What is in storage is now this page's own work, not the session the user arrived with, so
    // the hold has nothing left to protect. Without this it never ended on a boot where the banner
    // is never answered — a `?kind=` link, or a banner the user simply ignores — and deleting the
    // last design afterwards left the *earlier* work in storage, offered back next visit as a
    // design they had removed.
    unansweredSavedSession = false;
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

/**
 * Set when a restore failed part-way, and never cleared: writes stay off until the page reloads.
 *
 * The failure message tells the user to reload precisely because the restore assigns state as it
 * goes, so what is in memory at that point is inconsistent. Without this the next rebuild's
 * debounced save wrote exactly that state back over the session the catch had just cleared, and
 * the next visit offered a session built from the thing that had failed.
 */
let writesDisabledAfterFailedRestore = false;

/** Called by the restore banner when a restore throws part-way. */
export function disableSessionWritesAfterFailedRestore(): void {
  writesDisabledAfterFailedRestore = true;
}

/** Debounced save — called after every rebuild (see app/rebuild.ts) and a couple of state changes
 * that don't go through one (the printer picker). One save per burst of activity, not one per
 * keystroke/slider tick. */
export function schedulePersist(): void {
  if (restoring) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    // Re-checked here, not only when scheduling. A save armed a moment *before* the user clicked
    // Restore fires in the middle of it and writes an empty snapshot over the session being
    // restored — the exact loss `restoring` exists to prevent, through the one path that skipped
    // its guard.
    if (restoring) return;
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
 * Fill in the containers `applyRestoredSession` dereferences, for a session that does not carry
 * them.
 *
 * **Repaired rather than rejected, deliberately.** Seven single-field corruptions used to pass the
 * gate above and throw part-way through the restore (measured 2026-08-24); three left the app
 * unable to build at all, showing the raw exception text, recoverable only by F5 — because the
 * restore assigns state as it goes, so a throw leaves it half applied. Tightening the gate to
 * reject them was the first fix and was wrong: a session written by an older build, before one of
 * these fields existed, is not corrupt and still carries the user's artwork. Discarding it to
 * avoid a crash trades one kind of lost work for another.
 *
 * So each container is replaced only when it is not the shape the restore needs, and every default
 * here is the same "nothing set" the app boots with.
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
    disc: obj(s.disc, { ...state.disc }),
    rect: obj(s.rect, { ...state.rect }),
    round: obj(s.round, { ...state.round }),
    stlPlate: obj(s.stlPlate, { ...state.stlPlate }),
    assembly: obj(s.assembly, { kindId: null, variantId: null }),
  };
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
    return repairSessionContainers(parsed);
  } catch {
    // Cleared, like the schema branch above. Without this an unparseable blob was held forever:
    // nothing renders a banner for it, so nothing ever answers the offer, so the empty-snapshot
    // clear that used to tidy it up stays suppressed for every future visit as well.
    clearSavedSession();
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
 * restored parts (and their fresh session-local ids) to already exist.
 *
 * **`state.assembly.parts` is not empty on entry**, and a previous version of this comment said it
 * was. The boot's own auto-load has always filled it, so asmLoadFullAssembly's confirmDialog guard
 * did fire, raising a second question on top of the restore the user had just accepted — and
 * cancelling it exported the boot kind's parts under the restored kind's filename. Both branches
 * below clear the list before loading; do not remove that on the strength of the old claim.
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
  // Coerced to a printer that exists, not adopted verbatim. An unknown id (an older build's, a
  // hand-edited session) left `#p-printer` blank while getPrinter() silently fell back to the
  // default bed — and the bed is what every verified placement is checked against, so the export
  // would use one printer's plate while the picker named none.
  state.printerId = getPrinter(session.printerId).id;
  state.asmRadius = session.asmRadius;
  // Older sessions predate the hubcap, so an absent value keeps the default rather than NaN.
  //
  // Clamped at BOTH ends here, against the printer restored on the line above. A stored value
  // never comes through the control that normally bounds it: below the floor the disc misses its
  // mounting clips entirely, and above the plate it is a part the machine cannot print. An earlier
  // version of this only floored, on the grounds that the ceiling would be re-applied once the
  // printer was known — but no restore path calls that, so a session saved on a big bed came back
  // oversized on a small one.
  if (typeof session.hubcapDiameterMm === 'number' && Number.isFinite(session.hubcapDiameterMm)) {
    const plate = getPrinter(state.printerId).plate;
    state.hubcapDiameterMm = Math.min(
      Math.min(plate.w, plate.d),
      Math.max(HUBCAP_MIN_DIAMETER_MM, session.hubcapDiameterMm),
    );
  }
  // No clamp to match: the shape checks all run at rebuild, and every one of them falls back to a
  // circle with a message rather than to something unprintable.
  if (typeof session.hubcapSilhouette === 'boolean')
    state.hubcapSilhouette = session.hubcapSilhouette;
  state.baseFilamentId = session.baseFilamentId;
  state.autoMergeLevel = session.autoMergeLevel;
  state.baseColorKey = session.baseColorKey;
  state.baseColorMembers = session.baseColorMembers;
  state.mergeGroups = session.mergeGroups;
  state.colorSettings = restoredColorSettings(session);
  state.keptApart = session.keptApart;

  // A raster source is decoded and re-traced; an SVG one is re-parsed. Both are rebuilt before any
  // state is touched, matching the rest of this function and applyRasterFile: a source that fails
  // to come back must not leave a half-restored session behind.
  //
  // This is the one place restore does real image work, and it is the cost of the feature: on a
  // 512px photograph the quantize and trace measured ~830ms. It runs inside the same overlay the
  // restore already shows.
  const sources: DesignSource[] = [];
  const lostSources = new Set<string>();
  for (const s of session.sources) {
    if (!s.raster) {
      sources.push({ ...s, raster: undefined, parsed: parseSVGDocument(s.svgText) });
      continue;
    }
    // Per image, not per session. A decode or trace that throws must cost that one design, not the
    // restore: the banner treats a rejected restore as a dead session and calls clearSavedSession,
    // so letting this escape would destroy the SVG designs alongside it, permanently. The save
    // path already degrades per image; this is the matching half.
    try {
      const image = await decodeWorkingImage(s.raster.png);
      // Put back the statistic that cannot be re-measured from these pixels (see PersistedSource).
      if (s.raster.edgeDensity !== undefined) image.edgeDensity = s.raster.edgeDensity;
      const opts = {
        colors: s.raster.colors,
        detail: s.raster.detail,
        // Whatever was saved, in every shape kind. This is a reconstruction, not a fresh trace:
        // the design in the saved session carries this floor whether or not the mode it was
        // switched into would derive one now (nothing re-traces on a shape-kind change), and a
        // restore that quietly returns a different design is the failure this payload exists to
        // prevent. `requantizeSource` is the other half, and re-derives.
        mmPerPixel: s.raster.mmPerPixel,
      };
      const result = parseRasterImage(image, opts);
      // The same notice the first load gave. Without it a design that comes back simplified looks
      // like the app quietly changed it.
      if (result.capped) notice(rasterCappedMessage(s.name));
      else notice(rasterTracedMessage(s.name));
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
        `"${s.name}" could not be restored from the saved session — load the image again to put ` +
          `it back. Everything else in the session was restored.`,
      );
    }
  }

  const kind =
    session.shapeKind === 'assembly' && session.assembly.kindId
      ? ASSEMBLY_KINDS.find((k) => k.id === session.assembly.kindId)
      : undefined;
  let keepSavedZones = true;
  if (session.shapeKind === 'assembly' && kind) {
    state.shapeKind = 'assembly';
    state.assembly.kindId = kind.id;
    state.assembly.variantId = session.assembly.variantId;
    // Cleared before the load, not left to asmLoadFullAssembly's own clear. That clear sits behind
    // a confirm ("Load the full X? This clears any parts you've already added"), and the boot's
    // auto-load has always filled this list, so restoring raised a second dialog on top of the one
    // the user just accepted. Cancelling it returned without touching the scene while `kindId` and
    // the dropdown had already moved: the export then wrote the *previous* kind's parts under the
    // restored kind's filename. Measured 2026-08-24: a restored footrest session exported
    // `mosaic-footrest.3mf` holding the wheel's Top/Bottom/Cap, valid and printable, no warning.
    state.assembly.parts = [];
    await asmLoadFullAssembly();
  } else {
    // Either an assembly kind that no longer exists (renamed/retired since the session was saved),
    // or a flat mode from a session saved back when one was offered. Neither has an option in the
    // Part dropdown any more, so falling back to the saved value would leave the select blank and
    // the next switch away from it one-way. Take the first offered kind instead of failing the
    // whole restore. The parts are left to restoreBanner's own setShapeKind, which auto-loads
    // them: loading here would alert about an unreachable library the caller is about to retry.
    state.shapeKind = 'assembly';
    state.assembly.kindId = firstOfferedKind().id;
    state.assembly.variantId = null;
    // Cleared for the same reason `#shape-kind`'s own handler clears them (ui/partPanel.ts):
    // maybeAutoLoadAssembly no-ops while any part is present, so leaving the previous kind's in
    // place would name the fallback kind in the dropdown while the scene and the export still
    // held the other one's.
    state.assembly.parts = [];
    // And the saved zone bindings can't be re-applied below, for the other half of that handler's
    // reasoning: they name zones on a part that is not the one being restored onto. An instance
    // bound to a zone no mapper matches is dropped by geometry/assembly.ts and never cut, with no
    // warning and, on a part with one design face, no dropdown to re-target it.
    keepSavedZones = false;
  }

  // Instances of a source that could not be rebuilt go with it, or the placement points at
  // nothing and every later lookup by sourceId returns undefined. The active selection is
  // re-pointed below for the same reason: left on a dead id, setActiveArtwork returns early and
  // the app comes back with no parsed design and Export off, while the artwork that DID restore
  // sits in state unselected.
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
      // Clamped, not trusted: a session saved before its kind withheld Fill (or before the flag
      // existed) still carries 'fill', and restoring it verbatim would walk straight into the path
      // the flag keeps users out of. Runs after the kind is set above, so it clamps against the
      // part actually being restored.
      mode: allowedArtworkMode(a.mode),
    }));
  restoreArtworkPool(sources, artworks);
  session.artworks.forEach((a) => setArtworkZone(a.id, keepSavedZones ? a.zoneId : null));
  setActiveArtwork(
    artworks.some((a) => a.id === session.activeArtworkId)
      ? session.activeArtworkId
      : (artworks[0]?.id ?? null),
  );
  pruneSettingsToPalette();
}
