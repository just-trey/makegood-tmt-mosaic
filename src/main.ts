import './styles.css';
import { initViewport } from './scene/viewport';
import { initDesignGizmo } from './scene/designGizmo';
import { initZonePicking } from './scene/zonePick';
import { setRebuildCostHint, setRebuildHandler } from './app/scheduler';
import { estimateRebuildSlow, rebuildCurrent } from './app/rebuild';
import { loadFilaments } from './state/filaments';
import { loadPatterns } from './state/patterns';
import { state } from './state/store';
import { loadPartsLibrary } from './assembly/parts';
import { ASSEMBLY_KINDS } from './assembly/kinds';
import { initColorListPanel, renderColorList } from './ui/colorList';
import { initAssemblyPanel } from './ui/assemblyPanel';
import { initPartPanel, renderBaseColorSwatches, setShapeKind } from './ui/partPanel';
import { initFitPanel } from './ui/fitPanel';
import { initDepthPanel } from './ui/depthPanel';
import { initArtworkPanel, renderPatternPicker } from './ui/artworkPanel';
import { initExportPanel } from './ui/exportPanel';
import { initHelpPanel } from './ui/helpPanel';
import { $ } from './ui/dom';
import { getAppVersion } from './version';
import { whenIdle } from './app/idle';

// Not DEV-gated: the drive scripts hit vite-preview output (built, not dev), where
// import.meta.env.DEV is false.
(window as unknown as { __mosaic: { whenIdle: typeof whenIdle } }).__mosaic = { whenIdle };

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

renderColorList(null);

// Open on the wheel by default so a part is on screen from the first frame — setShapeKind arms
// the auto-load, and loadPartsLibrary() triggers it once the manifest arrives. A verify/drive
// script can skip straight past that first build with ?kind=<id> (e.g. ?kind=chair-body).
const requestedKindId = new URLSearchParams(location.search).get('kind');
const bootKind = ASSEMBLY_KINDS.find((k) => k.id === requestedKindId) ?? ASSEMBLY_KINDS[0];
state.assembly.kindId = bootKind.id;
$<HTMLSelectElement>('#shape-kind').value = 'asm:' + state.assembly.kindId;
setShapeKind('assembly');
void loadPartsLibrary();
// Filament palette is async; refresh the swatch row once it lands.
void loadFilaments().then(() => renderBaseColorSwatches());
// Pattern library manifest is async; render the picker strip once it lands.
void loadPatterns().then(() => renderPatternPicker());
