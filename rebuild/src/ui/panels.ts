import type { BuildResult, Builder } from '../app/build';
import { hubcapLimits } from '../app/parts';
import { lastTraceInfo } from '../app/sources';
import { newDesign, type DesignState, type Store } from '../app/state';
import { fileToDataUrl, fileToText, sniffKind } from '../design/decode';
import type { AutoMerge } from '../design/slots';
import { PRINTERS, printerById } from '../export/printers';
import { KINDS, kindDef, type PartKind } from '../parts/catalog';
import { clear, fmt, h } from './dom';

export interface PanelContext {
  store: Store;
  builder: Builder;
  onTemplate: () => void;
  onExport: () => Promise<void>;
  onFrameSurface: () => void;
}

/** A section rebuilds its DOM when its structure key changes and only syncs values otherwise, so a slider mid-drag is never replaced under the pointer. */
abstract class Section {
  root: HTMLElement;
  private key = '';
  constructor(
    protected ctx: PanelContext,
    id: string,
  ) {
    this.root = h('section', { class: 'sec', id });
  }
  abstract structureKey(r: BuildResult | null): string;
  abstract build(r: BuildResult | null): void;
  abstract sync(r: BuildResult | null): void;
  refresh(r: BuildResult | null): void {
    const k = this.structureKey(r);
    if (k !== this.key) {
      this.key = k;
      clear(this.root);
      this.build(r);
    }
    this.sync(r);
  }
  protected setVal(el: HTMLInputElement | HTMLSelectElement | null, v: string): void {
    if (!el || document.activeElement === el) return;
    if (el.value !== v) el.value = v;
  }
  protected q<T extends Element>(sel: string): T | null {
    return this.root.querySelector<T>(sel);
  }
}

