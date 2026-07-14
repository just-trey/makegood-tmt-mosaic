import { currentBaseParams, state } from '../state/store';
import { scheduleRebuild } from '../app/scheduler';
import { input } from './dom';

/**
 * Keep a slider/number pair in sync and push the canonical value into state.
 * For clamped pairs (margin/scale) the slider is the source of truth, so a typed number snaps
 * back into the slider's range on blur; for offsets the number is the source of truth and may
 * exceed the slider range (the slider just pegs at its end).
 */
function syncPair(sliderSel: string, numSel: string, clampNum: boolean, apply: (v: number) => void): void {
  const slider = input(sliderSel), num = input(numSel);
  slider.addEventListener('input', () => {
    num.value = slider.value;
    apply(parseFloat(slider.value) || 0);
    scheduleRebuild();
  });
  num.addEventListener('input', () => {
    slider.value = num.value;
    apply(parseFloat(clampNum ? slider.value : num.value) || 0);
    scheduleRebuild();
  });
  if (clampNum) num.addEventListener('change', () => { num.value = slider.value; });
}

/**
 * Offset slider travel is ±half the base footprint: full deflection puts the artwork's center
 * on the base edge. Recomputed whenever the base dimensions or shape change.
 */
export function updateOffsetSliderRanges(): void {
  let w: number, h: number;
  if (state.shapeKind === 'assembly') {
    // assembly artwork maps onto the wheel face: ±radius puts the design center at the rim
    w = h = 2 * (state.asmRadius || 138);
  } else {
    const bp = currentBaseParams();
    if (!bp) return;
    w = state.shapeKind === 'disc' ? (bp.diameter || 0) : (bp.width || 0);
    h = state.shapeKind === 'disc' ? (bp.diameter || 0) : (bp.height || 0);
  }
  const setRange = (sel: string, half: number) => {
    if (!(half > 0)) return;
    const el = input(sel);
    const lim = Math.max(0.5, Math.round(half * 2) / 2);
    el.min = String(-lim); el.max = String(lim);
  };
  setRange('#p-offset-x-slider', w / 2);
  setRange('#p-offset-y-slider', h / 2);
  // re-sync thumbs after the range change (pegs if the typed value is out of range)
  input('#p-offset-x-slider').value = String(state.offsetX || 0);
  input('#p-offset-y-slider').value = String(state.offsetY || 0);
}

export function initFitPanel(): void {
  syncPair('#p-margin', '#p-margin-num', true, v => { state.marginPct = v; });
  syncPair('#p-scale', '#p-scale-num', true, v => { state.scalePct = v; });
  syncPair('#p-offset-x-slider', '#p-offset-x', false, v => { state.offsetX = v; });
  syncPair('#p-offset-y-slider', '#p-offset-y', false, v => { state.offsetY = v; });

  input('#btn-reset-fit').addEventListener('click', () => {
    state.scalePct = 100; state.offsetX = 0; state.offsetY = 0;
    input('#p-scale').value = '100'; input('#p-scale-num').value = '100';
    input('#p-offset-x').value = '0'; input('#p-offset-y').value = '0';
    input('#p-offset-x-slider').value = '0'; input('#p-offset-y-slider').value = '0';
    scheduleRebuild();
  });

  updateOffsetSliderRanges();
}
