/**
 * Shared template "ink" so every generated template (gen-templates.mjs, bake-zones.mjs) reads as
 * one matched set.
 */

/** Printable-surface canvas gray (between old #808080 / #e8e8e8). */
export const GRAY = '#bcbcbc';

/**
 * One blue "guide ink" for every non-printing template mark (labels, hole outlines, seam lines,
 * the cap reference ring). Deep enough to keep small guide text readable on GRAY. Meaning is
 * carried by fill + dash style, not colour.
 */
export const ACCENT = '#1a4f8f';

/** Shared guide-label size (mm) so labels read as one matched set across all templates. */
export const LABEL_SIZE = 8;
