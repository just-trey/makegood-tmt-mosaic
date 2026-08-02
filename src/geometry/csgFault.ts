import { warn } from '../warnings';

/**
 * Forced failures for the CSG degradation branches in assembly.ts, armed from the URL:
 * `?csgfault=difference`, `?csgfault=intersection:1`.
 *
 * Those branches have only ever run under vitest with Manifold's booleans replaced by spies
 * (tests/assembly.test.ts, "CSG failure handling") — never in the real app against the real
 * engine, which is the gap docs/tech-debt.md records. A spy proves the code path; it can't show
 * what a slicer opens afterwards, and that is the half that matters here.
 *
 * Deliberately **not** `import.meta.env.DEV`-gated, for the same reason `window.__mosaic` isn't
 * (src/main.ts): the drive scripts verify `vite preview` output, which is a production build, so
 * a DEV gate would put these branches out of reach of exactly the checks that need them. Arming
 * one is opt-in per page load and announces itself as a standing warning, so a rigged build can't
 * be mistaken for a broken one.
 */
export type CsgFaultPoint =
  'color-union' | 'part-union' | 'difference' | 'body-mesh' | 'intersection';

const POINTS: readonly CsgFaultPoint[] = [
  'color-union',
  'part-union',
  'difference',
  'body-mesh',
  'intersection',
];

function armed(): { point: CsgFaultPoint; limit: number } | null {
  // Tests and the bake scripts run in node, where there is no location to read.
  if (typeof location === 'undefined') return null;
  const raw = new URLSearchParams(location.search).get('csgfault');
  if (!raw) return null;
  const [name, count] = raw.split(':');
  const point = POINTS.find((p) => p === name);
  if (!point) {
    warn(`Unknown ?csgfault=${raw} — expected one of: ${POINTS.join(', ')}.`);
    return null;
  }
  const limit = count === undefined ? Infinity : Number(count);
  if (!(limit > 0)) {
    warn(`?csgfault=${raw} needs a positive count after the colon.`);
    return null;
  }
  return { point, limit };
}

const fault = armed();
let fired = 0;

if (fault) {
  warn(
    `CSG fault injection is armed (?csgfault) — "${fault.point}" will be forced to fail ` +
      `${fault.limit === Infinity ? 'on every part' : `${fault.limit}×`}. Reload without the ` +
      `parameter to build normally.`,
  );
}

/**
 * Throw if this call site is the armed one. A no-op — and free — on every normal page load.
 *
 * Call sites sit where the real failure originates, so the surrounding try/catch and its `finally`
 * do the same work they would for a genuine engine failure: `body-mesh` in particular fires after
 * `Manifold.difference` has already returned a live solid, which is the only way to exercise the
 * freed-handle path rather than just the degradation.
 */
export function csgFault(point: CsgFaultPoint): void {
  if (!fault || fault.point !== point || fired >= fault.limit) return;
  fired++;
  throw new Error(`forced CSG fault: ${point} (?csgfault)`);
}

/**
 * Refill the `:N` budget for a fresh build — the counterpart to clearBuildWarnings(), and needed
 * for the same reason. A count is per rebuild, not per session: loading a second artwork rebuilds
 * from scratch, so a session-wide budget would be spent by an intermediate build and the one left
 * on screen would come out clean, with its predecessor's warning already cleared. That reads as
 * "the fault did nothing" rather than "the fault fired earlier".
 */
export function resetCsgFaults(): void {
  fired = 0;
}
