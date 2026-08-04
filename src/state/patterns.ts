import type { PatternEntry } from '../types';

let patterns: PatternEntry[] = [];

/**
 * Whether the built-in pattern library is offered in the UI. Off while the library is reworked
 * (see docs/tech-debt.md): the assets, the generator and Fill mode itself all stay — this only
 * withholds the picker strip, which renders from whatever this module loaded, so leaving the
 * list empty is the same state a missing manifest already produces. Flip to `true` to offer it
 * again.
 */
export const PATTERN_LIBRARY_ENABLED = false;

/**
 * Load the built-in pattern library manifest (public/patterns/patterns.json). Purely additive
 * like loadPartsLibrary — a missing/unreachable manifest just leaves the picker strip empty,
 * it never blocks upload-your-own-SVG fills.
 */
export async function loadPatterns(): Promise<PatternEntry[]> {
  if (!PATTERN_LIBRARY_ENABLED) return patterns;
  try {
    // Same cache-busting idiom as stl/parts.json (src/assembly/parts.ts) — a stable URL that
    // isn't content-hashed, tagged with the app version so a returning visitor's cached
    // pre-release manifest can't lag behind a bundle that already knows about a newer pattern.
    const v = typeof __APP_VERSION__ === 'undefined' ? 'dev' : __APP_VERSION__;
    const res = await fetch(`patterns/patterns.json?v=${v}`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.every((p) => p && p.id && p.name && p.file)) {
        patterns = data;
      }
    }
  } catch {
    /* no manifest present — silently do nothing, this is optional */
  }
  return patterns;
}

export function getPatterns(): PatternEntry[] {
  return patterns;
}
