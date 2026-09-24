// @vitest-environment jsdom
//
// docs/tech-debt.md's "Numeric coercion has no lint rule" section named this as a latent bug:
// bindShapeInput() read a numeric floor from the input's authored `min=` attribute with a bare
// parseFloat. A non-numeric `min=` parses to NaN, and `v >= NaN` is false for every v, so the
// guard rejected every value typed into the field, not just invalid ones.
//
// The one live caller (asmRadius, in initPartPanel) always sets a valid numeric `min` right
// before binding, so this can't be reached through the app today — but bindShapeInput is written
// to bind "every numeric dimension" a future kind might add, so it's exercised directly here
// rather than left as an unreachable, untested branch.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/app/scheduler', () => ({ scheduleRebuild: vi.fn() }));
vi.mock('../src/scene/viewport', () => ({ requestFrame: vi.fn() }));
vi.mock('../src/ui/fitPanel', () => ({ updateOffsetSliderRanges: vi.fn() }));

import { bindShapeInput } from '../src/ui/partPanel';

beforeEach(() => {
  document.body.innerHTML = `<input id="p-test-field" value="80" min="not-a-number" />`;
});

describe('a field bound with a non-numeric min= attribute', () => {
  it('still accepts a valid typed value', () => {
    const applied: number[] = [];
    bindShapeInput('#p-test-field', (v) => applied.push(v));

    const field = document.querySelector<HTMLInputElement>('#p-test-field')!;
    field.value = '95';
    field.dispatchEvent(new Event('input'));

    expect(field.classList.contains('invalid')).toBe(false);
    expect(applied).toEqual([95]);
  });
});
