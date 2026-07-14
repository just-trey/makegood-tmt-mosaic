import { $ } from './dom';

export function showOverlay(text: string): void {
  $('#loading-text').textContent = text;
  $('#loading-overlay').style.display = 'flex';
}

export function hideOverlay(): void {
  $('#loading-overlay').style.display = 'none';
}
