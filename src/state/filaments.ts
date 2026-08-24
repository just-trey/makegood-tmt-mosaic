import type { Filament } from '../types';
import { hexToLab, deltaE } from '../color';

// Fallback palette if public/filaments.json is missing or malformed — kept in sync with it.
const FALLBACK: Filament[] = [
  { id: 'black', name: 'Black', hex: '#0a0a0a' },
  { id: 'white', name: 'White', hex: '#f4f4f2' },
  { id: 'red', name: 'Red', hex: '#c1272d' },
  { id: 'orange', name: 'Orange', hex: '#f07f1a' },
  { id: 'yellow', name: 'Yellow', hex: '#f5d020' },
  { id: 'green', name: 'Green', hex: '#2e8b3d' },
  { id: 'cyan', name: 'Cyan', hex: '#12a9c4' },
  { id: 'blue', name: 'Blue', hex: '#1e5fa8' },
  { id: 'purple', name: 'Purple', hex: '#7a3fa0' },
  { id: 'magenta', name: 'Magenta', hex: '#c8158c' },
  { id: 'pink', name: 'Pink', hex: '#e8639e' },
  { id: 'brown', name: 'Brown', hex: '#6b4a2f' },
  { id: 'grey', name: 'Grey', hex: '#8a8f94' },
  { id: 'gold', name: 'Gold', hex: '#cfa03a' },
  { id: 'silver', name: 'Silver', hex: '#c6cdd1' },
];

let filaments: Filament[] = FALLBACK;

/** Load the owned-filament palette from public/filaments.json (editable without code changes). */
export async function loadFilaments(): Promise<Filament[]> {
  try {
    const res = await fetch('filaments.json');
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length && data.every((f) => f && f.id && f.name && f.hex)) {
        filaments = data;
      }
    }
  } catch {
    /* keep fallback */
  }
  return filaments;
}

export function getFilaments(): Filament[] {
  return filaments;
}

export function getFilament(id: string | null): Filament | undefined {
  return id ? filaments.find((f) => f.id === id) : undefined;
}

/**
 * Name of the owned filament closest (Lab deltaE) to a detected artwork color. Lab, not RGB:
 * plain RGB distance conflates hue/saturation with brightness, so a saturated mid-brightness
 * color (a cyan) can land numerically closer to a similarly-bright grey than to a much darker
 * blue, even though it reads as blue to the eye.
 *
 * Always returns a name, even a distant one — there's no "no match" cutoff, because no deltaE
 * threshold has a real number behind it. When a color category reads as visibly wrong (cyan
 * matching Grey, magenta matching Pink), the fix that shipped was adding that category as its
 * own swatch, not guessing a threshold.
 */
export function nearestFilamentName(hex: string): string {
  const c = hexToLab(hex);
  let best = filaments[0]?.name || 'Filament',
    bestD = Infinity;
  for (const f of filaments) {
    const d = deltaE(c, hexToLab(f.hex));
    if (d < bestD) {
      bestD = d;
      best = f.name;
    }
  }
  return best;
}
