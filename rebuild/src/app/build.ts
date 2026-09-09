import type { ManifoldToplevel } from 'manifold-3d';
import { colorName } from '../design/color';
import type { DesignSource, PlacedDesign } from '../design/placement';
import { planSlots, type ColorEntry, type SlotPlan } from '../design/slots';
import { layoutPlates, type Layout } from '../export/plates';
import { printerById } from '../export/printers';
import type { ExportSlot } from '../export/threemf-write';
import { cutAll, type CutJob, type CutResult, type Warning } from '../geometry/inlay';
import type { WorkerReply, WorkerRequest } from './cut.worker';
import type { Vec3 } from '../geometry/mesh';
import { hubcapLimits, loadKind, silhouetteOutline, type LoadedKind } from './parts';
import { getSource } from './sources';
import type { AppState, DesignState, Store } from './state';

export interface BuildResult {
  gen: number;
  state: AppState;
  loaded: LoadedKind;
  sources: Map<string, DesignSource>;
  placed: PlacedDesign[];
  entries: ColorEntry[];
  plan: SlotPlan;
  cut: CutResult;
  layout: Layout;
  exportSlots: ExportSlot[];
  /** plan slot index -> filament number in the export. */
  slotMap: Map<number, number>;
  warnings: Warning[];
  hubcapScaledBy: number;
}

export interface BuildStatus {
  busy: boolean;
  message: string;
  progress: number;
}

export interface Filament {
  id: string;
  name: string;
  hex: string;
}

export class Builder {
  onResult: ((r: BuildResult) => void) | null = null;
  onStatus: ((s: BuildStatus) => void) | null = null;
  onError: ((message: string) => void) | null = null;
  filaments: Filament[] = [];
  latest: BuildResult | null = null;
  private gen = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private worker: Worker | null = null;
  private workerBusy = false;

  constructor(
    private store: Store,
    private wasm: ManifoldToplevel,
  ) {}

  schedule(delayMs = 200): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), delayMs);
  }

  private status(busy: boolean, message: string, progress = 0): void {
    this.onStatus?.({ busy, message, progress });
  }

  async run(): Promise<void> {
    const gen = ++this.gen;
    const state = this.store.state;
    const stale = () => gen !== this.gen;
    try {
      this.status(true, 'Reading designs', 0.02);
      const sources = new Map<string, DesignSource>();
      for (const d of state.designs) {
        sources.set(d.id, await getSource(d));
        if (stale()) return;
      }
      const placed = placedDesigns(state, sources);
      let hubcapScaledBy = 1;
      let hubcapReq;
      if (state.kind === 'hubcap') {
        const lim = hubcapLimits(printerById(state.printerId).bedW);
        const diameterMm = Math.max(lim.min, Math.min(lim.max, state.hubcapDiameterMm));
        hubcapReq = { wasm: this.wasm, req: { diameterMm } as { diameterMm: number; outline?: ReturnType<typeof silhouetteOutline> extends infer R ? (R extends { outline: infer O } ? O : never) : never } };
        if (state.hubcapCutToShape) {
          const active = placed.find((p) => p.id === (state.activeDesignId ?? placed[0]?.id));
          const sil = active ? silhouetteOutline(active) : null;
          if (sil) {
            hubcapReq.req.outline = sil.outline;
            hubcapScaledBy = sil.scaledBy;
          }
        }
      }
      this.status(true, 'Loading the part', 0.08);
      const loaded = await loadKind(state.kind, state.variant, hubcapReq);
      if (stale()) return;

      const entries = colorEntries(placed);
      const plan = planSlots(entries, state.slots, state.bodyColor);
      this.status(true, 'Cutting', 0.15);
      const cut = await this.cut({ pieces: loaded.pieces, surfaces: loaded.surfaces, designs: placed, plan, defaultDepthMm: state.defaultDepthMm }, gen, (msg, frac) => this.status(true, msg, 0.15 + frac * 0.7));
      if (stale()) return;

      const printer = printerById(state.printerId);
      const down = new Map<string, Vec3>();
      if (state.kind !== 'chair') for (const s of loaded.surfaces) for (const id of s.def.pieces) down.set(id, s.def.normal);
      this.status(true, 'Placing on plates', 0.9);
      const layout = layoutPlates(cut.pieces, printer, down);

      // Filament numbers: body first, then every slot that actually cut something.
      const used = plan.slots.filter((s) => cut.slotsUsed.has(s.index));
      const slotMap = new Map<number, number>();
      const exportSlots: ExportSlot[] = [{ index: 1, color: state.bodyColor, name: `Body · ${this.nameOf(state.bodyColor)}` }];
      used.forEach((s, i) => {
        slotMap.set(s.index, i + 2);
        exportSlots.push({ index: i + 2, color: s.printColor, name: this.nameOf(s.printColor) });
      });
      for (const plate of layout.plates)
        for (const pp of plate.pieces) for (const inl of pp.inlays) inl.slot = slotMap.get(inl.slot) ?? 1;

      const warnings: Warning[] = [];
      for (const d of state.designs) for (const w of sources.get(d.id)?.warnings ?? []) warnings.push({ text: `${d.name}: ${w}`, kind: 'warning' });
      if (hubcapScaledBy < 1) warnings.push({ text: `The hubcap outline was scaled to ${Math.round(hubcapScaledBy * 100)}% so nothing reaches past the 280 mm wheel.`, kind: 'info' });
      warnings.push(...cut.warnings);
      for (const w of layout.warnings) warnings.push({ text: w, kind: 'warning' });
      const needed = exportSlots.length;
      if (needed > printer.slotsMax) warnings.push({ text: `This needs ${needed} filament slots and the ${printer.label.split(' (')[0]} has at most ${printer.slotsMax}. Merge colors or send some to the body.`, kind: 'error' });
      else if (needed > printer.slotsPerUnit) warnings.push({ text: `This needs ${needed} filament slots, more than one ${printer.unitLabel} holds (${printer.slotsPerUnit}).`, kind: 'info' });
      if (layout.plates.length > 0 && !layout.plates.every((p) => p.pieces.every((pp) => pp.verified)))
        warnings.push({ text: 'Plate layout, part orientation and prime tower positions were computed, not checked on a printer. Look them over in your slicer before printing.', kind: 'info' });
      warnings.push(...overlapWarnings(placed, loaded));

      const result: BuildResult = { gen, state, loaded, sources, placed, entries, plan, cut, layout, exportSlots, slotMap, warnings, hubcapScaledBy };
      this.latest = result;
      this.status(false, 'Ready', 1);
      this.onResult?.(result);
    } catch (e) {
      if (e instanceof Stale || stale()) return;
      this.status(false, 'Stopped', 0);
      this.onError?.(e instanceof Error ? e.message : String(e));
    }
  }

  /** The cut runs in a worker so the page stays live; a job made stale mid-cut is killed with its worker, since a boolean cannot be interrupted. */
  private cut(job: Omit<CutJob, 'wasm'>, gen: number, progress: (msg: string, frac: number) => void): Promise<CutResult> {
    if (typeof Worker === 'undefined') return cutAll({ ...job, wasm: this.wasm }, progress);
    if (this.worker && this.workerBusy) {
      this.worker.terminate();
      this.worker = null;
    }
    if (!this.worker) this.worker = new Worker(new URL('./cut.worker.ts', import.meta.url), { type: 'module' });
    const worker = this.worker;
    this.workerBusy = true;
    return new Promise<CutResult>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<WorkerReply>) => {
        const m = e.data;
        if (m.gen !== gen) return;
        if (m.type === 'progress') progress(m.message, m.frac);
        else if (m.type === 'done') {
          this.workerBusy = false;
          resolve({ ...m.result, slotsUsed: new Set(m.result.slotsUsed) });
        } else {
          this.workerBusy = false;
          reject(new Error(m.message));
        }
      };
      worker.onerror = (e) => {
        this.workerBusy = false;
        this.worker = null;
        reject(new Error(e.message || 'The cutting worker failed.'));
      };
      const req: WorkerRequest = { type: 'cut', gen, job };
      worker.postMessage(req);
    });
  }

  private nameOf(hex: string): string {
    return this.filaments.length ? colorName(hex, this.filaments) : hex;
  }
}

