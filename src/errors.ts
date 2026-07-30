/**
 * True for a genuine JS call-stack overflow, not just any RangeError (e.g. an invalid array
 * length or a numeric range check) — V8 doesn't expose a dedicated subtype for it, so the
 * message text is the only distinguishing signal.
 */
export function isStackOverflow(e: unknown): e is RangeError {
  return e instanceof RangeError && /call stack/i.test(e.message);
}

/** Rethrow a stack overflow as a message naming what was nested too deep; anything else passes through untouched. */
export function rethrowStackOverflowAs(e: unknown, message: string): never {
  if (isStackOverflow(e)) throw new Error(message, { cause: e });
  throw e;
}