class PartSection extends Section {
  structureKey(r: BuildResult | null): string {
    const s = this.ctx.store.state;
    return `${s.kind}:${s.designs.length > 0}:${r?.loaded.def.kind ?? ''}`;
  }
  build(): void {
    const { store } = this.ctx;
    const s = store.state;
    const def = kindDef(s.kind);
    this.root.append(
      h('h2', {}, 'Part'),
      h('div', { class: 'row' }, h('label', { for: 'part-kind' }, 'Part'), h('select', { id: 'part-kind', onChange: (e: Event) => this.changeKind((e.target as HTMLSelectElement).value as PartKind) }, ...KINDS.map((k) => h('option', { value: k.kind }, k.name)))),
    );
    if (def.variants)
      this.root.append(
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Casters'), h('div', { class: 'radios', id: 'part-variant' }, ...def.variants.map((v) => h('label', {}, h('input', { type: 'radio', name: 'variant', value: v.id, onChange: () => store.set({ variant: v.id }) }), v.name)))),
      );
    if (def.surfaces.length > 1)
      this.root.append(
        h('div', { class: 'row' }, h('label', { for: 'part-surface' }, 'Surface'), h('select', { id: 'part-surface', onChange: (e: Event) => { store.set({ surfaceId: (e.target as HTMLSelectElement).value }); this.ctx.onFrameSurface(); } }, ...def.surfaces.map((sf) => h('option', { value: sf.id }, sf.name)))),
        h('p', { class: 'note' }, 'A design you load lands on this surface. Change a loaded design’s surface on its own row.'),
      );
    this.root.append(
      h('div', { class: 'row' }, h('label', { for: 'body-color' }, 'Body color'), h('input', { type: 'color', id: 'body-color', onInput: (e: Event) => store.set({ bodyColor: (e.target as HTMLInputElement).value }) }), h('select', { id: 'body-filament', onChange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v) store.set({ bodyColor: v }); } }, h('option', { value: '' }, 'Pick a filament…'), ...this.ctx.builder.filaments.map((f) => h('option', { value: f.hex }, f.name)))),
    );
    if (s.kind === 'hubcap') {
      this.root.append(
        h('div', { class: 'row' }, h('label', { for: 'hubcap-mm' }, 'Diameter'), h('input', { type: 'number', id: 'hubcap-mm', step: 1, onChange: (e: Event) => { const v = parseFloat((e.target as HTMLInputElement).value); if (Number.isFinite(v)) store.set({ hubcapDiameterMm: v }); } }), h('span', { class: 'unit', id: 'hubcap-range' })),
        h('div', { class: 'row' }, h('label', {}, ''), h('label', {}, h('input', { type: 'checkbox', id: 'hubcap-cut', disabled: s.designs.length === 0, onChange: (e: Event) => store.set({ hubcapCutToShape: (e.target as HTMLInputElement).checked }) }), ' Cut to design outline')),
        h('p', { class: 'note' }, 'The disc is 3 mm thick with a 1 mm angled edge; the four clips stay put. Cut to outline needs a design with a transparent background, and keeps the clips.'),
      );
    }
    this.root.append(h('div', { class: 'row' }, h('button', { class: 'btn', id: 'btn-template', onClick: () => this.ctx.onTemplate() }, 'Download design template'), h('span', { class: 'note' }, 'True size SVG of this surface')));
  }
  sync(r: BuildResult | null): void {
    const s = this.ctx.store.state;
    this.setVal(this.q('#part-kind'), s.kind);
    this.root.querySelectorAll<HTMLInputElement>('input[name=variant]').forEach((el) => (el.checked = el.value === s.variant));
    this.setVal(this.q('#part-surface'), s.surfaceId);
    this.setVal(this.q('#body-color'), s.bodyColor);
    this.setVal(this.q('#body-filament'), this.ctx.builder.filaments.some((f) => f.hex === s.bodyColor) ? s.bodyColor : '');
    if (s.kind === 'hubcap') {
      const lim = hubcapLimits(printerById(s.printerId).bedW);
      this.setVal(this.q('#hubcap-mm'), String(s.hubcapDiameterMm));
      const range = this.q<HTMLElement>('#hubcap-range');
      if (range) range.textContent = `mm · ${lim.min} to ${lim.max} on this printer`;
      const cut = this.q<HTMLInputElement>('#hubcap-cut');
      if (cut) cut.checked = s.hubcapCutToShape;
    }
    const tb = this.q<HTMLButtonElement>('#btn-template');
    if (tb) tb.disabled = !r;
  }
  private changeKind(kind: PartKind): void {
    const { store } = this.ctx;
    const def = kindDef(kind);
    const surfaceId = def.surfaces[0].id;
    const moving = store.state.designs.length > 0;
    if (moving && !confirm(`Switch to the ${def.name}? Your designs move with you onto its ${def.surfaces[0].name}.`)) {
      this.sync(this.ctx.builder.latest);
      return;
    }
    store.update((s) => ({ ...s, kind, surfaceId, hubcapCutToShape: false, designs: s.designs.map((d) => ({ ...d, surfaceId, mode: def.fill ? d.mode : 'sticker' })) }));
    this.ctx.onFrameSurface();
  }
}

