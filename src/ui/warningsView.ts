import { WARNINGS } from '../warnings';
import { $ } from './dom';

/**
 * Renders every current warning, not just the first 6 — the panel capped at 6 pills and collapsed
 * the rest into a dead "+ N more warnings" label (docs/tech-debt.md). #warnings already scrolls
 * (max-height + overflow-y:auto in styles.css), so the fix is to stop truncating.
 * window.__mosaic.warnings() (main.ts) reads WARNINGS directly, not this DOM.
 */
export function renderWarnings(): void {
  const box = $('#warnings');
  box.innerHTML = '';
  if (WARNINGS.length > 1) {
    const clearAll = document.createElement('button');
    clearAll.type = 'button';
    clearAll.className = 'warn-clear-all';
    clearAll.textContent = `Dismiss all (${WARNINGS.length})`;
    clearAll.addEventListener('click', () => {
      WARNINGS.length = 0;
      renderWarnings();
    });
    box.appendChild(clearAll);
  }
  WARNINGS.forEach((w) => {
    const pill = document.createElement('div');
    pill.className = w.level === 'info' ? 'warn-pill info' : 'warn-pill';
    const text = document.createElement('span');
    text.className = 'warn-text';
    text.textContent = (w.level === 'info' ? 'ℹ ' : '⚠ ') + w.message;
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'warn-dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss this warning');
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => {
      const idx = WARNINGS.indexOf(w);
      if (idx !== -1) WARNINGS.splice(idx, 1);
      renderWarnings();
    });
    pill.appendChild(text);
    pill.appendChild(dismiss);
    box.appendChild(pill);
  });
}
