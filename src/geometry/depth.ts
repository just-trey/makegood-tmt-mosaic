import type { ColorSettings } from '../types';

/**
 * One typical layer, the default profile on every printer this targets. Two uses:
 * - The fallback for a request under MIN_HONORED_DEPTH_MM, which must print: a 0.02 mm fallback (a
 *   boolean tolerance) sliced to nothing yet cost an AMS slot.
 * - The threshold below which a recess *may* not print: a quiet note, not a clamp. Someone on a
 *   0.08 mm profile can cut a 0.12 mm recess, which clamping to 0.2 mm would forbid
 *   (docs/audience.md).
 */
export const MIN_CUT_DEPTH_MM = 0.2;

/** One fine layer: Bambu Studio's min_layer_height for a 0.2 mm nozzle (BBL machine profiles). */
export const MIN_HONORED_DEPTH_MM = 0.04;

/**
 * Whether a requested depth is raised to MIN_CUT_DEPTH_MM: under one fine layer it prints on no
 * profile yet still costs a slot. Read at printed precision, so a 0.038 that reads "0.04" in its
 * field is honored rather than raised under a warning quoting "under 0.04 mm".
 */
export function raisesDepth(requested: number): boolean {
  return Number(requested.toFixed(2)) < MIN_HONORED_DEPTH_MM;
}

/** A depth as the field and messages print it: 2dp, except a nonzero 0.001 shown as "0.00". */
export function formatDepth(depth: number): string {
  const fixed = depth.toFixed(2);
  return depth !== 0 && Number(fixed) === 0 ? String(Number(depth.toPrecision(2))) : fixed;
}

/**
 * Nozzle width in mm: what a printer can lay down at all. Here, not in raster/stats.ts, because
 * the trace despeckle and the assembly clip need the same physical fact.
 */
export const NOZZLE_MM = 0.4;

/**
 * Smallest clipped region a cutter is built from, mm²: one nozzle square, which cannot hold a
 * single extrusion of any shape — deliberately the weakest claim about a feature size. It catches
 * the hairline an along-edge clip hands back (dropUnprintableRemnants): on the chair's Front zone
 * the `chair-seat-back-top` remnant was 0.025mm², 0.02mm wide and 8mm long, against 1,258 to
 * 3,029mm² for every other chart the design reaches.
 *
 * That margin is part geometry's. Against real design ink (four fixture patterns, Fill, real parts)
 * 9.4% of pieces (760 of 8,056) fall under the floor, 86% of them zebra, and the narrowest survivor
 * is 0.1600478mm², 1.00003x this value: docs/findings/2026-09-27-clip-ink-sweep.md,
 * `RUN_CLIP_INK_SWEEP=1 npx vitest run scripts/measure-clip-ink.test.ts`. Dust or drawn detail is
 * open: docs/tech-debt.md, "Whether a near-floor clipped-ink piece is dust or a drawn detail is
 * unmeasured".
 */
export const CLIP_REMNANT_FLOOR_MM2 = NOZZLE_MM * NOZZLE_MM;

/**
 * Material a clamped recess leaves behind. Clamping to the bare extent put the cutter floor
 * coplanar with the back face: a through-hole reported as a recess "cut at 48.50 mm".
 */
export const CUT_FLOOR_MM = 0.05;

/**
 * Compare depths at the precision the warnings print (2dp), rounding as the message does: at
 * machine epsilon a 3.951 mm request reports "set to 3.95 mm … cut at 3.95 mm instead", and a 0.005
 * epsilon lets 0.195 pass yet print as "0.20".
 */
export const depthDiffers = (a: number, b: number): boolean => a.toFixed(2) !== b.toFixed(2);

/**
 * How a warning names a region: the way its color row reads, a merged group's "Merged (N)" (its
 * dominant hex appears nowhere as text) or the filament name beside the hex. The hex stays in the
 * label: it keeps two colors that round to one filament apart as tally keys. `name` is absent when
 * the caller has no filament list, and the bare hex is all there is to say.
 */
export function regionLabel(
  color: string,
  isMerge: boolean,
  memberCount: number,
  name?: string,
): string {
  if (isMerge) return `Merged (${memberCount})`;
  return name ? `${name} (${color})` : color;
}

/**
 * Up to three parts by name, past that a count: the line stays one line however many parts a
 * color reaches (the chair has nineteen), and the cut-at number it quotes carries what the names
 * would.
 */