class DesignSection extends Section {
  structureKey(): string {
    const s = this.ctx.store.state;
    return `${s.kind}:${s.designs.map((d) => d.id + d.kind + d.mode).join(',')}:${s.activeDesignId ?? s.designs[0]?.id ?? ''}`;
  }
  build(r: BuildResult | null): void {
    const { store } = this.ctx;
    const s = store.state;
    const def = kindDef(s.kind);
    const input = h('input', { type: 'file', accept: '.svg,.png,.jpg,.jpeg,.webp,.gif,.bmp,image/*', multiple: true, style: 'display:none', onChange: (e: Event) => void this.addFiles((e.target as HTMLInputElement).files) });
    const drop = h('div', { class: 'dropzone', onClick: () => input.click() }, 'Drop an SVG or picture here, or click to choose', h('div', { class: 'note' }, 'SVG with flat colors traces sharpest. PNG, JPG, WebP, GIF and BMP work too.'));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); void this.addFiles(e.dataTransfer?.files ?? null); });
    this.root.append(h('h2', {}, 'Design', h('span', { class: 'count' }, s.designs.length ? `${s.designs.length} loaded` : '')), drop, input);
    for (const d of s.designs) {
      const active = d.id === (s.activeDesignId ?? s.designs[0]?.id);
      const surface = def.surfaces.find((x) => x.id === d.surfaceId);
      const source = r?.sources.get(d.id);
      const row = h('div', { class: 'design' + (active ? ' active' : ''), onClick: () => store.set({ activeDesignId: d.id }) },
        h('div', { class: 'name' }, d.name, h('span', { class: 'muted', id: 'size-' + d.id }, source ? `${fmt(source.widthMm, 0)} × ${fmt(source.heightMm, 0)} mm` : ''), h('button', { class: 'btn small x', title: 'Remove', onClick: (e: Event) => { e.stopPropagation(); this.remove(d.id); } }, '×')),
      );
      if (def.surfaces.length > 1)
        row.append(h('div', { class: 'row' }, h('label', {}, 'Surface'), h('select', { id: 'surface-' + d.id, onChange: (e: Event) => store.updateDesign(d.id, (x) => ({ ...x, surfaceId: (e.target as HTMLSelectElement).value })) }, ...def.surfaces.map((sf) => h('option', { value: sf.id, selected: sf.id === d.surfaceId }, sf.name)))));
      const modes = h('div', { class: 'radios' },
        h('label', {}, h('input', { type: 'radio', name: 'mode-' + d.id, checked: d.mode === 'sticker', onChange: () => store.updateDesign(d.id, (x) => ({ ...x, mode: 'sticker' })) }), 'Sticker'),
        def.fill ? h('label', {}, h('input', { type: 'radio', name: 'mode-' + d.id, checked: d.mode === 'fill', onChange: () => store.updateDesign(d.id, (x) => ({ ...x, mode: 'fill' })) }), 'Fill') : null,
        h('label', { title: surface?.mirrorOf ? `Also cut a reflected copy on the ${def.surfaces.find((x) => x.id === surface.mirrorOf)?.name}` : 'Also cut a reflected copy across the centre line' }, h('input', { type: 'checkbox', id: 'mirror-' + d.id, checked: d.mirror, onChange: (e: Event) => store.updateDesign(d.id, (x) => ({ ...x, mirror: (e.target as HTMLInputElement).checked })) }), 'Mirror'),
      );
      row.append(h('div', { class: 'row' }, h('label', {}, 'Place'), modes));
      if (d.kind === 'image') {
        const info = lastTraceInfo(d.id);
        row.append(
          h('div', { class: 'row' }, h('label', { for: 'colors-' + d.id }, 'Colors'), h('input', { type: 'range', id: 'colors-' + d.id, min: 2, max: 16, step: 1, value: d.imageSettings.colors, onInput: (e: Event) => { const out = row.querySelector('#colors-out-' + d.id); if (out) out.textContent = (e.target as HTMLInputElement).value; }, onChange: (e: Event) => store.updateDesign(d.id, (x) => ({ ...x, imageSettings: { ...x.imageSettings, colors: parseInt((e.target as HTMLInputElement).value, 10) } })) }), h('span', { class: 'unit', id: 'colors-out-' + d.id }, String(d.imageSettings.colors))),
          h('div', { class: 'row' }, h('label', { for: 'detail-' + d.id }, 'Detail'), h('input', { type: 'range', id: 'detail-' + d.id, min: 0, max: 1, step: 0.05, value: d.imageSettings.detail, onChange: (e: Event) => store.updateDesign(d.id, (x) => ({ ...x, imageSettings: { ...x.imageSettings, detail: parseFloat((e.target as HTMLInputElement).value) } })) })),
          h('p', { class: 'note', id: 'trace-' + d.id }, traceText(info)),
        );
      }
      row.append(h('div', { id: 'warn-' + d.id }, ...(source?.warnings ?? []).map((w) => h('div', { class: 'warn' }, w))));
      this.root.append(row);
    }
  }
  sync(r: BuildResult | null): void {
    for (const d of this.ctx.store.state.designs) {
      const source = r?.sources.get(d.id);
      const size = this.q<HTMLElement>('#size-' + d.id);
      if (size && source) size.textContent = `${fmt(source.widthMm, 0)} × ${fmt(source.heightMm, 0)} mm`;
      const trace = this.q<HTMLElement>('#trace-' + d.id);
      if (trace) trace.textContent = traceText(lastTraceInfo(d.id));
      const warn = this.q<HTMLElement>('#warn-' + d.id);
      if (warn) {
        const want = (source?.warnings ?? []).join('\n');
        if (warn.dataset.text !== want) {
          warn.dataset.text = want;
          clear(warn);
          for (const w of source?.warnings ?? []) warn.append(h('div', { class: 'warn' }, w));
        }
      }
      this.setVal(this.q('#colors-' + d.id), String(d.imageSettings.colors));
      this.setVal(this.q('#detail-' + d.id), String(d.imageSettings.detail));
      const surfaceSel = this.q<HTMLSelectElement>('#surface-' + d.id);
      this.setVal(surfaceSel, d.surfaceId);
      const mirror = this.q<HTMLInputElement>('#mirror-' + d.id);
      if (mirror) mirror.checked = d.mirror;
    }
  }
  private async addFiles(files: FileList | null): Promise<void> {
    if (!files) return;
    const { store } = this.ctx;
    for (const f of Array.from(files)) {
      const kind = await sniffKind(f);
      if (kind === 'unknown') {
        alert(`${f.name} isn't a format this tool can open. SVG, PNG, JPG, WebP, GIF and BMP work; a TIFF needs re-exporting as PNG.`);
        continue;
      }
      const base = { name: f.name, surfaceId: store.state.surfaceId, kind };
      const d = kind === 'svg' ? newDesign({ ...base, svgText: await fileToText(f) }) : newDesign({ ...base, imageDataUrl: await fileToDataUrl(f) });
      // Step a second design across so it doesn't hide under the first.
      const n = store.state.designs.filter((x) => x.surfaceId === d.surfaceId).length;
      d.placement = { ...d.placement, x: n * 12, y: -n * 12 };
      if (!kindDef(store.state.kind).fill) d.mode = 'sticker';
      store.update((s) => ({ ...s, designs: [...s.designs, d], activeDesignId: d.id }));
    }
  }
  private remove(id: string): void {
    const { store } = this.ctx;
    store.update((s) => {
      const designs = s.designs.filter((d) => d.id !== id);
      return { ...s, designs, activeDesignId: s.activeDesignId === id ? (designs[0]?.id ?? null) : s.activeDesignId, hubcapCutToShape: designs.length ? s.hubcapCutToShape : false };
    });
  }
}

