import { warn } from '../warnings';

/**
 * Forced failures for partBuild.ts's CSG degradation branches, armed from the URL
 * (`?csgfault=difference`, `?csgfault=intersection:1`). Otherwise those run only under vitest with
 * spied booleans (tests/assembly.test.ts, "CSG failure handling"), which can't show what a slicer
 * opens; scripts/check-csg-failure.mjs drives these and asserts the result.
 * Deliberately **not** `import.meta.env.DEV`-gated, like `window.__mosaic` (src/main.ts): the drive
 * scripts check `vite preview`, a production build. Arming is opt-in per load and re-announced
 * every build (announce()), so a rigged build can't be mistaken for a broken one.
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

let announcement: string | null = null;

function armed(): { point: CsgFaultPoint; limit: number } | null {
  // Tests and the bake scripts run in node, where there is no location to read.
  if (typeof location === 'undefined') return null;
  const raw = new URLSearchParams(location.search).get('csgfault');
  if (!raw) return null;
  const [name, count] = raw.split(':');
  const point = POINTS.find((p) => p === name);
  if (!point) {
    announcement = `Unknown ?csgfault=${raw}, expected one of: ${POINTS.join(', ')}.`;
    return null;
  }
  const limit = count === undefined ? Infinity : Number(count);
  if (!(limit > 0)) {
    announcement = `?csgfault=${raw} needs a positive count after the colon.`;
    return null;
  }
  announcement =
    `CSG fault injection is armed (?csgfault): "${point}" will be forced to fail ` +
    `${limit === Infinity ? 'on every part' : `${limit}×`}. Reload without the ` +
    `parameter to build normally.`;
  return { point, limit };
}

const fault = armed();
let fired = 0;

/**
 * (Re-)state the armed notice; warn() dedupes, so per build is free. Re-emitted, not pushed once at
 * import: a user SVG load's clearWarnings() (applyParsedSVG, src/ui/artworkPanel.ts) drops standing
 * notices too, so an import-time notice is gone by the build where the fault fires.
 */
function announce(): void {
  if (announcement) warn(announcement);
}

announce();

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
 * Refill the `:N` budget per rebuild, like clearBuildWarnings(): a session-wide budget would be
 * spent by an intermediate build, leaving the on-screen one clean with its predecessor's warning
 * cleared, which reads as "the fault did nothing". Also re-states the armed notice the same artwork
 * load cleared (announce()).
 */
export function resetCsgFaults(): void {
  fired = 0;
  announce();
}
