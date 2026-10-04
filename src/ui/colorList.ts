import { addToBase, baseColorHex, removeFromBase, state } from '../state/store';
import { MIN_CUT_DEPTH_MM, depthDiffers, requestedDepth } from '../geometry/depth';
import { scheduleRebuild } from '../app/scheduler';
import { nearestFilamentName } from '../state/filaments';
import { getPrinter } from '../export/printers';
import { refreshSlotBudgetNotice, slotTier } from './slotBudget';
import { $, $all } from './dom';
import { refreshDepthOverrides } from './depthPanel';

export interface ColorListEntry {
  color: string;
  key: string;
  members: string[];
  isMergeGroup: boolean;
  areaPct: number;
  /** printed in the body instead of cut — a distinct status row, no depth/merge controls */
  isBase?: boolean;
  /**
   * The depth the build actually cut this row at, display-only (docs/tech-debt.md). Never fed back
   * into colorSettings or compared with the requested depth: that pinned every row to its clamped
   * depth and silenced the global Depth field (see `shownDepth`). Absent on the Base row.
   */
  appliedDepth?: number;
}

export function groupContaining(hex: string): string[] | null {
  return state.mergeGroups.find((g) => g.includes(hex)) || null;
}

/** Merge an explicit set of raw hexes into one group, folding in any existing groups they touch.
 * An explicit merge outranks an earlier pull-out pin, so it clears one. */
export function mergeHexes(hexes: string[]): void {
  const merged = new Set(hexes.filter(Boolean));
  if (merged.size < 2) return;
  state.mergeGroups = state.mergeGroups.filter((g) => {
    if (g.some((h) => merged.has(h))) {
      g.forEach((h) => merged.add(h));
      return false;
    }
    return true;
  });
  state.mergeGroups.push(Array.from(merged));
  merged.forEach((h) => {
    const idx = state.keptApart.indexOf(h);
    if (idx !== -1) state.keptApart.splice(idx, 1);
  });
  scheduleRebuild();
}

/** Pull one color out of its group, leaving the rest merged, and pin it so the auto-merge slider won't re-swallow it. Dragging it back onto a group (or clearKeptApart) clears the pin. */
export function pullFromGroup(hex: string): void {
  state.mergeGroups = state.mergeGroups
    .map((g) => g.filter((h) => h !== hex))
    .filter((g) => g.length >= 2); // a group of 1 isn't a merge anymore
  if (!state.keptApart.includes(hex)) state.keptApart.push(hex);
  scheduleRebuild();
}

/** Un-pin a color so the auto-merge slider can consider it again. */
export function clearKeptApart(hex: string): void {
  const idx = state.keptApart.indexOf(hex);
  if (idx !== -1) {
    state.keptApart.splice(idx, 1);
    scheduleRebuild();
  }
}

/** Makes a row a valid drop target for growing the base: a drop calls addToBase instead of mergeHexes, whether or not the base has members. */
function wireBaseDropTarget(row: HTMLElement): void {
  row.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';
    row.classList.add('drop-target');
  });
  row.addEventListener('dragleave', (e) => {
    if (!row.contains(e.relatedTarget as Node)) row.classList.remove('drop-target');
  });
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    row.classList.remove('drop-target');
    const src = (e.dataTransfer!.getData('text/plain') || '').split(',').filter(Boolean);
    addToBase(src);
    scheduleRebuild();
  });
}

/** The Base row: pinned at the top, shows every color grouped into it (dominant = body color) with a "×" to send one back to being cut, and is a drop target. Its swatch is the body colour, which is why the empty row below shows one too. */
function renderBaseRow(list: HTMLElement, c: ColorListEntry): void {
  const row = document.createElement('div');
  row.className = 'color-row is-base';
  const membersHtml = `<div class="merge-members">${c.members
    .map(
      (h) =>
        `<button type="button" class="member-swatch" data-remove-base="${h}" style="background:${h}" title="Cut ${h} as a recess again"><span class="member-x">×</span></button>`,
    )
    .join('')}</div>`;
  row.innerHTML = `
    <div class="top">
      <div class="swatch" style="background:${c.color}" title="Prints as this color (the base's main color)"></div>
      <div class="hex">Base: prints as the body</div>
      <div class="area">${c.areaPct.toFixed(1)}%</div>
    </div>
    ${membersHtml}`;
  row.querySelectorAll<HTMLElement>('[data-remove-base]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeFromBase(btn.dataset.removeBase!);
      scheduleRebuild();
    });
  });
  wireBaseDropTarget(row);
  list.appendChild(row);
}

