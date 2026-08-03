import type { ArtworkInstance, DesignSource } from '../types';
import { loadArtworkSource, pruneSettingsToPalette } from '../state/artwork';
import { getPatterns } from '../state/patterns';
import { state } from '../state/store';
import { scheduleRebuild } from '../app/scheduler';
import { beginWork, endWork } from '../app/idle';
import { requestFrame } from '../scene/viewport';
import { parseSVGDocument } from '../svg/parse';
import { clearWarnings, warn } from '../warnings';
import { renderWarnings } from './warningsView';
import { renderArtworkList } from './artworkListPanel';
import { refreshFitInputsFromState, updateOffsetSliderRanges } from './fitPanel';
import { $, input } from './dom';
import { track } from '../analytics/track';
import { alertDialog } from './dialogs';

const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <circle cx="100" cy="100" r="95" fill="#1e5fa8"/>
  <path d="M100 20 L118 72 L174 72 L128 104 L146 158 L100 124 L54 158 L72 104 L26 72 L82 72 Z" fill="#f5d020"/>
  <circle cx="100" cy="100" r="34" fill="#f4f4f2"/>
  <circle cx="100" cy="100" r="34" fill="none" stroke="#0a0a0a" stroke-width="4"/>
  <circle cx="100" cy="100" r="12" fill="#c1272d"/>
</svg>`;

// Exported for the failed-load regression test; not used outside this module.
export function applyParsedSVG(
  svgText: string,
  fname: string,
  kind: DesignSource['kind'] = 'upload',
  mode: ArtworkInstance['mode'] = 'sticker',
): void {
  // Parse first: parseSVGDocument throws on a malformed/empty SVG, and a failed load must be a
  // no-op that leaves whatever's already loaded untouched.
  const parsed = parseSVGDocument(svgText);
  loadArtworkSource(parsed, fname, kind, mode, svgText); // adds a new source+instance alongside any already loaded
  pruneSettingsToPalette();
  $('#svg-fname').textContent = fname;
  renderArtworkList();
  refreshFitInputsFromState();
  updateOffsetSliderRanges();
  requestFrame();
  scheduleRebuild();
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
    const mode = state.shapeKind === 'assembly' ? 'fill' : 'sticker';
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
 * entry. Rendered once after the manifest loads (see main.ts) — the strip's membership never
 * changes at runtime, unlike the artwork list below it.
 */
export function renderPatternPicker(): void {
  const strip = $('#pattern-picker');
  const patterns = getPatterns();
  if (!patterns.length) {
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

const RASTER_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff'];

/**
 * The file picker's `accept=".svg,image/svg+xml"` filters raster images out of that path, but
 * drag-drop bypasses `accept` entirely — a dropped PNG/JPG used to reach parseSVGDocument() and
 * fail there with "SVG could not be parsed — check the file is valid XML," which is true but
 * useless: the file isn't malformed XML, it's not XML at all. Checked before FileReader even
 * starts, so the honest message replaces the misleading one instead of following it.
 */
// Exported for the raster-drop regression test; not used outside this module.
export function isRasterImage(file: File): boolean {
  if (file.type.startsWith('image/') && file.type !== 'image/svg+xml') return true;
  const name = file.name.toLowerCase();
  return RASTER_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function reportLoadFailure(fname: string, message: string): void {
  clearWarnings();
  warn(message);
  renderWarnings();
  // Fire-and-forget: this is always a terminal error path (the failed load already stopped),
  // nothing downstream needs to wait for the dialog to close.
  void alertDialog(`Could not load "${fname}": ${message}`);
}

function loadSVGFile(file: File): void {
  if (isRasterImage(file)) {
    reportLoadFailure(
      file.name,
      "that's a raster image (PNG/JPG), not an SVG. TMT Mosaic needs vector artwork — " +
        "download this part's design template (Part panel) if it has one, or convert the file " +
        'to SVG in Inkscape/Illustrator first.',
    );
    return;
  }
  beginWork();
  const reader = new FileReader();
  // onloadend, not the onload path: it also covers a read error or abort, which would otherwise
  // leave the counter above zero forever and hang every later whenIdle(). It runs after onload,
  // so the rebuild applyParsedSVG() schedules has already taken over the count.
  reader.onloadend = () => endWork();
  reader.onload = () => {
    try {
      applyParsedSVG(reader.result as string, file.name);
      track('artwork_load', { source: 'upload' });
    } catch (e) {
      reportLoadFailure(file.name, (e as Error).message);
    }
  };
  reader.readAsText(file);
}

export function initArtworkPanel(): void {
  const dropzone = $('#dropzone');
  dropzone.addEventListener('click', () => input('#svg-input').click());
  input('#svg-input').addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) loadSVGFile(f);
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
    if (f) loadSVGFile(f);
  });

  $('#btn-sample').addEventListener('click', () => {
    applyParsedSVG(SAMPLE_SVG, 'sample-badge.svg');
    track('artwork_load', { source: 'sample' });
  });
}
