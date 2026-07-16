/**
 * Rebuild progress reporting. A long boolean rebuild yields to the browser periodically and
 * calls reportProgress() so the "Rebuilding…" curtain can show a live percentage instead of
 * a frozen line. Mirrors the warnings.ts singleton pattern: geometry code reports, the UI (the
 * scheduler) installs a sink around each rebuild and clears it after.
 */
type Sink = (fraction: number) => void;
let sink: Sink | null = null;

export function setProgressSink(fn: Sink | null): void {
  sink = fn;
}

/** Report rebuild progress in [0, 1]. No-op when nothing is listening. */
export function reportProgress(fraction: number): void {
  sink?.(Math.max(0, Math.min(1, fraction)));
}