class FitSection extends Section {
  structureKey(): string {
    const s = this.ctx.store.state;
    const d = this.ctx.store.activeDesign;
    return `${d?.id ?? ''}:${d?.mode ?? ''}:${s.kind}`;
  }
  build(): void {
    const { store } = this.ctx;
    const d = store.activeDesign;
    this.root.append(h('h2', {}, 'Fit', h('span', { class: 'count' }, d ? d.name : '')));
    if (!d) {
      this.root.append(h('p', { class: 'note' }, 'Load a design to place it.'));
      return;
    }
    const upd = (fn: (p: DesignState['placement']) => Partial<DesignState['placement']>) => store.updateDesign(d.id, (x) => ({ ...x, placement: { ...x.placement, ...fn(x.placement) } }));
    const num = (id: string, step: number, on: (v: number) => void) => h('input', { type: 'number', id, step, onChange: (e: Event) => { const v = parseFloat((e.target as HTMLInputElement).value); if (Number.isFinite(v)) on(v); } });
    this.root.append(
      h('p', { class: 'note' }, 'Drag the design on the part to move it. Corners scale, the green handle rotates.'),
      h('div', { class: 'row' }, h('label', { for: 'fit-scale' }, 'Scale'), h('input', { type: 'range', id: 'fit-scale', min: 10, max: 400, step: 1, onInput: (e: Event) => upd(() => ({ scale: parseFloat((e.target as HTMLInputElement).value) / 100 })) }), num('fit-scale-n', 1, (v) => upd(() => ({ scale: Math.max(0.05, v / 100) }))), h('span', { class: 'unit' }, '%')),
      h('div', { class: 'row' }, h('label', { for: 'fit-rot' }, 'Rotation'), h('input', { type: 'range', id: 'fit-rot', min: -180, max: 180, step: 1, onInput: (e: Event) => upd(() => ({ rotationDeg: parseFloat((e.target as HTMLInputElement).value) })) }), num('fit-rot-n', 1, (v) => upd(() => ({ rotationDeg: v }))), h('span', { class: 'unit' }, '°')),
      h('div', { class: 'row' }, h('label', {}, 'Position'), num('fit-x', 1, (v) => upd(() => ({ x: v }))), h('span', { class: 'unit' }, 'across'), num('fit-y', 1, (v) => upd(() => ({ y: v }))), h('span', { class: 'unit' }, 'up, mm')),
      h('div', { class: 'row' }, h('label', {}, 'Flip'), h('label', {}, h('input', { type: 'checkbox', id: 'fit-fh', onChange: (e: Event) => upd(() => ({ flipH: (e.target as HTMLInputElement).checked })) }), ' Left ↔ right'), h('label', {}, h('input', { type: 'checkbox', id: 'fit-fv', onChange: (e: Event) => upd(() => ({ flipV: (e.target as HTMLInputElement).checked })) }), ' Top ↔ bottom')),
    );
    if (d.mode === 'fill') this.root.append(h('div', { class: 'row' }, h('label', { for: 'fit-gap' }, 'Tile gap'), num('fit-gap', 0.5, (v) => store.updateDesign(d.id, (x) => ({ ...x, tileGapMm: Math.max(0, v) }))), h('span', { class: 'unit' }, 'mm between tiles')));
  }
  sync(): void {
    const d = this.ctx.store.activeDesign;
    if (!d) return;
    const p = d.placement;
    this.setVal(this.q('#fit-scale'), String(Math.round(p.scale * 100)));
    this.setVal(this.q('#fit-scale-n'), String(Math.round(p.scale * 100)));
    this.setVal(this.q('#fit-rot'), String(Math.round(p.rotationDeg)));
    this.setVal(this.q('#fit-rot-n'), String(Math.round(p.rotationDeg)));
    this.setVal(this.q('#fit-x'), fmt(p.x));
    this.setVal(this.q('#fit-y'), fmt(p.y));
    const fh = this.q<HTMLInputElement>('#fit-fh'), fv = this.q<HTMLInputElement>('#fit-fv');
    if (fh) fh.checked = p.flipH;
    if (fv) fv.checked = p.flipV;
    this.setVal(this.q('#fit-gap'), fmt(d.tileGapMm));
  }
}

