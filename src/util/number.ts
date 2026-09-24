/**
 * Every number that comes from outside the program — user-typed input, an SVG/CSS attribute, a
 * URL param, persisted JSON — should be parsed through one of these, never a bare
 * parseFloat/parseInt/Number. Both return `null` for "not a number" instead of `NaN`, so the type
 * checker forces the caller to handle the invalid case rather than letting a silent NaN propagate.
 * A convention, not a lint rule — no ESLint rule in the current plugin ecosystem catches an
 * unguarded parseFloat/Number/unary-`+`, and a custom one was ruled out as too much machinery for
 * one check. See CLAUDE.md's "Mechanical rules" paragraph.
 */
export function toFiniteNumber(value: string | null | undefined): number | null {
  if (value == null) return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/** Integer counterpart of {@link toFiniteNumber}, e.g. for a slider or select whose value is a
 * whole number. Radix defaults to 10 so a leading `0` is never read as octal. */
export function toFiniteInt(value: string | null | undefined, radix = 10): number | null {
  if (value == null) return null;
  const n = parseInt(value, radix);
  return Number.isFinite(n) ? n : null;
}
