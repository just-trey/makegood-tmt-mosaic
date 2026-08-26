import { warn } from '../warnings';

/**
 * Forced failures for the CSG degradation branches in assembly.ts, armed from the URL:
 * `?csgfault=difference`, `?csgfault=intersection:1`.
 *
 * Those branches otherwise only run under vitest with Manifold's booleans replaced by spies
 * (tests/assembly.test.ts, "CSG failure handling"), never in the real app against the real engine.
 * A spy proves the code path; it can't show what a slicer opens afterwards, and that is the half
 * that matters here. scripts/check-csg-failure.mjs is what drives these and asserts the result.
 *
 * Deliberately **not** `import.meta.env.DEV`-gated, for the same reason `window.__mosaic` isn't
 * (src/main.ts): the drive scripts verify `vite preview` output, which is a production build, so
 * a DEV gate would put these branches out of reach of exactly the checks that need them. Arming
 * one is opt-in per page load and announces itself as a warning re-stated on every build (see
 * announce()), so a rigged build can't be mistaken for a broken one.
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
 * (Re-)state the armed notice. warn() dedupes by message, so calling it per build is free.
 *
 * It has to be re-emitted rather than pushed once at import: loading an SVG calls clearWarnings()
 * (src/svg/parse.ts), which drops standing notices as well as build ones — so a notice pushed at
 * import survives only until the first artwork lands, and is gone by the build where the fault
 * actually fires. That is the one state where "a rigged build can't be mistaken for a broken one"
 * has to hold.
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
 * Refill the `:N` budget for a fresh build — the counterpart to clearBuildWarnings(), and needed
 * for the same reason. A count is per rebuild, not per session: loading a second artwork rebuilds
 * from scratch, so a session-wide budget would be spent by an intermediate build and the one left
 * on screen would come out clean, with its predecessor's warning already cleared. That reads as
 * "the fault did nothing" rather than "the fault fired earlier".
 *
 * Also where the armed notice is re-stated, since the same artwork load that starts this build
 * cleared it — see announce().
 */
export function resetCsgFaults(): void {
  fired = 0;
  announce();
}
