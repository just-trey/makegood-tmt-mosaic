import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import type { ShapeKind } from '../types';
import { DEFAULT_BASE_COLOR, state } from '../state/store';
import { getFilaments } from '../state/filaments';
import { scheduleRebuild } from '../app/scheduler';
import { requestFrame } from '../scene/viewport';
import { ASSEMBLY_KINDS } from '../assembly/kinds';
import { maybeAutoLoadAssembly } from '../assembly/parts';
import {
  renderAssemblyKindSelect,
  renderAssemblyPartList,
  renderAssemblyRoleControls,
} from './assemblyPanel';
import { updateOffsetSliderRanges } from './fitPanel';
import { $, input, numVal } from './dom';

// Tiny SVG thumbnails shown next to the shape dropdown.
const SHAPE_THUMBS: Record<string, string> = {
  disc: '<svg viewBox="0 0 32 32"><circle class="fill" cx="16" cy="16" r="12"/></svg>',
  rect: '<svg viewBox="0 0 32 32"><rect class="fill" x="4" y="8" width="24" height="16" rx="1"/></svg>',
  round:
    '<svg viewBox="0 0 32 32"><rect class="fill" x="4" y="8" width="24" height="16" rx="5"/></svg>',
  assembly:
    '<svg viewBox="0 0 32 32"><circle class="fill" cx="16" cy="16" r="12"/><circle class="line" cx="16" cy="16" r="4.5"/><line class="line" x1="16" y1="4" x2="16" y2="9"/><line class="line" x1="16" y1="23" x2="16" y2="28"/><line class="line" x1="4" y1="16" x2="9" y2="16"/><line class="line" x1="23" y1="16" x2="28" y2="16"/></svg>',
  stl: '<svg viewBox="0 0 32 32"><path class="line" d="M16 4 L28 11 L28 21 L16 28 L4 21 L4 11 Z"/><path class="line" d="M4 11 L16 18 L28 11 M16 18 L16 28"/></svg>',
};

function setShapeThumb(kind: string): void {
  const el = $('#shape-thumb');
  if (el) el.innerHTML = SHAPE_THUMBS[kind] || '';
}

export function setShapeKind(kind: ShapeKind): void {
  state.shapeKind = kind;
  (['disc', 'rect', 'round', 'stl', 'assembly'] as const).forEach((k) => {
    const el = $('#shape-params-' + k);
    if (el) el.style.display = k === kind ? 'block' : 'none';
  });
  if (kind === 'assembly') {
    if (!state.assembly.kindId) state.assembly.kindId = ASSEMBLY_KINDS[0].id;
    renderAssemblyKindSelect();
    renderAssemblyRoleControls();
    renderAssemblyPartList();
    maybeAutoLoadAssembly(); // just load the wheel — no separate "Load full …" click needed
  }
  $('#btn-export-stl').style.display = kind === 'assembly' ? 'none' : 'block';
  $('#export-hint').innerHTML =
    kind === 'assembly'
      ? 'Exports a Bambu Studio project 3MF: parts spread across build plates, recesses pre-assigned to filament slots.'
      : '3MF is print-ready for Bambu Studio with colors pre-assigned to filament slots; the STL set is the fallback for other slicers.';
  setShapeThumb(kind);
  updateOffsetSliderRanges();
  requestFrame();
  scheduleRebuild();
}

/** Base-color picker: neutral default plus one swatch per owned filament. */
export function renderBaseColorSwatches(): void {
  const box = $('#base-color-swatches');
  if (!box) return;
  box.innerHTML = '';
  const mk = (id: string | null, hex: string, title: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'base-swatch' + (state.baseFilamentId === id ? ' selected' : '');
    b.style.background = hex;
    b.title = title;
    b.addEventListener('click', () => {
      state.baseFilamentId = id;
      renderBaseColorSwatches();
      scheduleRebuild();
    });
    return b;
  };
  box.appendChild(mk(null, DEFAULT_BASE_COLOR, 'Default (neutral grey)'));
  getFilaments().forEach((f) => box.appendChild(mk(f.id, f.hex, f.name)));
}

