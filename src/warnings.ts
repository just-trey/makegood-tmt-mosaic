/** Session notice list, rendered as pills over the viewport. Deduplicated by message. */
export interface Notice {
  message: string;
  level: 'warn' | 'info';
  /**
   * Set on diagnostics a build regenerates fresh every attempt (assembly.ts, regions.ts,
   * scheduler.ts's failure path). clearBuildWarnings() drops only these, leaving standing facts —
   * a part's load-time fingerprint mismatch, an export placement notice — in place, since nothing
   * re-derives those every rebuild.
   */
  build?: boolean;
}
export const WARNINGS: Notice[] = [];

function push(n: Notice): void {
  if (!WARNINGS.some((w) => w.message === n.message)) WARNINGS.push(n);
}

/** Something failed or degraded — rendered as a red pill. */
export function warn(message: string): void {
  push({ message, level: 'warn' });
}

/** Expected/informational — rendered as a quiet pill, not an error. */
export function notice(message: string): void {
  push({ message, level: 'info' });
}

/** Build-scoped counterpart to warn() — use inside code that runs fresh every rebuild. */
export function warnBuild(message: string): void {
  push({ message, level: 'warn', build: true });
}

/** Build-scoped counterpart to notice() — use inside code that runs fresh every rebuild. */
export function noticeBuild(message: string): void {
  push({ message, level: 'info', build: true });
}

export function clearWarnings(): void {
  WARNINGS.length = 0;
}

/**
 * Reset just this rebuild attempt's diagnostics — called once per pass (scheduler.ts's runNow),
 * so a cut-solid warning from a superseded build (an earlier zone/mode binding, say) can't outlive
 * the build that produced it and still be showing once a later, successful build is on screen.
 */
export function clearBuildWarnings(): void {
  for (let i = WARNINGS.length - 1; i >= 0; i--) if (WARNINGS[i].build) WARNINGS.splice(i, 1);
}
