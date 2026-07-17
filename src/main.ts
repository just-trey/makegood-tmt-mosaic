import './styles.css';
import { initViewport } from './scene/viewport';
import { setRebuildCostHint, setRebuildHandler } from './app/scheduler';
import { estimateRebuildSlow, rebuildCurrent } from './app/rebuild';
import { loadFilaments } from './state/filaments';
import { loadPartsLibrary } from './assembly/parts';
import { initColorListPanel, renderColorList } from './ui/colorList';
import { initAssemblyPanel } from './ui/assemblyPanel';
import { initPartPanel, renderBaseColorSwatches, setShapeKind } from './ui/partPanel';
import { initFitPanel } from './ui/fitPanel';
import { initDepthPanel } from './ui/depthPanel';
import { initArtworkPanel } from './ui/artworkPanel';
import { initExportPanel } from './ui/exportPanel';
import { initHelpPanel } from './ui/helpPanel';
import { $ } from './ui/dom';
import { getAppVersion } from './version';

$('#app-version').textContent =
  `v${getAppVersion(typeof __APP_VERSION__ === 'undefined' ? undefined : __APP_VERSION__)}`;

initViewport($('#canvas-host'));
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

// Open in Assembly mode so the wheel is on screen from the first frame — setShapeKind arms the
// auto-load, and loadPartsLibrary() triggers it once the manifest arrives.
$<HTMLSelectElement>('#shape-kind').value = 'assembly';
setShapeKind('assembly');
void loadPartsLibrary();
// Filament palette is async; refresh the swatch row once it lands.
void loadFilaments().then(() => renderBaseColorSwatches());
