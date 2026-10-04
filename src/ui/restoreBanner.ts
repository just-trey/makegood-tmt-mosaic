import { state } from '../state/store';
import {
  applyRestoredSession,
  clearSavedSession,
  disableSessionWritesAfterFailedRestore,
  SESSION_WRITES_DISABLED_MSG,
  loadSavedSession,
  markSavedSessionAnswered,
  SessionPartsError,
  keepSessionForRetry,
  type PersistedSession,
} from '../state/persist';
import { clearWarnings, warn } from '../warnings';
import { renderWarnings } from './warningsView';
import { ASSEMBLY_KINDS, firstOfferedKind } from '../assembly/kinds';
import { applyPartKind, renderBaseColorSwatches, refreshShapeParamInputs } from './partPanel';
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
  // Name the part the restore will land on, not the one saved on: a retired kind or a session saved in a retired flat mode falls back to the first offered kind (state/persist.ts); the banner used to promise "the Disc", a part not in the dropdown.
  const saved =
    session.shapeKind === 'assembly'
      ? ASSEMBLY_KINDS.find((k) => k.id === session.assembly.kindId)
      : undefined;
  const partName = (saved ?? firstOfferedKind()).name;
  const n = session.artworks.length;
  const designPart = n ? `, ${n} design${n === 1 ? '' : 's'}` : '';
  return `Restore your previous session: ${partName}${designPart}, saved ${describeAge(session.savedAt)}?`;
}

/**
 * Offers to bring back a saved session as a dismissible in-panel banner, not a dialog or automatic
 * restore: the default boot (the wheel, main.ts) runs either way, so declining costs nothing and a
 * failed restore leaves that default. Touches no DOM beyond the banner and one bare `applyPartKind`,
 * which does the render/rebuild pass any part switch triggers.
 */
export function initRestoreBanner(): void {
  const session = loadSavedSession();
  if (!session) return;
  // A session on a part since withdrawn from the dropdown isn't offered: restoring would drop someone into a part they can't re-select. Left in storage, not cleared, so unhiding the kind brings it back.
  if (session.shapeKind === 'assembly') {
    const kind = ASSEMBLY_KINDS.find((k) => k.id === session.assembly.kindId);
    if (kind?.hidden) return;
  }

  const banner = $('#restore-banner');
  banner.querySelector('p')!.textContent = describeSession(session);
  banner.hidden = false;

  $('#btn-restore-session').addEventListener('click', () => {
    banner.hidden = true;
    // The offer is answered, so saveSession()'s empty-snapshot clear may resume. Until here the session is held: a reload with the banner unanswered used to destroy it a second into the boot still offering it.
    markSavedSessionAnswered();
    void (async () => {
      try {
        await applyRestoredSession(session);
      } catch (e) {
        console.error('Session restore failed:', e);
        if (e instanceof SessionPartsError) {
          // Rolled back, so the screen shows the part from before the click. The session goes back into storage and writes stay off, so the reload the message asks for offers it again. Re-rendered because the aborted load drew the saved part's controls.
          clearWarnings();
          warn(e.message);
          keepSessionForRetry(session, e.message);
          applyPartKind();
          renderWarnings();
          return;
        }
        // Say so, and render it. This used to delete the session and return with nothing on screen:
        // the user clicked Restore, saw no change, and had lost the work. warn() only pushes; this
        // path returns before applyPartKind(), the only call that would reach renderWarnings().
        //
        // "Reload the page" isn't boilerplate: any other throw can land after the parts loaded but
        // before the artwork list was applied, so memory isn't trusted.
        //
        // Cleared first: applyRestoredSessionInner's source loop can warn about a source (a raster
        // that failed to decode) before the one that threw, and `state` was never committed, so that
        // warning would describe a source that's part of nothing on screen.
        clearWarnings();
        warn(SESSION_WRITES_DISABLED_MSG);
        renderWarnings();
        clearSavedSession();
        // And keep it cleared: the next debounced save would write the half-applied state back, and the next visit would offer a session built from the failed restore.
        disableSessionWritesAfterFailedRestore();
        return;
      }
      $<HTMLSelectElement>('#shape-kind').value = 'asm:' + state.assembly.kindId;
      applyPartKind();
      // Nothing else syncs this select from state: every other path sets state.printerId *from* the dropdown's change handler (exportPanel.ts), so restore is the first needing the reverse.
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
    markSavedSessionAnswered();
    clearSavedSession();
    track('session_restore_dismissed');
  });
}
