import { deltaE } from './color';

export type AutoMerge = 'none' | 'slight' | 'medium' | 'strong';

export const AUTO_MERGE_DELTA_E: Record<AutoMerge, number> = { none: 0, slight: 5, medium: 12, strong: 22 };

export interface ColorEntry {
  color: string;
  areaMm2: number;
}

export interface SlotSettings {
  autoMerge: AutoMerge;
  /** color -> color it was dragged onto. */
  manualMerges: Record<string, string>;
  /** Colors pulled out of an automatic group. */
  keepApart: string[];
  /** Colors printed as the body instead of cut. */
  toBase: string[];
  /** Depth per slot, keyed by the slot's main color. */
  depthOverrides: Record<string, number>;
}

export interface Slot {
  /** 1-based filament slot in the slicer. Slot 1 is always the body. */
  index: number;
  colors: string[];
  printColor: string;
  areaMm2: number;
  /** Undefined means the default depth. */
  depthMm?: number;
  /** True when this slot's members were merged automatically rather than by hand. */
  auto: boolean;
}

export interface SlotPlan {
  body: Slot;
  slots: Slot[];
}

export function defaultSlotSettings(): SlotSettings {
  return { autoMerge: 'slight', manualMerges: {}, keepApart: [], toBase: [], depthOverrides: {} };
}

/**
 * Group the design's colors into filament slots. Bigger colors anchor a group and give it its
 * print color; auto-merge joins colors within the level's distance; hand merges always win and
 * "keep apart" always loses to nothing but the body.
 */
export function planSlots(entries: ColorEntry[], settings: SlotSettings, bodyColor: string): SlotPlan {
  const sorted = entries.slice().sort((a, b) => b.areaMm2 - a.areaMm2);
  const parent = new Map<string, string>();
  const find = (c: string): string => {
    let p = parent.get(c) ?? c;
    while (p !== (parent.get(p) ?? p)) p = parent.get(p) ?? p;
    parent.set(c, p);
    return p;
  };
  const unite = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const auto = new Set<string>();
  const inBase = new Set(settings.toBase.filter((c) => entries.some((e) => e.color === c)));
  const threshold = AUTO_MERGE_DELTA_E[settings.autoMerge];
  if (threshold > 0)
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i].color;
      if (inBase.has(a) || settings.keepApart.includes(a)) continue;
      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j].color;
        if (inBase.has(b) || settings.keepApart.includes(b)) continue;
        if (find(b) !== b) continue;
        if (deltaE(a, b) <= threshold) {
          unite(a, b);
          auto.add(b);
        }
      }
    }
  for (const [from, into] of Object.entries(settings.manualMerges)) {
    if (!entries.some((e) => e.color === from) || !entries.some((e) => e.color === into)) continue;
    if (inBase.has(into)) inBase.add(from);
    else if (!inBase.has(from)) unite(into, from);
  }
  const groups = new Map<string, string[]>();
  for (const e of sorted) {
    if (inBase.has(e.color)) continue;
    const r = find(e.color);
    const g = groups.get(r) ?? [];
    g.push(e.color);
    groups.set(r, g);
  }
  const areaOf = (c: string) => entries.find((e) => e.color === c)?.areaMm2 ?? 0;
  const slots: Slot[] = [];
  let index = 2;
  for (const [, colors] of groups) {
    const main = colors.slice().sort((a, b) => areaOf(b) - areaOf(a))[0];
    const depth = settings.depthOverrides[main];
    slots.push({
      index: index++,
      colors,
      printColor: main,
      areaMm2: colors.reduce((s, c) => s + areaOf(c), 0),
      depthMm: depth,
      auto: colors.some((c) => auto.has(c)) && !colors.some((c) => c in settings.manualMerges),
    });
  }
  const body: Slot = { index: 1, colors: [...inBase], printColor: bodyColor, areaMm2: [...inBase].reduce((s, c) => s + areaOf(c), 0), auto: false };
  return { body, slots };
}

export function slotOfColor(plan: SlotPlan, color: string): Slot | undefined {
  if (plan.body.colors.includes(color)) return plan.body;
  return plan.slots.find((s) => s.colors.includes(color));
}