/**
 * Shown instead of the Base row when nothing's grouped into it, so the empty state reads as a common
 * choice, not a gap. Still a drop target (same as "→ base").
 *
 * Carries the body colour as a swatch rather than naming the panel that sets it: convention 4 bars
 * a control's explanation from pointing at another panel, and this row was the live instance ("body
 * uses the blank color set in Part"). Same state value the Part picker writes.
 */
function renderEmptyBaseRow(list: HTMLElement): void {
  const row = document.createElement('div');
  row.className = 'color-row is-base is-base-empty';
  const body = baseColorHex();
  row.innerHTML = `
    <div class="top">
      <div class="swatch" style="background:${body}" title="The body prints in ${body}"></div>
      <div class="hex hint">Base (empty): the body prints in this color</div>
    </div>`;
  wireBaseDropTarget(row);
  list.appendChild(row);
}

/**
 * The depth-reset "↺" is wired once on the list container, not per button: editing the depth field
 * schedules a rebuild that replaces the list's innerHTML, so a listener on the previous render's
 * button sits on a node detached mid-gesture and the reset silently does nothing.
 *
 * The press is split across three events, each covering a case the others get wrong:
 *
 * - `mousedown` only holds the gesture open. It can't clear anything: a press dragged off the button
 *   and released is a cancel, raises no click, and must leave the row as it was.
 * - `mouseup` clears, only when it lands on the button the press started on. Preferred over `click`
 *   because click goes to the nearest common ancestor of the two targets, so a rebuild swapping the
 *   button mid-press sends it to a container. mouseup goes to whatever button is under the pointer,
 *   and the replacement carries the same reset key.
 * - `click` covers keyboard activation, which raises neither of the above.
 *
 * All three are idempotent: the first removes the override and the rest read its absence as
 * "already handled" — except `click` after a real mouse gesture, which needs its own guard against
 * the same swap race (`mouseHandled`).
 *
 * Why it sits where it does is on `.color-row .depth-reset` in styles.css. Measurements from the
 * 2026-08-03 placement review that the CSS doesn't carry:
 *
 * - The ↺'s left edge measured 168px on all four rows of a four-color list, since everything left of
 *   it is fixed width. **This depends on that**: anything variable-width left of it (a longer label,
 *   a per-row badge) breaks the column.
 * - Rejected: the unit inside the field (`[2.40 mm]`) collides with Chrome's number-input spinners,
 *   which this app doesn't suppress; the unit before the value (`depth mm [2.40]`) reads wrongly.
 * - Never checked on touch, or at the 900px minimum width.
 */
