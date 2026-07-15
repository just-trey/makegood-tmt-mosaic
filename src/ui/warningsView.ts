import { WARNINGS } from '../warnings';
import { $ } from './dom';

export function renderWarnings(): void {
  const box = $('#warnings');
  box.innerHTML = '';
  WARNINGS.slice(0, 6).forEach((w) => {
    const d = document.createElement('div');
    d.className = w.level === 'info' ? 'warn-pill info' : 'warn-pill';
    d.textContent = (w.level === 'info' ? 'ℹ ' : '⚠ ') + w.message;
    box.appendChild(d);
  });
  if (WARNINGS.length > 6) {
    const d = document.createElement('div');
    d.className = 'warn-pill';
    d.textContent = `+ ${WARNINGS.length - 6} more warning${WARNINGS.length - 6 === 1 ? '' : 's'}`;
    box.appendChild(d);
  }
}