class ColorsSection extends Section {
  structureKey(r: BuildResult | null): string {
    const s = this.ctx.store.state;
    return `${r?.gen ?? 0}:${s.printerId}:${JSON.stringify(s.slots)}`;
  }
  build(r: BuildResult | null): void {
    const { store } = this.ctx;
    const s = store.state;
    this.root.append(
      h('h2', {}, 'Depth and colors'),
      h('div', { class: 'row' }, h('label', { for: 'depth' }, 'Depth'), h('input', { type: 'number', id: 'depth', step: 0.1, min: 0, onChange: (e: Event) => { const v = parseFloat((e.target as HTMLInputElement).value); if (Number.isFinite(v)) store.set({ defaultDepthMm: v }); } }), h('span', { class: 'unit' }, 'mm into the surface, for every color unless a slot says otherwise')),
      h('div', { class: 'row' }, h('label', { for: 'automerge' }, 'Auto-merge'), h('select', { id: 'automerge', onChange: (e: Event) => store.update((x) => ({ ...x, slots: { ...x.slots, autoMerge: (e.target as HTMLSelectElement).value as AutoMerge } })) }, ...(['none', 'slight', 'medium', 'strong'] as AutoMerge[]).map((v) => h('option', { value: v }, v[0].toUpperCase() + v.slice(1)))), h('span', { class: 'unit' }, 'joins look-alike colors into one slot')),
    );
    if (!r || r.entries.length === 0) {
      this.root.append(h('p', { class: 'note' }, 'Colors show up here once a design is loaded.'));
      return;
    }
    const printer = printerById(s.printerId);
    const plan = r.plan;
    const total = r.entries.reduce((a, e) => a + e.areaMm2, 0) || 1;
    const list = h('div', {});
    const pct = (a: number) => `${Math.max(1, Math.round((a / total) * 100))}%`;
    const swatch = (color: string, remove?: () => void) => h('span', { class: 'swatch', style: `background:${color}`, title: color }, remove ? h('span', { class: 'x', onClick: remove }, '×') : null);
    // Body row.
    list.append(
      h('div', { class: 'slot' },
        h('span', { class: 'num body' }, '1'),
        h('div', {}, h('div', { class: 'swatches' }, swatch(s.bodyColor), ...plan.body.colors.map((c) => swatch(c, () => this.pullFromBody(c))), h('span', { class: 'meta' }, plan.body.colors.length ? `Body, plus ${plan.body.colors.length} design color${plan.body.colors.length > 1 ? 's' : ''} printed as the body (× to cut again)` : 'Body: the part itself, not cut'))),
        h('span', {}),
      ),
    );
    for (const slot of plan.slots) {
      const used = r.cut.slotsUsed.has(slot.index);
      const merge = h('select', { onChange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v) this.mergeInto(slot.printColor, v); } }, h('option', { value: '' }, 'Merge with…'), ...plan.slots.filter((o) => o !== slot).map((o) => h('option', { value: o.printColor }, o.printColor)));
      const depth = h('input', { type: 'number', step: 0.1, min: 0, placeholder: fmt(s.defaultDepthMm), value: slot.depthMm !== undefined ? fmt(slot.depthMm) : '', title: 'Depth for this slot; blank uses the default', onChange: (e: Event) => { const raw = (e.target as HTMLInputElement).value.trim(); this.setDepth(slot.printColor, raw === '' ? undefined : parseFloat(raw)); } });
      list.append(
        h('div', { class: 'slot' + (used ? '' : ' unused') },
          h('span', { class: 'num' }, String(r.slotMap.get(slot.index) ?? '–')),
          h('div', {}, h('div', { class: 'swatches' }, ...slot.colors.map((c) => swatch(c, slot.colors.length > 1 ? () => this.split(c) : undefined)), h('span', { class: 'meta' }, `${slot.printColor} · ${pct(slot.areaMm2)}${slot.colors.length > 1 ? ` · ${slot.colors.length} colors, prints in the main one` : ''}${used ? '' : ' · not on the part'}`))),
          h('button', { class: 'btn small', title: 'Print this color as the body instead of cutting it', onClick: () => this.toBody(slot.colors) }, '→ body'),
          h('div', { class: 'tools' }, h('span', { class: 'meta' }, 'Depth'), depth, h('span', { class: 'meta' }, 'mm'), merge),
        ),
      );
    }
    const needed = r.exportSlots.length;
    const over = needed > printer.slotsMax;
    this.root.append(list, h('div', { class: 'summary' + (over ? ' over' : '') }, `${r.entries.length} color${r.entries.length === 1 ? '' : 's'} → ${needed} slot${needed === 1 ? '' : 's'} including the body. ${printer.label.split(' (')[0]}: ${printer.slotsPerUnit} per ${printer.unitLabel}, up to ${printer.slotsMax}.${over ? ' Merge colors or send some to the body.' : ''}`));
  }
  sync(): void {
    const s = this.ctx.store.state;
    this.setVal(this.q('#depth'), fmt(s.defaultDepthMm, 2));
    this.setVal(this.q('#automerge'), s.slots.autoMerge);
  }
  private toBody(colors: string[]): void {
    this.ctx.store.update((x) => ({ ...x, slots: { ...x.slots, toBase: [...new Set([...x.slots.toBase, ...colors])] } }));
  }
  private pullFromBody(color: string): void {
    this.ctx.store.update((x) => ({ ...x, slots: { ...x.slots, toBase: x.slots.toBase.filter((c) => c !== color), manualMerges: Object.fromEntries(Object.entries(x.slots.manualMerges).filter(([k]) => k !== color)) } }));
  }
  private mergeInto(from: string, into: string): void {
    this.ctx.store.update((x) => ({ ...x, slots: { ...x.slots, manualMerges: { ...x.slots.manualMerges, [from]: into }, keepApart: x.slots.keepApart.filter((c) => c !== from) } }));
  }
  private split(color: string): void {
    this.ctx.store.update((x) => ({ ...x, slots: { ...x.slots, keepApart: [...new Set([...x.slots.keepApart, color])], manualMerges: Object.fromEntries(Object.entries(x.slots.manualMerges).filter(([k, v]) => k !== color && v !== color)) } }));
  }
  private setDepth(color: string, depth: number | undefined): void {
    this.ctx.store.update((x) => {
      const depthOverrides = { ...x.slots.depthOverrides };
      if (depth === undefined || !Number.isFinite(depth)) delete depthOverrides[color];
      else depthOverrides[color] = depth;
      return { ...x, slots: { ...x.slots, depthOverrides } };
    });
  }
}

