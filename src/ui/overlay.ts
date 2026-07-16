import { $ } from './dom';

export function showOverlay(text: string): void {
  $('#loading-text').textContent = text;
  $('#loading-overlay').style.display = 'flex';
}

/** Update the curtain text in place (e.g. live progress) without toggling visibility. */
export function updateOverlay(text: string): void {
  $('#loading-text').textContent = text;
}

export function hideOverlay(): void {
  $('#loading-overlay').style.display = 'none';
}
