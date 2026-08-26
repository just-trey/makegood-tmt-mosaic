import './styles.css';
import { initViewport, modelNdcExtent } from './scene/viewport';
import { initDesignGizmo } from './scene/designGizmo';
import { initZonePicking, zoneIdAtNdc } from './scene/zonePick';
import { setRebuildCostHint, setRebuildHandler } from './app/scheduler';
import { estimateRebuildSlow, rebuildCurrent } from './app/rebuild';
import { loadFilaments } from './state/filaments';
import { loadPatterns } from './state/patterns';
import { state } from './state/store';
import { loadPartsLibrary } from './assembly/parts';
import { ASSEMBLY_KINDS, firstOfferedKind } from './assembly/kinds';
import { initColorListPanel, renderColorList } from './ui/colorList';
import { initAssemblyPanel } from './ui/assemblyPanel';
import { initPartPanel, renderBaseColorSwatches, setShapeKind } from './ui/partPanel';
import { initFitPanel } from './ui/fitPanel';
import { initDepthPanel } from './ui/depthPanel';
import { initArtworkPanel, renderPatternPicker } from './ui/artworkPanel';
import { initExportPanel } from './ui/exportPanel';
import { initHelpPanel } from './ui/helpPanel';
import { initFeedbackWidget } from './ui/feedbackWidget';
import { initOverlay } from './ui/overlay';
import { initConfirmDialog } from './ui/dialogs';
import { initRestoreBanner } from './ui/restoreBanner';
import { holdSavedSessionUntilAnswered, initBeforeUnloadGuard } from './state/persist';
import { $ } from './ui/dom';
import { getAppVersion } from './version';
import { rebuildsSoFar, whenIdle } from './app/idle';
import { WARNINGS } from './warnings';

// Not DEV-gated: the drive scripts hit vite-preview output (built, not dev), where
// import.meta.env.DEV is false. `warnings` is here rather than read off the DOM because the panel
// renders only the first 6 (warningsView.ts) — a script asserting on warnings has to see all of
// them or it reports "degraded silently" for a build that warned past the cap.
(
  window as unknown as {
    __mosaic: {
      whenIdle: typeof whenIdle;
      rebuildsSoFar: typeof rebuildsSoFar;
      warnings: () => string[];
      modelNdcExtent: typeof modelNdcExtent;
      zoneIdAtNdc: typeof zoneIdAtNdc;
    };
  }
).__mosaic = {
  whenIdle,
  rebuildsSoFar,
  warnings: () => WARNINGS.map((w) => w.message),
  modelNdcExtent,
  zoneIdAtNdc,
};

$('#app-version').textContent =
  `v${getAppVersion(typeof __APP_VERSION__ === 'undefined' ? undefined : __APP_VERSION__)}`;

initViewport($('#canvas-host'));
initDesignGizmo();
// Registered after the gizmo so its pointerdown handler runs first — zonePick relies on that
// ordering to tell a gizmo drag apart from a zone-pick click (see isGizmoDragging).
initZonePicking();
setRebuildHandler(rebuildCurrent);
setRebuildCostHint(estimateRebuildSlow);

initColorListPanel();
initAssemblyPanel();
initPartPanel();
initFitPanel();
initDepthPanel();
initArtworkPanel();
initExportPanel();
initHelpPanel();
initFeedbackWidget();
initOverlay();
initConfirmDialog();
initBeforeUnloadGuard();

renderColorList(null);

// Open on the wheel by default so a part is on screen from the first frame — setShapeKind arms
// the auto-load, and loadPartsLibrary() triggers it once the manifest arrives. A verify/drive
// script can skip straight past that first build with ?kind=<id> (e.g. ?kind=chair-body).
const requestedKindId = new URLSearchParams(location.search).get('kind');
const bootKind = ASSEMBLY_KINDS.find((k) => k.id === requestedKindId) ?? firstOfferedKind();
state.assembly.kindId = bootKind.id;
$<HTMLSelectElement>('#shape-kind').value = 'asm:' + state.assembly.kindId;
setShapeKind('assembly');
void loadPartsLibrary();
// Armed before anything decides whether to offer the session, including the two paths that decide
// not to: a ?kind= link, and a session on a withheld kind. Those used to let the first bare
// rebuild's empty snapshot delete it about a second later, with nothing shown to explain it.
holdSavedSessionUntilAnswered();
// A ?kind= link is an explicit ask for that part — don't offer to override it with a leftover
// session from before.
if (!requestedKindId) initRestoreBanner();
// Filament palette is async; refresh the swatch row once it lands.
void loadFilaments().then(() => renderBaseColorSwatches());
// Pattern library manifest is async; render the picker strip once it lands.
void loadPatterns().then(() => renderPatternPicker());