function wireDepthReset(list: HTMLElement): void {
  if (list.dataset.depthResetWired) return;
  list.dataset.depthResetWired = '1';
  // Which row's "↺" the press started on, so releasing on another one, or on nothing, cancels instead of resetting whatever is under the pointer.
  let pressedKey: string | null = null;
  let mouseHandled = false;

  const buttonFor = (e: Event): HTMLElement | null => {
    const btn = (e.target as HTMLElement | null)?.closest?.('.depth-reset') as HTMLElement | null;
    // Primary button only: a context-menu press would count as a reset, and no click follows a right- or middle-press to undo it.
    return !btn || (e as MouseEvent).button > 0 ? null : btn;
  };

  const clearOverride = (btn: HTMLElement, key: string): void => {
    if (!(key in state.colorSettings)) return;
    // Abandon whatever is half-typed in this row: the blur below would fire its pending change and re-store the override being cleared.
    btn
      .closest('.color-row')
      ?.querySelector<HTMLInputElement>('.depth-input')
      ?.setAttribute('data-abandoned', '1');
    // Settle a half-typed edit in *another* row now: mousedown suppressed the blur that would commit
    // it, so it would sit pending until the rebuild removes the field, and Chrome's change-on-removal
    // lands mid-render after this pass read colorSettings, costing a second full rebuild. Blurring
    // here puts it in this tick, where the debounce folds it into one.
    const focused = document.activeElement;
    if (focused instanceof HTMLInputElement && focused.classList.contains('depth-input'))
      focused.blur();
    delete state.colorSettings[key];
    scheduleRebuild();
  };

  list.addEventListener('mousedown', (e) => {
    const btn = buttonFor(e);
    pressedKey = btn?.dataset.resetKey ?? null;
    if (!btn) return;
    // Hold the depth field's blur-`change` off until the press completes: it would re-store the override and schedule the rebuild that replaces this button mid-gesture.
    e.preventDefault();
    e.stopPropagation();
  });

  list.addEventListener('mouseup', (e) => {
    const btn = buttonFor(e);
    const started = pressedKey;
    pressedKey = null;
    mouseHandled = true;
    const key = btn?.dataset.resetKey;
    if (!btn || !key || key !== started) return;
    e.stopPropagation();
    clearOverride(btn, key);
  });

  // A release outside the list never reaches the mouseup listener above, so pressedKey would still
  // name that abandoned press when a later, unrelated gesture ends on the same button and the origin
  // check wrongly matches. Catching mouseup on the document too, after the list's listener has read
  // it, closes that wherever the release lands.
  document.addEventListener('mouseup', () => {
    pressedKey = null;
  });

  list.addEventListener('click', (e) => {
    // A real mouseup already made this gesture's call. The click right after is the browser's
    // synthetic one, normally aimed at the common ancestor and so off any button — but when the
    // mousedown target was detached mid-press (this delegation's reason to exist) it lands directly
    // on the mouseup target with no origin check, and could clear a row whose press started elsewhere
    // and was correctly left alone above.
    if (mouseHandled) {
      mouseHandled = false;
      return;
    }
    const btn = buttonFor(e);
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    clearOverride(btn, btn.dataset.resetKey ?? '');
  });
}