class Stale extends Error {}

export function placedDesigns(state: AppState, sources: Map<string, DesignSource>): PlacedDesign[] {
  const out: PlacedDesign[] = [];
  for (const d of state.designs) {
    const source = sources.get(d.id);
    if (!source) continue;
    out.push(toPlaced(d, source));
  }
  return out;
}

export function toPlaced(d: DesignState, source: DesignSource): PlacedDesign {
  return { id: d.id, source, surfaceId: d.surfaceId, placement: d.placement, mode: d.mode, tileGapMm: d.tileGapMm, mirror: d.mirror };
}

export function colorEntries(placed: PlacedDesign[]): ColorEntry[] {
  const map = new Map<string, number>();
  for (const p of placed) for (const r of p.source.regions) map.set(r.color, (map.get(r.color) ?? 0) + r.areaMm2 * p.placement.scale * p.placement.scale);
  return [...map].map(([color, areaMm2]) => ({ color, areaMm2 }));
}

/** Two stickers whose placed boxes overlap on the same surface. Fills always overlap anything on their surface. */
function overlapWarnings(placed: PlacedDesign[], loaded: LoadedKind): Warning[] {
  const out: Warning[] = [];
  for (let i = 0; i < placed.length; i++)
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i], b = placed[j];
      if (a.surfaceId !== b.surfaceId) continue;
      const sname = loaded.def.surfaces.find((s) => s.id === a.surfaceId)?.name ?? a.surfaceId;
      if (a.mode === 'fill' && b.mode === 'fill') {
        out.push({ text: `${a.source.name} and ${b.source.name} are both set to Fill on ${sname}, so they cut over each other. Switch one to Sticker.`, kind: 'warning' });
        continue;
      }
      if (a.mode === 'fill' || b.mode === 'fill') continue;
      if (boxesOverlap(a, b)) out.push({ text: `${a.source.name} and ${b.source.name} overlap on ${sname}. Where they do, the later one wins. Move or scale one of them.`, kind: 'warning' });
    }
  return out;
}

function boxesOverlap(a: PlacedDesign, b: PlacedDesign): boolean {
  const box = (d: PlacedDesign) => {
    const r = Math.hypot(d.source.widthMm, d.source.heightMm) * d.placement.scale * 0.5;
    return { x: d.placement.x, y: d.placement.y, r };
  };
  const A = box(a), B = box(b);
  const ha = (a.source.widthMm * a.placement.scale) / 2, va = (a.source.heightMm * a.placement.scale) / 2;
  const hb = (b.source.widthMm * b.placement.scale) / 2, vb = (b.source.heightMm * b.placement.scale) / 2;
  if (a.placement.rotationDeg % 90 === 0 && b.placement.rotationDeg % 90 === 0) {
    const [aw, ah] = a.placement.rotationDeg % 180 === 0 ? [ha, va] : [va, ha];
    const [bw, bh] = b.placement.rotationDeg % 180 === 0 ? [hb, vb] : [vb, hb];
    return Math.abs(A.x - B.x) < aw + bw && Math.abs(A.y - B.y) < ah + bh;
  }
  return Math.hypot(A.x - B.x, A.y - B.y) < A.r + B.r;
}
