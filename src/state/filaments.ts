import type { Filament } from '../types';
import { hexToLab, deltaE, type Lab } from '../color';

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
// Parallel to `filaments`, one Lab conversion per entry. The palette is static between loads, and
// nearestFilamentName runs once per detected color on every rebuild, so this is computed on
// palette change rather than redone on every lookup.
let filamentLabs: Lab[] = FALLBACK.map((f) => hexToLab(f.hex));

function setFilaments(list: Filament[]): void {
  filaments = list;
  filamentLabs = list.map((f) => hexToLab(f.hex));
}

/** Load the owned-filament palette from public/filaments.json (editable without code changes). */
export async function loadFilaments(): Promise<Filament[]> {
  try {
    const res = await fetch('filaments.json');
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length && data.every((f) => f && f.id && f.name && f.hex)) {
        setFilaments(data);
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
 * Name of the owned filament closest to a color, by Lab deltaE rather than RGB distance (RGB
 * conflates hue with brightness, e.g. ranking Grey over Blue for a saturated cyan). Always
 * returns something: there's no distance cutoff, since no threshold has a measurement behind
 * it. A wrong-looking match gets fixed by adding that hue as its own swatch (see Cyan, Magenta).
 */
export function nearestFilamentName(hex: string): string {
  const c = hexToLab(hex);
  let best = filaments[0]?.name || 'Filament',
    bestD = Infinity;
  for (let i = 0; i < filaments.length; i++) {
    const d = deltaE(c, filamentLabs[i]);
    if (d < bestD) {
      bestD = d;
      best = filaments[i].name;
    }
  }
  return best;
}
