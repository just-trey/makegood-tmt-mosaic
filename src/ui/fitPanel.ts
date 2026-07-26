import { currentBaseParams, state } from '../state/store';
import { isRebuildLikelySlow, scheduleRebuild } from '../app/scheduler';
import { currentAssemblyKind } from '../assembly/kinds';
import { refreshGizmo } from '../scene/designGizmo';
import { track } from '../analytics/track';
import { input } from './dom';

type FitField = 'move' | 'scale' | 'rotate';

/**
 * Keep a slider/number pair in sync and push the canonical value into state.
 * For clamped pairs (margin/scale) the slider is the source of truth, so a typed number snaps
 * back into the slider's range on blur; for offsets the number is the source of truth and may
 * exceed the slider range (the slider just pegs at its end).
 * `field` is omitted for pairs that aren't part of the move/scale/rotate gizmo model (margin).
 */
function syncPair(
  sliderSel: string,
  numSel: string,
  clampNum: boolean,
  apply: (v: number) => void,
  field?: FitField,
): void {
  const slider = input(sliderSel),
    num = input(numSel);
  slider.addEventListener('input', () => {
    num.value = slider.value;
    apply(parseFloat(slider.value) || 0);
    // On a heavy model rebuilds are slow — stay smooth during the drag and rebuild once
    // on release (below) instead of flooding slow redraws.
    if (!isRebuildLikelySlow()) scheduleRebuild();
  });
  slider.addEventListener('change', () => {
    scheduleRebuild();
    if (field) track('fit_adjust', { via: 'slider', field });
  });
  num.addEventListener('input', () => {
    slider.value = num.value;
    apply(parseFloat(clampNum ? slider.value : num.value) || 0);
    scheduleRebuild('typed');
  });
  if (clampNum)
    num.addEventListener('change', () => {
      num.value = slider.value;
    });
}

/**
 * Offset slider travel is ±half the base footprint: full deflection puts the artwork's center
 * on the base edge. Recomputed whenever the base dimensions or shape change.
 */
export function updateOffsetSliderRanges(): void {
  // Margin only feeds flat.ts's auto-fit sizing; assembly mode (wheel and rect alike) maps the
  // design straight onto the part face and never reads marginPct, so the control is a no-op there.
  const isAssembly = state.shapeKind === 'assembly';
  const marginRow = document.getElementById('p-margin-row');
  if (marginRow) marginRow.style.display = isAssembly ? 'none' : '';
  const fitHint = document.getElementById('p-fit-hint');
  if (fitHint)
    fitHint.textContent = isAssembly
      ? 'Scale multiplies the design (over 100% bleeds past the part face). Flip H mirrors the artwork left-to-right (fixes text that reads backwards).'
      : 'Margin sets the auto-fit border; Scale multiplies on top (over 100% bleeds past the edge). Flip H mirrors the artwork left-to-right (fixes text that reads backwards).';

  let w: number, h: number;
  if (state.shapeKind === 'assembly') {
    if (currentAssemblyKind()?.designFit === 'rect') {
      // rect parts have no radius; give the offset sliders a fixed nudge range around the face
      w = h = 300;
    } else {
      // assembly artwork maps onto the wheel face: ±radius puts the design center at the rim
      w = h = 2 * (state.asmRadius || 138);
    }
  } else {
    const bp = currentBaseParams();
    if (!bp) return;
    w = state.shapeKind === 'disc' ? bp.diameter || 0 : bp.width || 0;
    h = state.shapeKind === 'disc' ? bp.diameter || 0 : bp.height || 0;
  }
  const setRange = (sel: string, half: number) => {
    if (!(half > 0)) return;
    const el = input(sel);
    const lim = Math.max(0.5, Math.round(half * 2) / 2);
    el.min = String(-lim);
    el.max = String(lim);
  };
  setRange('#p-offset-x-slider', w / 2);
  setRange('#p-offset-y-slider', h / 2);
  // re-sync thumbs after the range change (pegs if the typed value is out of range)
  input('#p-offset-x-slider').value = String(state.offsetX || 0);
  input('#p-offset-y-slider').value = String(state.offsetY || 0);
  // Face/part/shape just changed — the gizmo's frame must track the new face immediately,
  // not wait for the next debounced rebuild.
  refreshGizmo();
}

export function initFitPanel(): void {
  syncPair('#p-margin', '#p-margin-num', true, (v) => {
    state.marginPct = v;
  });
  syncPair(
    '#p-scale',
    '#p-scale-num',
    true,
    (v) => {
      state.scalePct = v;
    },
    'scale',
  );
  syncPair(
    '#p-offset-x-slider',
    '#p-offset-x',
    false,
    (v) => {
      state.offsetX = v;
    },
    'move',
  );
  syncPair(
    '#p-offset-y-slider',
    '#p-offset-y',
    false,
    (v) => {
      state.offsetY = v;
    },
    'move',
  );
  syncPair(
    '#p-rot',
    '#p-rot-num',
    true,
    (v) => {
      state.rotationDeg = v;
    },
    'rotate',
  );

  const flipX = input('#p-flip-x'),
    flipY = input('#p-flip-y');
  flipX.addEventListener('change', () => {
    state.flipX = flipX.checked;
    scheduleRebuild();
  });
  flipY.addEventListener('change', () => {
    state.flipY = flipY.checked;
    scheduleRebuild();
  });

  input('#btn-reset-fit').addEventListener('click', () => {
    state.scalePct = 100;
    state.offsetX = 0;
    state.offsetY = 0;
    state.rotationDeg = 0;
    state.flipX = false;
    state.flipY = false;
    input('#p-scale').value = '100';
    input('#p-scale-num').value = '100';
    input('#p-offset-x').value = '0';
    input('#p-offset-y').value = '0';
    input('#p-offset-x-slider').value = '0';
    input('#p-offset-y-slider').value = '0';
    input('#p-rot').value = '0';
    input('#p-rot-num').value = '0';
    flipX.checked = false;
    flipY.checked = false;
    scheduleRebuild();
  });

  updateOffsetSliderRanges();
}
