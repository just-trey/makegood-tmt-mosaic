import { state } from '../state/store';
import {
  applyRestoredSession,
  clearSavedSession,
  loadSavedSession,
  type PersistedSession,
} from '../state/persist';
import { ASSEMBLY_KINDS } from '../assembly/kinds';
import { setShapeKind, renderBaseColorSwatches, refreshShapeParamInputs } from './partPanel';
import { renderArtworkList } from './artworkListPanel';
import { refreshFitInputsFromState, updateOffsetSliderRanges } from './fitPanel';
import { refreshDepthControls } from './depthPanel';
import { refreshAutoMergeControl } from './colorList';
import { $ } from './dom';
import { track } from '../analytics/track';

function describeAge(savedAt: number): string {
  const mins = Math.round((Date.now() - savedAt) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function describeSession(session: PersistedSession): string {
  const partName =
    session.shapeKind === 'assembly'
      ? (ASSEMBLY_KINDS.find((k) => k.id === session.assembly.kindId)?.name ?? 'that part')
      : 'the Disc';
  const n = session.artworks.length;
  const designPart = n ? `, ${n} design${n === 1 ? '' : 's'}` : '';
  return `Restore your previous session — ${partName}${designPart}, saved ${describeAge(session.savedAt)}?`;
}

/**
 * Offers to bring back a saved session, deliberately as a dismissible in-panel banner rather than
 * a dialog or an automatic restore — the app's default boot (the wheel, per main.ts) still runs
 * either way, so declining costs nothing and a corrupt/failed restore just leaves that default in
 * place. Doesn't touch the DOM beyond the banner itself and one bare `setShapeKind` call, which
 * does the same render/rebuild pass any other part switch triggers.
 */
export function initRestoreBanner(): void {
  const session = loadSavedSession();
  if (!session) return;

  const banner = $('#restore-banner');
  banner.querySelector('p')!.textContent = describeSession(session);
  banner.hidden = false;

  $('#btn-restore-session').addEventListener('click', () => {
    banner.hidden = true;
    void (async () => {
      try {
        await applyRestoredSession(session);
      } catch (e) {
        console.error('Session restore failed:', e);
        clearSavedSession();
        return;
      }
      $<HTMLSelectElement>('#shape-kind').value =
        state.shapeKind === 'assembly' ? 'asm:' + state.assembly.kindId : state.shapeKind;
      setShapeKind(state.shapeKind);
      // Nothing else syncs this select from state — every other path only ever sets
      // state.printerId *from* the dropdown's own change handler (exportPanel.ts), so restore is
      // the first caller that needs the reverse direction too.
      $<HTMLSelectElement>('#p-printer').value = state.printerId;
      refreshShapeParamInputs();
      refreshDepthControls();
      refreshAutoMergeControl();
      renderArtworkList();
      refreshFitInputsFromState();
      updateOffsetSliderRanges();
      renderBaseColorSwatches();
      track('session_restored');
    })();
  });

  $('#btn-restore-dismiss').addEventListener('click', () => {
    banner.hidden = true;
    clearSavedSession();
    track('session_restore_dismissed');
  });
}