export function renderColorList(
  colorMeshes: ColorListEntry[] | null,
  opts: { rawColorCount?: number } = {},
): void {
  const list = $('#color-list');
  if (!colorMeshes || !colorMeshes.length) {
    list.innerHTML = '<div class="empty-hint">No colors detected yet.</div>';
    lastSlotsNeeded = 0;
    lastRawColorCount = 0;
    renderSlotCount();
    refreshDepthOverrides([]);
    $('#stat-colors').textContent = '0 colors';
    $('#stat-colors').style.display = 'none';
    return;
  }
  list.innerHTML = '';
  wireDepthReset(list);
  const baseEntry = colorMeshes.find((c) => c.isBase) || null;
  const rows = colorMeshes.filter((c) => !c.isBase);
  // Biggest colour first, how someone finds the row to edit. Not filament-slot order and not
  // labelled with slot numbers — the measurement behind convention 16's exception: export assigns
  // materials in palette order while this list sorts by area, and they disagree (rows blue, red,
  // green, yellow exported as slots 3, 4, 2, 5). Numbering by position would print a number the file
  // doesn't use and load the wrong spools; sorting by slot would remove the ordering people navigate
  // by. Maintainer's call, 2026-08-17: ship neither. The slot *count* on the line below is what a
  // decision turns on.
  rows.sort((a, b) => b.areaPct - a.areaPct);
  if (baseEntry) renderBaseRow(list, baseEntry);
  else renderEmptyBaseRow(list);
  // Labels for the "merge with…" dropdown, keyed by the joined-hex string each row uses as its drag payload (row.dataset.hexes), so a row's own entry can be excluded and picking another equals dragging one onto the other.
  const mergeTargets = rows.map((c) => ({
    key: c.members.join(','),
    label: c.isMergeGroup ? `Merged (${c.members.length})` : c.color,
  }));
  rows.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'color-row';

    // Show what was asked for, don't write it back. Seeding colorSettings from the build's depth
    // pinned every row to the *clamped* value: the second build compared 3.95 against 3.95, went
    // quiet and kept cutting the wrong depth, and lowering the global Depth field (the warning's own
    // fix) no longer reached rows carrying an explicit override. colorSettings holds deliberate overrides only.
    const shownDepth = requestedDepth(state.colorSettings, state.globalDepth, c.key);
    // A depth of zero or less cuts nothing, so the build raises it; the field kept reading 0.00
    // while 0.20 was in use, the warning the only place that number appeared. Said beside the field,
    // not written into it (see above).
    //
    // "raised to", never "cut at": what a part does with a setting is the mapper's business (the
    // wheel's cap cuts through at a fixed 3mm, an edge region at full thickness), so a cut depth
    // would be false on both. zeroDepthWarning describes the setting for the same reason.
    const raisedFromZero = shownDepth <= 0;
    // The other clamp: a depth deeper than the part goes is cut short, and the build reports what it
    // cut on `appliedDepth`. Compared at printed precision like the warning's depthDiffers, so a
    // sub-2dp move (3.951 -> 3.95) stays quiet. "cut at", not "raised to": this one did land on a printed depth.
    const tooDeepClamped =
      !raisedFromZero &&
      c.appliedDepth != null &&
      c.appliedDepth < shownDepth &&
      depthDiffers(c.appliedDepth, shownDepth);
    // A row with its own depth looked identical to one following the global, so the global Depth field appearing not to work had no visible cause or undo (clearing the field was the way back, documented only in help).
    const isOverridden = Number.isFinite(state.colorSettings[c.key]?.depth);

    let swatchHtml: string,
      labelHtml: string,
      rightControlHtml: string,
      membersRowHtml = '';
    if (c.isMergeGroup) {
      swatchHtml = `<div class="swatch" style="background:${c.color}" title="Prints as this color (the group's main color)"></div>`;
      membersRowHtml = `<div class="merge-members">${c.members
        .map(
          (h) =>
            `<button type="button" class="member-swatch" data-pull="${h}" style="background:${h}" title="Pull ${h} out of this group"><span class="member-x">×</span></button>`,
        )
        .join('')}</div>`;
      labelHtml = `Merged (${c.members.length})`;
      rightControlHtml = `<button class="btn small" data-add-base="${c.members.join(',')}" title="Print this group in the body instead of cutting it">→ base</button>`;
    } else {
      const pinned = state.keptApart.includes(c.color);
      swatchHtml = `<div class="swatch${pinned ? ' pinned' : ''}" style="background:${c.color}" ${pinned ? 'title="Pulled out of auto-merge. Click to re-allow merging"' : ''}></div>`;
      labelHtml = c.color;
      rightControlHtml = `<button class="btn small" data-add-base="${c.color}" title="Print this color in the body instead of cutting it">→ base</button>`;
    }

    // Keyboard/non-drag alternative to drag-to-merge, same effect, labelled as a target row labels itself. Only offered when there's something to merge with.
    const ownKey = c.members.join(',');
    const otherTargets = mergeTargets.filter((t) => t.key !== ownKey);
    const mergeSelectHtml = otherTargets.length
      ? `<select class="merge-with" title="Merge with another color, same as dragging one onto it" aria-label="Merge ${c.isMergeGroup ? `Merged (${c.members.length})` : c.color} with another color">
          <option value="">Merge with…</option>
          ${otherTargets.map((t) => `<option value="${t.key}">${t.label}</option>`).join('')}
        </select>`
      : '';

    // Nothing variable-width goes into `.depth-row` left of the ↺: its fixed left edge keeps it a column (see wireDepthReset).
    row.innerHTML = `
      <div class="top">
        <span class="drag-grip" aria-hidden="true" title="Drag to merge with another color">⠿</span>
        ${swatchHtml}
        <div class="hex">${labelHtml}</div>
        <div class="area">${c.areaPct.toFixed(1)}%</div>
        ${rightControlHtml}
      </div>
      ${membersRowHtml}
      <div class="depth-row">
        <label>depth</label>
        <input type="number" class="depth-input${isOverridden ? ' overridden' : ''}" step="0.05" value="${shownDepth.toFixed(2)}" aria-label="Depth for ${labelHtml}" title="${
          isOverridden
            ? `Using its own depth (${shownDepth.toFixed(2)} mm) instead of the ${state.globalDepth.toFixed(2)} mm default`
            : 'Following the default depth. Type here to give this row its own'
        }">
        <span class="hint">mm</span>
        ${
          isOverridden
            ? `<button type="button" class="btn small depth-reset" data-reset-key="${c.key}" title="Reset to the default depth (${state.globalDepth.toFixed(2)} mm)" aria-label="Reset depth for ${labelHtml} to the default">↺</button>`
            : ''
        }
        ${raisedFromZero ? `<span class="hint">raised to ${MIN_CUT_DEPTH_MM.toFixed(2)}</span>` : ''}
        ${tooDeepClamped ? `<span class="hint">cut at ${c.appliedDepth!.toFixed(2)}</span>` : ''}
        <span class="preset">≈ ${nearestFilamentName(c.color)}</span>
      </div>
      ${mergeSelectHtml ? `<div class="merge-row">${mergeSelectHtml}</div>` : ''}`;

    const mergeSelect = row.querySelector<HTMLSelectElement>('.merge-with');
    if (mergeSelect) {
      mergeSelect.addEventListener('click', (e) => e.stopPropagation());
      mergeSelect.addEventListener('change', () => {
        const targetKey = mergeSelect.value;
        if (!targetKey) return;
        mergeHexes([...ownKey.split(','), ...targetKey.split(',')].filter(Boolean));
      });
    }
    const depthField = row.querySelector<HTMLInputElement>('.depth-input')!;
    // Typing is a fresh deliberate edit, so it re-arms a field the reset marked — covering a reset that produced no change to consume the marker (↺ clicked with nothing typed), which would swallow the next edit.
    depthField.addEventListener('input', () => depthField.removeAttribute('data-abandoned'));
    depthField.addEventListener('change', (e) => {
      // Pass any numeric through and let the geometry clamp be the one place that reports an
      // override: a typed 0 or negative used to land as 0.1, so the build never saw what was asked
      // for. Clearing the field drops the override, so the row follows the global Depth rather than
      // sticking at a magic 0.1.
      // The reset button marks this field before the rebuild tears it out from under a pending edit;
      // without the guard that edit lands after the reset and undoes it (see wireDepthReset).
      // Strictly one event: when the rebuild is slow or fails the row stays mounted, and a marker
      // left set would swallow every later edit, silently, since nothing rebuilds either.
      const field = e.target as HTMLInputElement;
      if (field.hasAttribute('data-abandoned')) {
        field.removeAttribute('data-abandoned');
        return;
      }
      const typed = parseFloat(field.value);
      if (Number.isFinite(typed)) state.colorSettings[c.key] = { depth: typed };
      else delete state.colorSettings[c.key];
      scheduleRebuild();
    });
    row.querySelectorAll<HTMLElement>('[data-pull]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        pullFromGroup(btn.dataset.pull!);
      });
    });
    const addBase = row.querySelector<HTMLElement>('[data-add-base]');
    if (addBase)
      addBase.addEventListener('click', () => {
        addToBase(addBase.dataset.addBase!.split(','));
        scheduleRebuild();
      });
    const pinnedSwatch = row.querySelector<HTMLElement>('.swatch.pinned');
    if (pinnedSwatch) pinnedSwatch.addEventListener('click', () => clearKeptApart(c.color));

    // Drag-and-drop merge: drag one color onto another (or a merged group) to fuse them. The handle is the row's top strip so the depth field stays editable.
    row.dataset.hexes = c.members.join(',');
    const handle = row.querySelector<HTMLElement>('.top')!;
    handle.setAttribute('draggable', 'true');
    handle.style.cursor = 'grab';
    handle.addEventListener('dragstart', (e) => {
      e.dataTransfer!.setData('text/plain', row.dataset.hexes!);
      e.dataTransfer!.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    handle.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      $all('.color-row.drop-target').forEach((r) => r.classList.remove('drop-target'));
    });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'move';
      row.classList.add('drop-target');
    });
    row.addEventListener('dragleave', (e) => {
      if (!row.contains(e.relatedTarget as Node)) row.classList.remove('drop-target');
    });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drop-target');
      const src = (e.dataTransfer!.getData('text/plain') || '').split(',').filter(Boolean);
      const tgt = row.dataset.hexes!.split(',').filter(Boolean);
      if (src.join(',') === tgt.join(',')) return; // dropped onto itself
      mergeHexes([...src, ...tgt]);
    });

    list.appendChild(row);
  });
  // +1 for AMS slots: the body always occupies one filament slot (materials[0] in exportPanel.ts)
  // on top of every cut color/group. The colors stat stays rows.length (cut regions, not slots).
  // rows.length + 1 matches the export's material count: both come from one predicate
  // (shippedColorIndices in geometry/assembly.ts), and export still re-checks the pill as the authoritative last word.
  const cutColors = rows.length;
  lastSlotsNeeded = cutColors + 1;
  lastRawColorCount = opts.rawColorCount ?? cutColors;
  renderSlotCount();
  // Reported from the rows on screen, so the Depth panel can only name overrides the user can see and clear.
  refreshDepthOverrides(
    rows.filter((c) => Number.isFinite(state.colorSettings[c.key]?.depth)).map((c) => c.key),
  );
  $('#stat-colors').textContent = `${cutColors} color${cutColors === 1 ? '' : 's'}`;
  $('#stat-colors').style.display = '';
}

