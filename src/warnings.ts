/**
 * Session notice list, rendered as pills over the viewport. Deduplicated by `key` else `message`
 * (most callers set no `key`). A keyed push replaces its standing entry; an unkeyed one is skipped (see push).
 */
export interface Notice {
  message: string;
  level: 'warn' | 'info';
  /**
   * Set on diagnostics a build regenerates every attempt (assembly.ts, regions.ts, scheduler.ts's
   * failure path). clearBuildWarnings() drops only these, leaving standing facts (a part's load-time
   * fingerprint mismatch, an export placement notice) that nothing re-derives per rebuild.
   */
  build?: boolean;
  /**
   * Dedupe/retraction identity, separate from the displayed text. Needed where the message is
   * templated from user data (a filename) two sources can share, which would collide on
   * message-equality and drop or cross-retract each other's notice. Set only by the raster
   * capped/traced pair, the sliders' empty-trace warning and its restore-failure twin.
   *
   * It also runs the other way, for one fact reached with different numbers: `netTornWarning` is
   * raised per color and two colors can measure different tears across the same pair of sheets;
   * keyed on the pair that is one pill, not two at different sizes. Defaults to `message`.
   */
  key?: string;
}
export const WARNINGS: Notice[] = [];

/**
 * The entry is rewritten in place, never swapped: warningsView.ts's × finds its entry by reference,
 * so a new object would leave a pill dismissing nothing. Unkeyed pushes keep skip-if-present, or
 * `warnBuild(m)` after `warn(m)` would hand a standing fact to the next rebuild.
 */
function push(n: Notice): void {
  const key = n.key ?? n.message;
  const standing = WARNINGS.find((w) => (w.key ?? w.message) === key);
  if (!standing) WARNINGS.push(n);
  else if (n.key !== undefined && standing.key === n.key) {
    standing.message = n.message;
    standing.level = n.level;
    standing.build = n.build;
  }
}

/** Something failed or degraded — rendered as a red pill. Pass `key` per Notice.key. */
export function warn(message: string, key?: string): void {
  push({ message, level: 'warn', key });
}

/** Expected/informational — a quiet pill, not an error. Pass `key` when `message` alone can collide across sources (Notice.key). */
export function notice(message: string, key?: string): void {
  push({ message, level: 'info', key });
}

/** Build-scoped counterpart to warn() — for code that runs fresh every rebuild. Pass `key` where one fact is reached per color with a per-color measurement, so the build states it once (Notice.key). */
export function warnBuild(message: string, key?: string): void {
  push({ message, level: 'warn', build: true, key });
}

/**
 * Build-scoped counterpart to notice(). Takes a `key` like warnBuild: one fact reached from several
 * places states itself once (the clip-remnant notice is raised at three clips and is one thing to the user).
 */
export function noticeBuild(message: string, key?: string): void {
  push({ message, level: 'info', build: true, key });
}

export function clearWarnings(): void {
  WARNINGS.length = 0;
}

/**
 * Retract one notice, matched by `key` when given (Notice.key) else exact message. For a standing
 * diagnostic a later user action can resolve (re-quantizing at a setting that no longer caps detail).
 * clearWarnings() is too broad (drops unrelated standing facts) and clearBuildWarnings() the wrong
 * scope (nothing re-derives these per rebuild).
 */
export function dismissNotice(message: string, key?: string): void {
  const k = key ?? message;
  const i = WARNINGS.findIndex((w) => (w.key ?? w.message) === k);
  if (i >= 0) WARNINGS.splice(i, 1);
}

/** Reset this rebuild attempt's diagnostics — once per pass (scheduler.ts runNow), so a cut-solid warning from a superseded build can't outlive it and still show beside a later successful one. */
export function clearBuildWarnings(): void {
  for (let i = WARNINGS.length - 1; i >= 0; i--) if (WARNINGS[i].build) WARNINGS.splice(i, 1);
}

/** What `dropBuildWarningsSince` measures from: the entries standing now. */
export function warningMark(): ReadonlySet<Notice> {
  return new Set(WARNINGS);
}

/**
 * Drop the build diagnostics pushed since `mark`, for a step whose result was thrown away. A keyed
 * entry rewritten in place since then is not put back: it was standing at the mark, so it stays.
 */
export function dropBuildWarningsSince(mark: ReadonlySet<Notice>): void {
  for (let i = WARNINGS.length - 1; i >= 0; i--)
    if (WARNINGS[i].build && !mark.has(WARNINGS[i])) WARNINGS.splice(i, 1);
}
