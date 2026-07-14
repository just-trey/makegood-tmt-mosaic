/** Session warning list, rendered as pills over the viewport. Deduplicated by message. */
export const WARNINGS: string[] = [];

export function warn(msg: string): void {
  if (!WARNINGS.includes(msg)) WARNINGS.push(msg);
}

export function clearWarnings(): void {
  WARNINGS.length = 0;
}