function bindShapeInput(sel: string, apply: (v: number) => void): void {
  input(sel).addEventListener('input', () => {
    apply(numVal(sel));
    updateOffsetSliderRanges();
    scheduleRebuild();
  });
}

function loadSTLReference(file: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    const geo = new STLLoader().parse(reader.result as ArrayBuffer);
    geo.computeBoundingBox();
    const bb = geo.boundingBox!;
    const mat = new THREE.MeshStandardMaterial({
      color: 0x3a4650,
      transparent: true,
      opacity: 0.35,
      roughness: 0.9,
    });
    state.stlRefMesh = new THREE.Mesh(geo, mat);
    $('#stl-fname').textContent = file.name;
    input('#p-facez').value = bb.max.z.toFixed(2);
    input('#p-width-stl').value = (bb.max.x - bb.min.x).toFixed(1);
    input('#p-height-stl').value = (bb.max.y - bb.min.y).toFixed(1);
    state.stlPlate.faceZ = +bb.max.z.toFixed(2);
    state.stlPlate.width = +(bb.max.x - bb.min.x).toFixed(1);
    state.stlPlate.height = +(bb.max.y - bb.min.y).toFixed(1);
    scheduleRebuild();
  };
  reader.readAsArrayBuffer(file);
}

export function initPartPanel(): void {
  $<HTMLSelectElement>('#shape-kind').addEventListener('change', (e) => {
    setShapeKind((e.target as HTMLSelectElement).value as ShapeKind);
  });
  setShapeThumb(state.shapeKind); // reflect the initial selection

  // disc
  bindShapeInput('#p-diameter', (v) => {
    state.disc.diameter = v;
  });
  bindShapeInput('#p-thickness', (v) => {
    state.disc.thickness = v;
  });
  // rect
  bindShapeInput('#p-width', (v) => {
    state.rect.width = v;
  });
  bindShapeInput('#p-height', (v) => {
    state.rect.height = v;
  });
  bindShapeInput('#p-thickness-r', (v) => {
    state.rect.thickness = v;
  });
  // rounded rect
  bindShapeInput('#p-width-rr', (v) => {
    state.round.width = v;
  });
  bindShapeInput('#p-height-rr', (v) => {
    state.round.height = v;
  });
  bindShapeInput('#p-corner', (v) => {
    state.round.corner = v;
  });
  bindShapeInput('#p-thickness-rr', (v) => {
    state.round.thickness = v;
  });
  // stl reference plate
  bindShapeInput('#p-width-stl', (v) => {
    state.stlPlate.width = v;
  });
  bindShapeInput('#p-height-stl', (v) => {
    state.stlPlate.height = v;
  });
  bindShapeInput('#p-thickness-stl', (v) => {
    state.stlPlate.thickness = v;
  });
  bindShapeInput('#p-facez', (v) => {
    state.stlPlate.faceZ = v;
  });
  // assembly design radius
  input('#p-asm-radius').addEventListener('input', () => {
    state.asmRadius = numVal('#p-asm-radius', 138);
    updateOffsetSliderRanges();
    scheduleRebuild();
  });

  // STL reference upload
  const stlDrop = $('#stl-dropzone');
  stlDrop.addEventListener('click', () => input('#stl-input').click());
  input('#stl-input').addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) loadSTLReference(f);
  });
  $('#btn-autoz').addEventListener('click', () => {
    if (state.stlRefMesh) {
      state.stlRefMesh.geometry.computeBoundingBox();
      const z = state.stlRefMesh.geometry.boundingBox!.max.z;
      input('#p-facez').value = z.toFixed(2);
      state.stlPlate.faceZ = +z.toFixed(2);
      scheduleRebuild();
    }
  });

  renderBaseColorSwatches();
}
