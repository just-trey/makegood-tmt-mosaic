import { state } from '../state/store';
import { scheduleRebuild } from '../app/scheduler';
import { requestFrame } from '../scene/viewport';
import { parseSVGDocument } from '../svg/parse';
import { clearWarnings, warn } from '../warnings';
import { renderWarnings } from './warningsView';
import { $, input } from './dom';

const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <circle cx="100" cy="100" r="95" fill="#1e5fa8"/>
  <path d="M100 20 L118 72 L174 72 L128 104 L146 158 L100 124 L54 158 L72 104 L26 72 L82 72 Z" fill="#f5d020"/>
  <circle cx="100" cy="100" r="34" fill="#f4f4f2"/>
  <circle cx="100" cy="100" r="34" fill="none" stroke="#0a0a0a" stroke-width="4"/>
  <circle cx="100" cy="100" r="12" fill="#c1272d"/>
</svg>`;

function applyParsedSVG(svgText: string, fname: string): void {
  state.parsed = parseSVGDocument(svgText);
  state.colorSettings = {};
  state.mergeGroups = [];
  state.selectedForMerge.clear();
  $('#svg-fname').textContent = fname;
  requestFrame();
  scheduleRebuild();
}

function loadSVGFile(file: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      applyParsedSVG(reader.result as string, file.name);
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
  input('#svg-input').addEventListener('change', e => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) loadSVGFile(f);
  });
  ['dragover', 'dragenter'].forEach(ev => dropzone.addEventListener(ev, e => {
    e.preventDefault();
    dropzone.classList.add('drag');
  }));
  ['dragleave', 'drop'].forEach(ev => dropzone.addEventListener(ev, e => {
    e.preventDefault();
    dropzone.classList.remove('drag');
  }));
  dropzone.addEventListener('drop', e => {
    const f = (e as DragEvent).dataTransfer?.files[0];
    if (f) loadSVGFile(f);
  });

  $('#btn-sample').addEventListener('click', () => {
    applyParsedSVG(SAMPLE_SVG, 'sample-badge.svg');
  });
}
