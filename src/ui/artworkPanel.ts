import type { ArtworkInstance, DesignSource } from '../types';
import { loadArtworkSource, pruneSettingsToPalette } from '../state/artwork';
import { getPatterns } from '../state/patterns';
import { state } from '../state/store';
import { scheduleRebuild } from '../app/scheduler';
import { requestFrame } from '../scene/viewport';
import { parseSVGDocument } from '../svg/parse';
import { clearWarnings, warn } from '../warnings';
import { renderWarnings } from './warningsView';
import { renderArtworkList } from './artworkListPanel';
import { refreshFitInputsFromState, updateOffsetSliderRanges } from './fitPanel';
import { $, input } from './dom';
import { track } from '../analytics/track';

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
  loadArtworkSource(parsed, fname, kind, mode); // adds a new source+instance alongside any already loaded
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
    alert('Could not load pattern: ' + (e as Error).message);
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
    const img = document.createElement('img');
    img.src = `patterns/${p.file}`;
    img.alt = p.name;
    btn.appendChild(img);
    btn.addEventListener('click', () => void applyPattern(p.id));
    strip.appendChild(btn);
  });
}

function loadSVGFile(file: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      applyParsedSVG(reader.result as string, file.name);
      track('artwork_load', { source: 'upload' });
    } catch (e) {
      clearWarnings();
      warn((e as Error).message);
      renderWarnings();
      alert('Could not load SVG: ' + (e as Error).message);
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