class ExportSection extends Section {
  private busy = false;
  structureKey(r: BuildResult | null): string {
    return `${r?.gen ?? 0}:${this.ctx.store.state.designs.length}`;
  }
  build(r: BuildResult | null): void {
    const { store } = this.ctx;
    const s = store.state;
    const printer = printerById(s.printerId);
    this.root.append(
      h('h2', {}, 'Export'),
      h('div', { class: 'row' }, h('label', { for: 'printer' }, 'Printer'), h('select', { id: 'printer', onChange: (e: Event) => store.set({ printerId: (e.target as HTMLSelectElement).value }) }, ...PRINTERS.map((p) => h('option', { value: p.id }, p.label)))),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', id: 'btn-export', disabled: !r || s.designs.length === 0, onClick: () => void this.doExport() }, 'Export 3MF'), h('span', { class: 'note', id: 'export-note' }, r ? `${r.layout.plates.length} plate${r.layout.plates.length === 1 ? '' : 's'}, ${r.exportSlots.length} filament slots, ${printer.unitLabel} ${printer.slotsPerUnit} per unit` : '')),
      h('p', { class: 'note' }, 'Opens in Bambu Studio, OrcaSlicer or Snapmaker Orca with every part on its slot. Generic PETG, 15% gyroid, tree supports, no brim.'),
    );
    const w = h('div', { class: 'warnings', id: 'warnings' });
    for (const warn of r?.warnings ?? []) w.append(h('div', { class: 'warning ' + warn.kind }, warn.text));
    this.root.append(w);
  }
  sync(): void {
    this.setVal(this.q('#printer'), this.ctx.store.state.printerId);
    const b = this.q<HTMLButtonElement>('#btn-export');
    if (b) b.disabled = this.busy || !this.ctx.builder.latest || this.ctx.store.state.designs.length === 0;
  }
  private async doExport(): Promise<void> {
    this.busy = true;
    this.sync();
    try {
      await this.ctx.onExport();
    } finally {
      this.busy = false;
      this.sync();
    }
  }
}

function traceText(info: ReturnType<typeof lastTraceInfo>): string {
  if (!info) return 'Tracing…';
  return `Found ${info.colorsFound} colors in ${info.regions} shapes${info.photo ? ', traced as a photo' : ''}${info.specksRemoved ? `, ${info.specksRemoved} specks melted away` : ''}.`;
}

export class Panels {
  private sections: Section[];
  constructor(root: HTMLElement, ctx: PanelContext) {
    this.sections = [new PartSection(ctx, 'sec-part'), new DesignSection(ctx, 'sec-design'), new FitSection(ctx, 'sec-fit'), new ColorsSection(ctx, 'sec-colors'), new ExportSection(ctx, 'sec-export')];
    for (const s of this.sections) root.append(s.root);
  }
  refresh(r: BuildResult | null): void {
    for (const s of this.sections) s.refresh(r);
  }
}
