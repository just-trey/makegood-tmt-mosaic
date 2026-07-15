import { state } from '../state/store';
import { scheduleRebuild } from '../app/scheduler';
import { $, input, numVal } from './dom';

export function initDepthPanel(): void {
  input('#p-depth').addEventListener('input', () => {
    state.globalDepth = numVal('#p-depth', 1.0);
    scheduleRebuild('typed');
  });
  input('#p-recess-bg').addEventListener('change', () => {
    state.recessBg = input('#p-recess-bg').checked;
    $('#bg-depth-hint').style.display = state.recessBg ? 'inline' : 'none';
    scheduleRebuild();
  });
}
