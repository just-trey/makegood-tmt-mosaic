/** Session notice list, rendered as pills over the viewport. Deduplicated by message. */
export interface Notice {
  message: string;
  level: 'warn' | 'info';
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

export function clearWarnings(): void {
  WARNINGS.length = 0;
}
