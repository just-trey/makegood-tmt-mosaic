import type { PatternEntry } from '../types';

let patterns: PatternEntry[] = [];

/** Whether the built-in pattern library is offered in the UI. The strip renders from what this module loaded, so off is an empty list — the state a missing manifest produces. Why it's off: docs/tech-debt.md. */
export const PATTERN_LIBRARY_ENABLED = false;

function isPatternList(v: unknown): v is PatternEntry[] {
  return (
    Array.isArray(v) &&
    (v as unknown[]).every((p) => {
      if (typeof p !== 'object' || p === null) return false;
      const c = p as Partial<PatternEntry>;
      return (
        typeof c.id === 'string' &&
        !!c.id &&
        typeof c.name === 'string' &&
        !!c.name &&
        typeof c.file === 'string' &&
        !!c.file
      );
    })
  );
}

/** Load the built-in pattern manifest (public/patterns/patterns.json). Additive like loadPartsLibrary: a missing manifest leaves the strip empty and never blocks upload-your-own-SVG fills. */
export async function loadPatterns(): Promise<PatternEntry[]> {
  if (!PATTERN_LIBRARY_ENABLED) return patterns;
  try {
    // Same cache-busting idiom as stl/parts.json (src/assembly/parts.ts): a stable non-hashed URL tagged with the app version, so a returning visitor's cached pre-release manifest can't lag a bundle that knows newer patterns.
    const v = typeof __APP_VERSION__ === 'undefined' ? 'dev' : __APP_VERSION__;
    const res = await fetch(`patterns/patterns.json?v=${v}`);
    if (res.ok) {
      const data: unknown = await res.json();
      if (isPatternList(data)) {
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
