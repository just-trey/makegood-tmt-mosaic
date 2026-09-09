import './styles.css';
import { Builder, toPlaced, type BuildResult, type Filament } from './app/build';
import { surfaceMap } from './app/parts';
import { clearSession, loadSession, saveSession } from './app/persist';
import { getSource } from './app/sources';
import { Store, type AppState } from './app/state';
import { placedRegions, type PlacedDesign } from './design/placement';
import { pieceAt, templateSvg } from './export/template';
import { printerById } from './export/printers';
import { write3mf } from './export/threemf-write';
import { engine } from './geometry/csg';
import { toLocalMesh } from './geometry/frame';
import { HeightSampler } from './geometry/raycast';
import { kindDef } from './parts/catalog';
import { download, h } from './ui/dom';
import { helpContent } from './ui/help';
import { Panels } from './ui/panels';
import { Viewport, type OverlayDesign } from './ui/viewport';

const statusEl = document.getElementById('status') as HTMLElement;
const statusText = statusEl.querySelector('.status-text') as HTMLElement;
const statusFill = statusEl.querySelector('.status-fill') as HTMLElement;

function setStatus(message: string, progress: number, busy: boolean): void {
  statusText.textContent = message;
  statusFill.style.width = `${Math.round(progress * 100)}%`;
  statusEl.classList.toggle('busy', busy);
}

