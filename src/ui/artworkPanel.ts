import type { ArtworkInstance, DesignSource } from '../types';
import { loadArtworkSource, pruneSettingsToPalette, rasterMmPerPixel } from '../state/artwork';
import { getPatterns } from '../state/patterns';
import { fillModeOffered } from '../assembly/kinds';
import { scheduleRebuild } from '../app/scheduler';
import { beginWork, endWork } from '../app/idle';
import { requestFrame } from '../scene/viewport';
import { parseSVGDocument } from '../svg/parse';
import { decodeImageFile, isRasterBuffer } from '../raster/decode';
import { rasterCappedMessage, rasterTracedMessage } from '../raster/parse';
import { parseRasterImage } from '../raster/parse';
import { DETAIL_DEFAULT } from '../raster/stats';
import { clearWarnings, notice, warn } from '../warnings';
import { renderWarnings } from './warningsView';
import { renderArtworkList } from './artworkListPanel';
import { refreshFitInputsFromState, updateOffsetSliderRanges } from './fitPanel';
import { $, input } from './dom';
import { track } from '../analytics/track';
import { alertDialog } from './dialogs';

// 3 colors on purpose: with the body that is 4 AMS slots, exactly one AMS unit, so the app's own
// demo never opens on a capacity pill. The big centred circle doubles as the design anchor.
const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <circle cx="100" cy="100" r="95" fill="#1e5fa8"/>
  <path d="M100 20 L118 72 L174 72 L128 104 L146 158 L100 124 L54 158 L72 104 L26 72 L82 72 Z" fill="#f5d020"/>
  <circle cx="100" cy="100" r="16" fill="#c1272d"/>
