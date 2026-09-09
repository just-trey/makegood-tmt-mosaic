import type { DesignMode, Placement } from '../design/placement';
import { defaultPlacement } from '../design/placement';
import { defaultSlotSettings, type SlotSettings } from '../design/slots';
import { DEFAULT_PRINTER } from '../export/printers';
import type { PartKind } from '../parts/catalog';

export interface ImageSettings {
  /** How many flat colors to reduce a picture to. */
  colors: number;
  /** 0 = coarse (big specks melt away), 1 = fine (down to what a 0.4mm nozzle prints). */
  detail: number;
}

export interface DesignState {
  id: string;
  name: string;
  kind: 'svg' | 'image';
  svgText?: string;
  imageDataUrl?: string;
  imageSettings: ImageSettings;
  surfaceId: string;
  placement: Placement;
  mode: DesignMode;
  tileGapMm: number;
  mirror: boolean;
}

export interface AppState {
  kind: PartKind;
  variant: string;
  surfaceId: string;
  printerId: string;
  bodyColor: string;
  hubcapDiameterMm: number;
  hubcapCutToShape: boolean;
  designs: DesignState[];
  activeDesignId: string | null;
  defaultDepthMm: number;
  slots: SlotSettings;
}

export const DEFAULT_DEPTH_MM = 1;
export const DEFAULT_HUBCAP_MM = 120;

export function initialState(): AppState {
  return {
    kind: 'wheel',
    variant: 'standard',
    surfaceId: 'face',
    printerId: DEFAULT_PRINTER,
    bodyColor: '#8a8f94',
    hubcapDiameterMm: DEFAULT_HUBCAP_MM,
    hubcapCutToShape: false,
    designs: [],
    activeDesignId: null,
    defaultDepthMm: DEFAULT_DEPTH_MM,
    slots: defaultSlotSettings(),
  };
}

export function newDesign(partial: Partial<DesignState> & Pick<DesignState, 'name' | 'kind' | 'surfaceId'>): DesignState {
  return {
    id: 'd' + Math.random().toString(36).slice(2, 9),
    imageSettings: { colors: 6, detail: 0.6 },
    placement: defaultPlacement(),
    mode: 'sticker',
    tileGapMm: 0,
    mirror: false,
    ...partial,
  };
}

type Listener = (state: AppState, prev: AppState) => void;

export class Store {
  private listeners = new Set<Listener>();
  constructor(public state: AppState = initialState()) {}

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  set(patch: Partial<AppState>): void {
    this.update((s) => ({ ...s, ...patch }));
  }

  update(fn: (s: AppState) => AppState): void {
    const prev = this.state;
    const next = fn(prev);
    if (next === prev) return;
    this.state = next;
    for (const l of this.listeners) l(next, prev);
  }

  updateDesign(id: string, fn: (d: DesignState) => DesignState): void {
    this.update((s) => ({ ...s, designs: s.designs.map((d) => (d.id === id ? fn(d) : d)) }));
  }

  get activeDesign(): DesignState | undefined {
    return this.state.designs.find((d) => d.id === this.state.activeDesignId) ?? this.state.designs[0];
  }
}