async function main(): Promise<void> {
  setStatus('Loading the cutting engine', 0.1, true);
  const wasm = await engine();
  const store = new Store();
  const builder = new Builder(store, wasm);
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}filaments.json`);
    if (res.ok) builder.filaments = (await res.json()) as Filament[];
  } catch {
    /* names fall back to hex */
  }
  const viewport = new Viewport(document.getElementById('gl') as HTMLCanvasElement);
  const hint = document.getElementById('viewport-hint') as HTMLElement;
  let latest: BuildResult | null = null;
  let samplers = new Map<string, HeightSampler>();
  let saveFailed = false;

  const surfaceHeight = (surfaceId: string) => {
    const s = latest?.loaded.surfaces.find((x) => x.def.id === surfaceId);
    if (!s || !latest) return () => null as number | null;
    const list = s.def.pieces.map((id) => samplers.get(surfaceId + ':' + id)).filter((x): x is HeightSampler => !!x);
    return (u: number, v: number): number | null => {
      let best: number | null = null;
      for (const smp of list) {
        const z = smp.top(u, v);
        if (z !== null && (best === null || z > best)) best = z;
      }
      return best;
    };
  };

  const aimAtSurface = () => {
    if (!latest) return;
    const s = latest.loaded.surfaces.find((x) => x.def.id === store.state.surfaceId) ?? latest.loaded.surfaces[0];
    if (!s) return;
    viewport.setSurface(`${latest.loaded.def.kind}:${s.def.id}`, s.frame, s.bounds, surfaceHeight(s.def.id));
  };

  const refreshOverlay = async () => {
    if (!latest) return;
    const state = store.state;
    const activeId = state.activeDesignId ?? state.designs[0]?.id;
    const surface = latest.loaded.surfaces.find((x) => x.def.id === state.surfaceId);
    const designs: OverlayDesign[] = [];
    const map = surfaceMap(latest.loaded, state.surfaceId, 2);
    for (const d of state.designs) {
      if (d.surfaceId !== state.surfaceId) continue;
      let source = latest.sources.get(d.id);
      if (!source) {
        try {
          source = await getSource(d);
        } catch {
          continue;
        }
      }
      const placed: PlacedDesign = toPlaced(d, source);
      const outlines: OverlayDesign['outlines'] = [];
      if (surface) {
        // A fill's frame is one tile; drawing every tile's outline would bury the part.
        const regs = placedRegions({ ...placed, mode: 'sticker' }, surface.bounds);
        for (const [color, mp] of regs.byColor) outlines.push({ color, mp });
      }
      const offSurface = map ? pieceAt(map, d.placement.x, d.placement.y) === null : false;
      designs.push({ id: d.id, active: d.id === activeId, placement: d.placement, widthMm: source.widthMm, heightMm: source.heightMm, outlines, offSurface });
    }
    viewport.setDesigns(designs);
    hint.textContent = designs.length ? 'Drag to move · corners scale · green handle rotates · Shift snaps rotation' : 'Load a design to place it here';
  };

  const panels = new Panels(document.getElementById('panel') as HTMLElement, {
    store,
    builder,
    onFrameSurface: () => {
      aimAtSurface();
      void refreshOverlay();
    },
    onTemplate: () => {
      if (!latest) return;
      const def = kindDef(store.state.kind);
      const sid = store.state.surfaceId;
      const surface = def.surfaces.find((s) => s.id === sid) ?? def.surfaces[0];
      const map = surfaceMap(latest.loaded, surface.id, 1);
      if (!map) return;
      const names = new Map(latest.loaded.pieces.map((p) => [p.id, p.name]));
      const svg = templateSvg(map, names, `${def.name} · ${surface.name}`);
      download(`${def.kind}-${surface.id}-template.svg`, new Blob([svg], { type: 'image/svg+xml' }));
    },
    onExport: async () => {
      if (!latest) return;
      setStatus('Writing the 3MF', 0.5, true);
      await new Promise((r) => setTimeout(r, 20));
      const p = printerById(store.state.printerId);
      const bytes = await write3mf({ printer: p, layout: latest.layout, slots: latest.exportSlots, projectName: `TMT ${latest.loaded.def.name}` });
      download(`tmt-${latest.loaded.def.kind}-${p.id}.3mf`, new Blob([bytes as BlobPart], { type: 'model/3mf' }));
      setStatus('Exported', 1, false);
    },
  });

  builder.onStatus = (s) => setStatus(s.message, s.progress, s.busy);
  builder.onError = (m) => {
    setStatus('Something went wrong', 0, false);
    alert(m);
  };
  builder.onResult = (r) => {
    latest = r;
    samplers = new Map();
    for (const s of r.loaded.surfaces) for (const id of s.def.pieces) {
      const piece = r.loaded.pieces.find((p) => p.id === id);
      if (piece) samplers.set(s.def.id + ':' + id, new HeightSampler(toLocalMesh(s.frame, piece.mesh)));
    }
    viewport.setPieces(r.cut.pieces.map((p) => ({ id: p.id, body: p.body, inlays: p.inlays.map((i) => ({ color: i.color, mesh: i.mesh })), dim: r.loaded.pieces.find((x) => x.id === p.id)?.noDesign })), r.state.bodyColor);
    aimAtSurface();
    void refreshOverlay();
    panels.refresh(r);
  };

  viewport.onPlacement = (id, p, final) => {
    store.updateDesign(id, (d) => ({ ...d, placement: p }));
    if (final) builder.schedule(50);
  };
  viewport.onSelect = (id) => store.set({ activeDesignId: id });

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  store.subscribe((s, prev) => {
    panels.refresh(latest);
    void refreshOverlay();
    // A drag mid-flight only moves the overlay; the cut waits until the pointer has been still.
    builder.schedule(placementOnlyChange(s, prev) ? 450 : 150);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const r = saveSession(s);
      saveFailed = !r.ok;
      if (r.dropped.length) setStatus(`Session saved without ${r.dropped.join(', ')}: too big for the browser`, 1, false);
    }, 600);
  });
  window.addEventListener('beforeunload', (e) => {
    if (saveFailed && store.state.designs.length) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  const helpDialog = document.getElementById('help') as HTMLDialogElement;
  helpDialog.append(h('div', { class: 'head' }, h('h1', {}, 'How this works'), h('button', { class: 'btn small', onClick: () => helpDialog.close() }, 'Close')), helpContent());
  document.getElementById('btn-help')!.addEventListener('click', () => helpDialog.showModal());

  const saved = loadSession();
  const bar = document.getElementById('restore-bar') as HTMLElement;
  if (saved && saved.state.designs.length > 0) {
    (document.getElementById('restore-when') as HTMLElement).textContent = new Date(saved.savedAt).toLocaleString();
    bar.hidden = false;
    document.getElementById('btn-restore')!.addEventListener('click', () => {
      bar.hidden = true;
      store.set(saved.state);
    });
    document.getElementById('btn-fresh')!.addEventListener('click', () => {
      bar.hidden = true;
      clearSession();
    });
  }
  panels.refresh(null);
  builder.schedule(0);
}

function placementOnlyChange(s: AppState, prev: AppState): boolean {
  if (s.designs.length !== prev.designs.length) return false;
  const so = s as unknown as Record<string, unknown>, po = prev as unknown as Record<string, unknown>;
  for (const k of Object.keys(so)) if (k !== 'designs' && so[k] !== po[k]) return false;
  for (let i = 0; i < s.designs.length; i++) {
    const a = s.designs[i] as unknown as Record<string, unknown>, b = prev.designs[i] as unknown as Record<string, unknown>;
    if (a === b) continue;
    for (const k of Object.keys(a)) if (k !== 'placement' && a[k] !== b[k]) return false;
  }
  return true;
}

void main();
