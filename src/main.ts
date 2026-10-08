import './styles.css';
import { initViewport, modelNdcExtent } from './scene/viewport';
import { initDesignGizmo } from './scene/designGizmo';
import { initZonePicking, zonePickAtNdc } from './scene/zonePick';
import { setRebuildCostHint, setRebuildHandler } from './app/scheduler';
import { estimateRebuildSlow, rebuildCurrent } from './app/rebuild';
import { loadFilaments } from './state/filaments';
import { state } from './state/store';
import { loadPartsLibrary } from './assembly/parts';
import { ASSEMBLY_KINDS, firstOfferedKind } from './assembly/kinds';
import { initColorListPanel, renderColorList } from './ui/colorList';
import { initAssemblyPanel } from './ui/assemblyPanel';
import { applyPartKind, initPartPanel, renderBaseColorSwatches } from './ui/partPanel';
import { initFitPanel } from './ui/fitPanel';
import { initDepthPanel } from './ui/depthPanel';
import { initArtworkPanel } from './ui/artworkPanel';
import { initExportPanel, lastPlacementRefreshMs } from './ui/exportPanel';
import { initHelpPanel } from './ui/helpPanel';
import { initFeedbackWidget } from './ui/feedbackWidget';
import { initOverlay } from './ui/overlay';
import { initConfirmDialog } from './ui/dialogs';
import { initRestoreBanner } from './ui/restoreBanner';
import { holdSavedSessionUntilAnswered, initBeforeUnloadGuard } from './state/persist';
import { $ } from './ui/dom';
import { getAppVersion } from './version';
import { rebuildsSoFar, whenIdle } from './app/idle';
import { lastBuildReuse } from './app/buildClient';
import { WARNINGS } from './warnings';
import { WHOLE_CHAIR_ZONE } from './geometry/zones';

// Not DEV-gated: drive scripts hit vite-preview output where import.meta.env.DEV is false. `warnings` is here, not read off the DOM, because the panel renders only the first 6 (warningsView.ts) — a script must see all or it reports "degraded silently" for a build that warned past the cap.
(
  window as unknown as {
    __mosaic: {
      whenIdle: typeof whenIdle;
      rebuildsSoFar: typeof rebuildsSoFar;
      warnings: () => string[];
      modelNdcExtent: typeof modelNdcExtent;
      zonePickAtNdc: typeof zonePickAtNdc;
      // check-zone-occlusion.mjs reads this rather than hardcoding '*whole', so its identity sweep can't drift from the app's id.
      WHOLE_CHAIR_ZONE: typeof WHOLE_CHAIR_ZONE;
      buildReuse: typeof lastBuildReuse;
      placementRefreshMs: typeof lastPlacementRefreshMs;
    };
  }
).__mosaic = {
  whenIdle,
  rebuildsSoFar,
  warnings: () => WARNINGS.map((w) => w.message),
  modelNdcExtent,
  zonePickAtNdc,
  WHOLE_CHAIR_ZONE,
  buildReuse: lastBuildReuse,
  placementRefreshMs: lastPlacementRefreshMs,
};

$('#app-version').textContent =
  `v${getAppVersion(typeof __APP_VERSION__ === 'undefined' ? undefined : __APP_VERSION__)}`;

initViewport($('#canvas-host'));
initDesignGizmo();
// Registered after the gizmo so its pointerdown runs first — zonePick relies on that order to tell a gizmo drag from a zone-pick click (isGizmoDragging).
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

// Open on the wheel so a part is on screen from the first frame — applyPartKind arms the auto-load and loadPartsLibrary() triggers it when the manifest arrives. Drive scripts can skip that first build with ?kind=<id> (e.g. ?kind=chair-body).
const requestedKindId = new URLSearchParams(location.search).get('kind');
const bootKind = ASSEMBLY_KINDS.find((k) => k.id === requestedKindId) ?? firstOfferedKind();
state.assembly.kindId = bootKind.id;
$<HTMLSelectElement>('#shape-kind').value = 'asm:' + state.assembly.kindId;
applyPartKind();
void loadPartsLibrary();
// Armed before anything decides whether to offer the session, including the paths that decide not to (a ?kind= link, a withheld kind), which let the first bare rebuild's empty snapshot delete it about a second later, unexplained.
holdSavedSessionUntilAnswered();
// A ?kind= link is an explicit ask for that part — don't offer to override it with a leftover
// session from before.
if (!requestedKindId) initRestoreBanner();
// Filament palette is async; refresh the swatch row once it lands.
void loadFilaments().then(() => renderBaseColorSwatches());
