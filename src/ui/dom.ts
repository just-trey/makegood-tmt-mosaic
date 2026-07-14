export function $<T extends Element = HTMLElement>(sel: string): T {
  return document.querySelector(sel) as T;
}

export function $all<T extends Element = HTMLElement>(sel: string): T[] {
  return Array.from(document.querySelectorAll(sel)) as T[];
}

export function input(sel: string): HTMLInputElement {
  return $<HTMLInputElement>(sel);
}

export function numVal(sel: string, fallback = 0): number {
  const v = parseFloat(input(sel).value);
  return Number.isFinite(v) ? v : fallback;
}
