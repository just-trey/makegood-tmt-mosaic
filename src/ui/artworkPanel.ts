import type { ArtworkInstance, DesignSource } from '../types';
import {
  announceTrace,
  loadArtworkSource,
  pruneSettingsToPalette,
  rasterMmPerPixel,
} from '../state/artwork';
import { scheduleRebuild } from '../app/scheduler';
import { beginWork, endWork } from '../app/idle';
import { requestFrame } from '../scene/viewport';
import { parseSVGDocument } from '../svg/parse';
import { decodeImageFile, isRasterBuffer } from '../raster/decode';
import { parseRasterImage } from '../raster/parse';
import { DETAIL_DEFAULT } from '../raster/stats';
import { clearWarnings, warn } from '../warnings';
import { renderWarnings } from './warningsView';
import { renderArtworkList } from './artworkListPanel';
import { refreshFitInputsFromState, updateOffsetSliderRanges } from './fitPanel';
import { $, input } from './dom';
import { track } from '../analytics/track';
import { alertDialog } from './dialogs';

// 3 colors on purpose: with the body that is 4 AMS slots, one unit, so the demo never opens on a capacity pill. The big centred circle doubles as the design anchor.
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
  // no-op. clearWarnings() lives here, not in parseSVGDocument — a parser must not own UI state, and
  // the restore loop parses several sources without each wiping the last (state/persist.ts).
  clearWarnings();
  const parsed = parseSVGDocument(svgText);
  loadArtworkSource(parsed, fname, kind, mode, svgText); // adds a new source+instance alongside any already loaded
  afterArtworkLoaded(fname);
}

/** Number of colors a freshly-loaded image starts at. Deliberately modest: an AMS is four slots plus the body, so a twelve-slot default would be a print this audience can't make. The Colors slider goes to 16. */
const DEFAULT_RASTER_COLORS = 6;

function reportLoadFailure(fname: string, message: string): void {
  clearWarnings();
  warn(message);
  renderWarnings();
  // Fire-and-forget: always a terminal error path (the load already stopped); nothing waits on the dialog.
  void alertDialog(`Could not load "${fname}": ${message}`);
}

/** Decode and trace an image file into a new design source. Async, so it counts as outstanding work: the count must span the whole decode, or a drive script's whenIdle() resolves mid-read and screenshots a scene without it. */
async function applyRasterFile(file: File): Promise<void> {
  beginWork();
  try {
    const image = await decodeImageFile(file);
    const opts = {
      colors: DEFAULT_RASTER_COLORS,
      detail: DETAIL_DEFAULT,
      mmPerPixel: rasterMmPerPixel(image),
    };
    // Decode and trace before touching state, like applyParsedSVG. name is passed beside opts, not in it: opts is spread into the RasterState on the source, which has no name field (state/persist.ts).
    const result = parseRasterImage(image, { ...opts, name: file.name });
    // After the parse so a failed one leaves state alone; applyParsedSVG clears for SVGs and the raster path must too, or an earlier failure's warning outlives every good load.
    clearWarnings();
    // No svgText: an image's source of truth is its pixels, round-tripped separately as the working copy re-encoded to PNG (raster/store.ts).
    const instance = loadArtworkSource(result.parsed, file.name, 'raster', 'sticker', '', {
      image,
      ...opts,
      palette: result.palette,
      regions: result.componentCount,
    });
    announceTrace(instance.sourceId, file.name, result);
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
  // onloadend, not onload: it covers a read error or abort, which would leave the counter above zero
  // and hang every later whenIdle(). It runs after onload, so applyParsedSVG()'s rebuild (or applyRasterFile's beginWork()) has taken over the count.
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
  // One binary read for both paths — the SVG branch decodes it as text itself, free, and it lets the format be sniffed from bytes, not the filename.
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
