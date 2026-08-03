// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { clearWarnings, notice, warn, WARNINGS } from '../src/warnings';
import { renderWarnings } from '../src/ui/warningsView';

// The bug this pins: the panel used to render only WARNINGS.slice(0, 6) and collapse the rest
// into a dead "+ N more warnings" pill with no way to read them (see docs/tech-debt.md, now
// closed). #warnings already scrolls — the fix is rendering every warning and letting it.
describe('renderWarnings', () => {
  beforeEach(() => {
    clearWarnings();
    document.body.innerHTML = '<div id="warnings"></div>';
  });

  it('renders every warning, not just the first 6', () => {
    for (let i = 0; i < 9; i++) warn(`warning ${i}`);
    renderWarnings();

    expect(document.querySelectorAll('.warn-pill')).toHaveLength(9);
    expect(document.body.textContent).not.toMatch(/more warning/i);
  });

  it('gives an info-level notice the info styling, distinct from a warn-level pill', () => {
    warn('something failed');
    notice('fyi');
    renderWarnings();

    const pills = document.querySelectorAll('.warn-pill');
    expect(pills[0].classList.contains('info')).toBe(false);
    expect(pills[1].classList.contains('info')).toBe(true);
  });

  it('shows no "Dismiss all" control with 0 or 1 warnings', () => {
    renderWarnings();
    expect(document.querySelector('.warn-clear-all')).toBeNull();

    warn('only one');
    renderWarnings();
    expect(document.querySelector('.warn-clear-all')).toBeNull();
  });

  it("a pill's own dismiss button removes only that warning, from WARNINGS and the DOM", () => {
    warn('keep me');
    warn('dismiss me');
    renderWarnings();

    document.querySelectorAll<HTMLButtonElement>('.warn-dismiss')[1].click();

    expect(WARNINGS.map((w) => w.message)).toEqual(['keep me']);
    expect(document.querySelectorAll('.warn-pill')).toHaveLength(1);
    expect(document.body.textContent).toContain('keep me');
  });

  it('"Dismiss all" clears every warning, from WARNINGS and the DOM', () => {
    warn('one');
    warn('two');
    warn('three');
    renderWarnings();

    document.querySelector<HTMLButtonElement>('.warn-clear-all')!.click();

    expect(WARNINGS).toHaveLength(0);
    expect(document.querySelectorAll('.warn-pill')).toHaveLength(0);
  });
});