</svg>`;

/** Shared tail of every load path: settle the palette, refresh the panels, rebuild. */
function afterArtworkLoaded(fname: string): void {
  pruneSettingsToPalette();
  $('#svg-fname').textContent = fname;
  renderArtworkList();
  refreshFitInputsFromState();
  updateOffsetSliderRanges();
  requestFrame();
  scheduleRebuild();
}

// Exported for the failed-load regression test; not used outside this module.
export function applyParsedSVG(
  svgText: string,
  fname: string,
  kind: DesignSource['kind'] = 'upload',
  mode: ArtworkInstance['mode'] = 'sticker',
): void {
  // Parse first: parseSVGDocument throws on a malformed/empty SVG, and a failed load must be a
  // no-op that leaves whatever's already loaded untouched. clearWarnings() lives here, not inside
  // parseSVGDocument — a parser must not own UI state, and the session-restore loop parses one SVG
  // source per source without wanting each to wipe the one before it (see state/persist.ts).
  clearWarnings();
  const parsed = parseSVGDocument(svgText);
  loadArtworkSource(parsed, fname, kind, mode, svgText); // adds a new source+instance alongside any already loaded
  afterArtworkLoaded(fname);
}

/**
 * Load one of the built-in library patterns (public/patterns/*.svg) as a new design source.
 * Defaults to Fill mode in assembly mode — a pattern exists to repeat across a surface, not to
 * sit as one copy — but stays Sticker in flat-plate mode, which has no fill pipeline at all
 * (see the "fill is assembly-mode only" limitation in README).
 */
// Exported for the mode-selection regression test; not used outside this module.
export async function applyPattern(id: string): Promise<void> {
  const entry = getPatterns().find((p) => p.id === id);
  if (!entry) return;
  // Counted as outstanding work for the whole fetch, not just the rebuild it ends in: otherwise
  // a drive script's whenIdle() resolves while the artwork is still downloading, and it goes on
  // to screenshot or export a scene that has none of it. applyParsedSVG() takes over the count
  // (via scheduleRebuild) before the finally runs, so there's no zero-width idle gap between.
  beginWork();
  try {
    const res = await fetch(`patterns/${entry.file}`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const svgText = await res.text();
    const mode = fillModeOffered() ? 'fill' : 'sticker';
    applyParsedSVG(svgText, entry.name, 'pattern', mode);
    track('artwork_load', { source: 'pattern', pattern: id });
  } catch (e) {
    clearWarnings();
    warn((e as Error).message);
    renderWarnings();
    await alertDialog('Could not load pattern: ' + (e as Error).message);
  } finally {
    endWork();
  }
}

/**
 * The built-in pattern picker strip: one thumbnail button per public/patterns/patterns.json
 * entry. The strip's membership never changes at runtime, but its visibility does — a part
 * switch re-runs this, since a kind withholding Fill hides it (see below).
 */
export function renderPatternPicker(): void {
  const strip = $('#pattern-picker');
  const patterns = getPatterns();
  // A pattern exists to repeat across a surface; as a single sticker it's a lone swatch of cow
  // print, which is not what any of these thumbnails look like they'd do. So the strip goes with
  // Fill rather than degrading into a placement nobody asked for.
  if (!patterns.length || !fillModeOffered()) {
    strip.style.display = 'none';
    return;
  }
  strip.style.display = '';
  strip.innerHTML = '';
  patterns.forEach((p) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pattern-swatch';
    btn.title = p.name;
    btn.setAttribute('aria-label', `Load "${p.name}" pattern as artwork`);
    const img = document.createElement('img');
    img.src = `patterns/${p.file}`;
    img.alt = p.name;
    btn.appendChild(img);
    btn.addEventListener('click', () => void applyPattern(p.id));
    strip.appendChild(btn);
  });
}

/** Number of colors a freshly-loaded image starts at. Deliberately modest: an AMS is four slots
 * plus the body, so a default that produced a twelve-slot export would be a print this tool's
 * audience cannot actually make. The Colors slider goes to 16 for anyone who wants it. */
const DEFAULT_RASTER_COLORS = 6;

function reportLoadFailure(fname: string, message: string): void {
  clearWarnings();
  warn(message);
  renderWarnings();
  // Fire-and-forget: this is always a terminal error path (the failed load already stopped),
  // nothing downstream needs to wait for the dialog to close.
  void alertDialog(`Could not load "${fname}": ${message}`);
}

/**
 * Decode and trace an image file into a new design source.
 *
 * Async, so it follows applyPattern's work-counter shape rather than loadArtworkFile's: the count
 * has to span the whole decode, or a drive script's whenIdle() resolves while the image is still
 * being read and it screenshots a scene without it.
 */
async function applyRasterFile(file: File): Promise<void> {
  beginWork();
  try {
    const image = await decodeImageFile(file);
    const opts = {
      colors: DEFAULT_RASTER_COLORS,
      detail: DETAIL_DEFAULT,
      mmPerPixel: rasterMmPerPixel(image),
    };
    // Decode and trace before touching state, for the same reason applyParsedSVG parses first.
    // name is passed alongside opts, not folded into it: opts is spread into the RasterState
    // stored on the source below, which has no name field of its own (see state/persist.ts).
    const result = parseRasterImage(image, { ...opts, name: file.name });
    // No svgText: an image's source of truth is its pixels. Session persistence round-trips those
    // separately, as the working copy re-encoded to PNG (see raster/store.ts).
    const instance = loadArtworkSource(result.parsed, file.name, 'raster', 'sticker', '', {
      image,
      ...opts,
      palette: result.palette,
      regions: result.componentCount,
    });
    if (result.capped) notice(rasterCappedMessage(file.name), instance.sourceId);
    else notice(rasterTracedMessage(file.name), instance.sourceId);
    afterArtworkLoaded(file.name);
    renderWarnings();
    track('artwork_load', { source: 'raster' });
  } catch (e) {
    reportLoadFailure(file.name, (e as Error).message);
  } finally {
    endWork();
  }
}

function loadArtworkFile(file: File): void {
  beginWork();
  const reader = new FileReader();
  // onloadend, not the onload path: it also covers a read error or abort, which would otherwise
  // leave the counter above zero forever and hang every later whenIdle(). It runs after onload,
  // so the rebuild applyParsedSVG() schedules — or applyRasterFile's own beginWork() — has already
  // taken over the count.
  reader.onloadend = () => endWork();
  reader.onload = () => {
    const buf = new Uint8Array(reader.result as ArrayBuffer);
    if (isRasterBuffer(buf)) {
      void applyRasterFile(file);
      return;
    }
    try {
      applyParsedSVG(new TextDecoder().decode(buf), file.name);
      track('artwork_load', { source: 'upload' });
    } catch (e) {
      reportLoadFailure(file.name, (e as Error).message);
    }
  };
  // One binary read for both paths — the SVG branch decodes it as text itself, which costs nothing
  // and is what lets the format be sniffed from the bytes rather than trusted from the filename.
  reader.readAsArrayBuffer(file);
}

export function initArtworkPanel(): void {
  const dropzone = $('#dropzone');
  dropzone.addEventListener('click', () => input('#svg-input').click());
  input('#svg-input').addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) loadArtworkFile(f);
  });
  ['dragover', 'dragenter'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.add('drag');
    }),
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag');
    }),
  );
  dropzone.addEventListener('drop', (e) => {
    const f = (e as DragEvent).dataTransfer?.files[0];
    if (f) loadArtworkFile(f);
  });

  $('#btn-sample').addEventListener('click', () => {
    applyParsedSVG(SAMPLE_SVG, 'sample-badge.svg');
    track('artwork_load', { source: 'sample' });
  });
}
