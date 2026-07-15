import './styles.css';
import { initViewport } from './scene/viewport';
import { setRebuildHandler } from './app/scheduler';
import { rebuildCurrent } from './app/rebuild';
import { loadFilaments } from './state/filaments';
import { loadPartsLibrary } from './assembly/parts';
import { initColorListPanel, renderColorList } from './ui/colorList';
import { initAssemblyPanel } from './ui/assemblyPanel';
import { initPartPanel, renderBaseColorSwatches, setShapeKind } from './ui/partPanel';
import { initFitPanel } from './ui/fitPanel';
import { initDepthPanel } from './ui/depthPanel';
import { initArtworkPanel } from './ui/artworkPanel';
import { initExportPanel } from './ui/exportPanel';
import { $ } from './ui/dom';

$('#app-version').textContent = `v${__APP_VERSION__}`;

initViewport($('#canvas-host'));
setRebuildHandler(rebuildCurrent);

initColorListPanel();
initAssemblyPanel();
initPartPanel();
initFitPanel();
initDepthPanel();
initArtworkPanel();
initExportPanel();

renderColorList(null);

// Open in Assembly mode so the wheel is on screen from the first frame — setShapeKind arms the
// auto-load, and loadPartsLibrary() triggers it once the manifest arrives.
$<HTMLSelectElement>('#shape-kind').value = 'assembly';
setShapeKind('assembly');
void loadPartsLibrary();
// Filament palette is async; refresh the swatch row once it lands.
void loadFilaments().then(renderBaseColorSwatches);