// Cached across renders so refreshSlotCountCapacity() (printer picker change, no rebuild) can redraw the slot line.
let lastSlotsNeeded = 0;
let lastRawColorCount = 0;

function renderSlotCount(): void {
  const el = $('#slot-count');
  refreshSlotBudgetNotice(lastSlotsNeeded);
  if (!lastSlotsNeeded) {
    el.textContent = '';
    el.classList.remove('over-capacity', 'multi-unit');
    el.removeAttribute('title');
    return;
  }
  // Always shown together, even when raw === cut colors: the slot count alone reads as a bug the first time the +1-for-body offset appears.
  el.textContent =
    `${lastRawColorCount} color${lastRawColorCount === 1 ? '' : 's'} → ` +
    `${lastSlotsNeeded} slot${lastSlotsNeeded === 1 ? '' : 's'} needed`;
  // Same slotTier() the pill is posted from, so line color and pill can't disagree
  const printer = getPrinter(state.printerId);
  const tier = slotTier(lastSlotsNeeded, printer);
  el.classList.toggle('over-capacity', tier === 'over-max');
  el.classList.toggle('multi-unit', tier === 'multi-unit');
  el.title =
    tier === 'over-max'
      ? `More than the ${printer.slotsMax} slots this printer can print in one go.`
      : tier === 'multi-unit'
        ? `More than the ${printer.slotsPerUnit} slots in a single ${printer.unitLabel}. ` +
          `Printable, but needs another one (up to ${printer.slotsMax} slots) or manual ` +
          `filament swaps.`
        : `Fits a single ${printer.slotsPerUnit}-slot ${printer.unitLabel}.`;
}

/** Redraw the slot-count line against the printer's slot capacity. The printer picker doesn't schedule a rebuild (no geometry effect), so nothing else would refresh it. */
export function refreshSlotCountCapacity(): void {
  renderSlotCount();
}

function updateAutoMergeLabels(level: number): void {
  $all('#automerge-labels span').forEach((el, i) => el.classList.toggle('active', i === level));
}

/** Push state.autoMergeLevel into the slider + label DOM — needed by session restore (state/persist.ts), which sets it directly, not via the slider's input handler. */
export function refreshAutoMergeControl(): void {
  $<HTMLInputElement>('#p-automerge').value = String(state.autoMergeLevel);
  updateAutoMergeLabels(state.autoMergeLevel);
}

export function initColorListPanel(): void {
  const slider = $<HTMLInputElement>('#p-automerge');
  slider.value = String(state.autoMergeLevel);
  updateAutoMergeLabels(state.autoMergeLevel);
  slider.addEventListener('input', () => {
    state.autoMergeLevel = parseInt(slider.value, 10) || 0;
    updateAutoMergeLabels(state.autoMergeLevel);
    scheduleRebuild();
  });
}
