// Pure helpers for hashing the sequence a drive script actually walked, rather than the drive
// script's own file bytes. See scripts/system-audit-drive.mjs's header comment for why: a
// whole-file hash moves on anything that touches the file (a comment, a repointed sample, an
// added captured property that changes what's driven), which voided every state-sensitive (†)
// row in docs/system-audit.md for two runs that drove the identical seven states.
import { createHash } from 'node:crypto';

/**
 * Walk a drive script's `result.states` object into an ordered, value-free description of what
 * it drove: the state names in the order they were recorded, the property keys captured within
 * each, and any element selectors snapshotted (found via the `.selector` field `elementSnapshot`
 * attaches). No measured values — those are expected to change run to run and must not move the
 * hash.
 */
export function driveSequenceOf(states) {
  const sequence = [];
  for (const [state, value] of Object.entries(states ?? {})) {
    const keys =
      value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
    const selectors = [];
    const collectSelectors = (node) => {
      if (!node || typeof node !== 'object') return;
      if (typeof node.selector === 'string') selectors.push(node.selector);
      for (const child of Object.values(node)) collectSelectors(child);
    };
    collectSelectors(value);
    sequence.push({ state, keys, selectors });
  }
  return sequence;
}

/** sha256 of the sequence's JSON, first 16 hex chars — same shape as the old whole-file hash. */
export function hashDriveSequence(sequence) {
  return createHash('sha256').update(JSON.stringify(sequence)).digest('hex').slice(0, 16);
}