export function partsPhrase(names: string[]): string {
  if (names.length > 3) return `${names.length} parts`;
  const quoted = names.map((n) => `"${n}"`);
  return quoted.length < 2
    ? quoted.join('')
    : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`;
}

/**
 * Describes the *setting* and the raise, never the cut: a cutThrough mapper holes any depth the
 * whole way, so "would cut nothing" could be false. Takes every color at once: a global Depth of 0
 * raises every row, and an imported photo starts with DEFAULT_RASTER_COLORS of them.
 */
export function zeroDepthWarning(labels: string[], requested: number, raisedTo: number): string {
  const one = labels.length === 1;
  const which = labels.map((l) => `"${l}"`).join(', ');
  return (
    `${one ? 'Depth' : 'Depths'} for ${which} ${one ? 'was' : 'were'} set to ` +
    `${formatDepth(requested)} mm. Under ${MIN_HONORED_DEPTH_MM.toFixed(2)} mm is too shallow ` +
    `to print, so ${one ? 'it was' : 'they were'} raised to ${raisedTo.toFixed(2)} mm.`
  );
}

export interface ZeroDepthRaise {
  requested: number;
  raisedTo: number;
  labels: string[];
}

/**
 * Stage one color's raise for one end-of-build message, keyed by both numbers as printed:
 * `requested` is per color, and merging pairs would misquote. `raisedTo` too, though nothing varies
 * it today (maxCutDepth() declines rather than returning below MIN_CUT_DEPTH_MM). A label is staged
 * once per pair, so a color on several parts is mentioned once.
 */
export function addZeroDepthRaise(
  into: Map<string, ZeroDepthRaise>,
  label: string,
  requested: number,
  raisedTo: number,
): void {
  const key = `${formatDepth(requested)}|${raisedTo.toFixed(2)}`;
  const at = into.get(key);
  if (!at) into.set(key, { requested, raisedTo, labels: [label] });
  else if (!at.labels.includes(label)) at.labels.push(label);
}

/** One kind of clamp at one requested depth across every part: a line per part buried the chair's. */
export interface ClampGroup {
  requested: number;
  /** every color clamped at this depth on any part in the group, so not each on each part */
  labels: string[];
  /** the part names, each once */
  partNames: string[];
  /** the shallowest cut across the group */
  cutAt: number;
  cutVaries: boolean;
  /** the thinnest wall, for thin-wall clamps */
  wall?: number;
  wallVaries: boolean;
}

/** Fold staged clamps into one group per requested depth. */
export function groupClamps(clamps: Iterable<PartDepthClamp>): ClampGroup[] {
  const groups = new Map<string, ClampGroup>();
  for (const c of clamps) {
    const key = c.requested.toFixed(2);
    const at = groups.get(key);
    if (!at) {
      groups.set(key, {
        requested: c.requested,
        labels: [...c.labels],
        partNames: [c.partName],
        cutAt: c.cutAt,
        cutVaries: false,
        wall: c.wall,
        wallVaries: false,
      });
      continue;
    }
    for (const l of c.labels) if (!at.labels.includes(l)) at.labels.push(l);
    if (!at.partNames.includes(c.partName)) at.partNames.push(c.partName);
    if (depthDiffers(at.cutAt, c.cutAt)) at.cutVaries = true;
    at.cutAt = Math.min(at.cutAt, c.cutAt);
    if (c.wall != null) {
      if (at.wall != null && depthDiffers(at.wall, c.wall)) at.wallVaries = true;
      at.wall = at.wall == null ? c.wall : Math.min(at.wall, c.wall);
    }
  }
  return [...groups.values()];
}

function clampLead(g: ClampGroup): { one: boolean; lead: string; tail: string } {
  const one = g.labels.length === 1;
  const which = g.labels.map((l) => `"${l}"`).join(', ');
  const tail =
    `${one ? 'It was' : 'They were'} cut ` +
    (g.cutVaries
      ? `shallower instead, as little as ${g.cutAt.toFixed(2)} mm.`
      : `at ${g.cutAt.toFixed(2)} mm instead.`);
  return {
    one,
    lead: `${one ? 'Depth' : 'Depths'} for ${which} ${one ? 'was' : 'were'} set to ${g.requested.toFixed(2)} mm`,
    tail,
  };
}

/**
 * The warning for a depth deeper than the part has material. Names the parts: the same setting can
 * be fine on the wheel and clamped on the cap. **Not the wall check** (thinWallWarning). Says what
 * it cut, not the part's depth: the cut stops CUT_FLOOR_MM short of it, so one figure can't be both.
 */
export function tooDeepWarning(g: ClampGroup): string {
  const { lead, tail } = clampLead(g);
  const goes = g.partNames.length === 1 ? 'goes' : 'go';
  return `${lead}, deeper than ${partsPhrase(g.partNames)} ${goes}. ${tail}`;
}

/**
 * The warning for a depth deeper than the wall under a region, where the part as a whole had room.
 * Quotes the wall as well as the cut: the cut stops CUT_FLOOR_MM short of it, or at
 * MIN_CUT_DEPTH_MM over a wall thinner than that, so neither number stands for the other.
 */
export function thinWallWarning(g: ClampGroup): string {
  const { one, lead, tail } = clampLead(g);
  const is = g.partNames.length === 1 ? 'is' : 'are';
  const thick = `${g.wallVaries ? 'as thin as' : 'only'} ${g.wall!.toFixed(2)} mm${g.wallVaries ? '' : ' thick'}`;
  return `${lead}, but ${partsPhrase(g.partNames)} ${is} ${thick} under ${one ? 'it' : 'them'}. ${tail}`;
}

export interface PartDepthClamp {
  requested: number;
  cutAt: number;
  labels: string[];
  partName: string;
  /** the wall under the colors, for a clamp by the wall rather than the part */
  wall?: number;
}

/**
 * Stage one color's too-deep clamp for a single message at the end of the build. Keyed like
 * addZeroDepthRaise, by both numbers the message prints (any row can carry its own depth), plus the
 * part: `maxCutDepth()` is a per-part bound, so two parts can genuinely clamp the same color to two
 * different depths, and the message has to keep naming the part.
 */
export function addPartTooDeepClamp(
  into: Map<string, PartDepthClamp>,
  label: string,
  partName: string,
  requested: number,
  cutAt: number,
  wall?: number,
): void {
  const key = `${requested.toFixed(2)}|${cutAt.toFixed(2)}|${wall?.toFixed(2)}|${partName}`;
  const at = into.get(key);
  if (!at) into.set(key, { requested, cutAt, partName, labels: [label], wall });
  else if (!at.labels.includes(label)) at.labels.push(label);
}

/**
 * Whether a depth merits a note, asked at the printed precision: a 0.199 mm cut announced "is
 * 0.20 mm, thinner than the usual 0.20 mm print layer". Same reasoning as depthDiffers.
 */
export function subLayerDepth(depth: number): boolean {
  return depth < MIN_CUT_DEPTH_MM && depthDiffers(depth, MIN_CUT_DEPTH_MM);
}

/**
 * The note for a depth that prints only on a fine profile. **`ℹ`, not `⚠` — proposed and rejected
 * (UX review 2026-08-03).** The icon tracks "did the app change your number?": zero is raised and
 * too-deep clamped, so both warn; a positive sub-layer depth is honored (a 0.12 mm recess on a
 * 0.08 mm profile is a real choice, docs/audience.md), and warning on obeyed values erodes the real
 * `⚠`s. Owner decision (batch F, 2026-11): under one fine layer (raisesDepth) is raised and warned
 * like 0; 0.04-0.19 stays honored with this note.
 */
export function thinDepthNotice(label: string, depth: number): string {
  return (
    `Depth for "${label}" is ${depth.toFixed(2)} mm, thinner than the usual ` +
    `${MIN_CUT_DEPTH_MM.toFixed(2)} mm print layer. It will only show up if your slicer ` +
    `profile uses a layer height finer than that.`
  );
}

/**
 * The note for colours reaching the part's outer edge, cut full thickness instead of their recess.
 * **ℹ, against thinDepthNotice's rule, deliberately**: the setting still holds on the colour's
 * interior (narrowed, not discarded), and this fires on the ordinary path (every hubcap cut to
 * shape with artwork at the rim), where a ⚠ would bury the real ones. Names the colors so a
 * deliberate depth is checkable. Would change on reports of unwanted through-cuts — then a
 * per-color opt-out, not a louder icon.
 */
export function edgeCutThroughNotice(labels: string[], depth: number): string {
  const one = labels.length === 1;
  const which = labels.map((l) => `"${l}"`).join(', ');
  return (
    `${one ? 'Color' : 'Colors'} ${which} ${one ? 'reaches' : 'reach'} the part's outer edge, so ` +
    `${one ? 'that region cuts' : 'those regions cut'} the full ${depth.toFixed(2)} mm through. The rim ` +
    `prints in ${one ? 'that color' : 'those colors'}, not the base color. Interior regions still cut at their recess depth.`
  );
}

/**
 * The depth a region was *asked* to cut at, before any clamp. A stored `0` is a real answer, not a
 * missing one: `|| globalDepth` read it as unset and substituted the default, so a
 * deliberately-typed 0 cut at a depth nobody chose. Only absent or non-finite falls back.
 */
export function requestedDepth(
  colorSettings: ColorSettings,
  globalDepth: number,
  key: string,
): number {
  const set = colorSettings[key] && colorSettings[key].depth;
  return typeof set === 'number' && Number.isFinite(set) ? set : globalDepth;
}
