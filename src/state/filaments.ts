import type { Filament } from '../types';
import { hexToRgb } from '../color';

// Fallback palette if public/filaments.json is missing or malformed — kept in sync with it.
const FALLBACK: Filament[] = [
  { id: 'black', name: 'Black', hex: '#0a0a0a' },
  { id: 'white', name: 'White', hex: '#f4f4f2' },
  { id: 'red', name: 'Red', hex: '#c1272d' },
  { id: 'orange', name: 'Orange', hex: '#f07f1a' },
  { id: 'yellow', name: 'Yellow', hex: '#f5d020' },
  { id: 'green', name: 'Green', hex: '#2e8b3d' },
  { id: 'blue', name: 'Blue', hex: '#1e5fa8' },
  { id: 'purple', name: 'Purple', hex: '#7a3fa0' },
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

/** Name of the owned filament closest (RGB distance) to a detected artwork color. */
export function nearestFilamentName(hex: string): string {
  const c = hexToRgb(hex);
  let best = filaments[0]?.name || 'Filament',
    bestD = Infinity;
  for (const f of filaments) {
    const p = hexToRgb(f.hex);
    const d = (c.r - p.r) ** 2 + (c.g - p.g) ** 2 + (c.b - p.b) ** 2;
    if (d < bestD) {
      bestD = d;
      best = f.name;
    }
  }
  return best;
}
