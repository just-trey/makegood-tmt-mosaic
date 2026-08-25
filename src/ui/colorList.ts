import { addToBase, baseColorHex, removeFromBase, state } from '../state/store';
import { MIN_CUT_DEPTH_MM, requestedDepth } from '../geometry/depth';
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
  isBackground: boolean;
  /** printed in the body instead of cut — a distinct status row, no depth/merge controls */
  isBase?: boolean;
}

export function groupContaining(hex: string): string[] | null {
  return state.mergeGroups.find((g) => g.includes(hex)) || null;
}

/** Merge an explicit set of raw hexes into one group, folding in any existing groups they touch.
 * An explicit (re-)merge is a stronger signal than a earlier pull-out pin, so it clears one. */
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

/** Pull one color out of whatever group it's in, leaving the rest merged, and pin it so the
 * auto-merge slider won't re-swallow it. Dragging it back onto a group (or clearKeptApart)
 * clears the pin. */
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

/** Makes a row a valid drop target for growing the base — dragging a color or merged group onto
 * it calls addToBase instead of mergeHexes, whether the base already has members or is empty. */
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

/** The Base row: pinned at the top of the list so it never reorders, shows every color grouped
 * into it (dominant = body color) with a "×" to send one back to being cut, and doubles as a
 * drop target. Its swatch is the body colour, which is why the empty row below shows one too. */
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
      <div class="swatch" style="background:${c.color}" title="Prints as this color (the base's dominant member)"></div>
      <div class="hex">Base — prints as the body</div>
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
 * Shown instead of the Base row when nothing's grouped into it yet, so the empty state reads as a
 * normal, common choice rather than a gap. Still a drop target: dragging a color onto it starts
 * the base the same way "→ base" would.
 *
 * It carries the body colour as a swatch rather than naming the panel that sets it. Convention 4
 * bars a control's explanation from pointing at another panel, and this row was the live instance:
 * "body uses the blank color set in Part". Showing the colour answers the same question without
 * sending anyone anywhere, and it is the same state value the Part picker writes.
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
 * The depth-reset "↺" is wired on the list container, once, rather than per button — the buttons
 * themselves are too short-lived to hold a handler.
 *
 * Editing the depth field schedules a rebuild, and that rebuild replaces the list's innerHTML. A
 * button listener attached during the previous render is on a node that gets detached mid-gesture,
 * so the reset lands on nothing and silently does not happen. The container outlives every render,
 * so delegation catches the event whichever generation of button received it.
 *
 * The press is split across three events because each one covers a case the others get wrong:
 *
 * - `mousedown` only holds the gesture open. It cannot clear anything: a press dragged off the
 *   button and released is a cancel, raises no click, and has to leave the row exactly as it was.
 * - `mouseup` is what clears, and only when it lands on the same button the press started on. It
 *   is used in preference to `click` because click is fired at the nearest common ancestor of the
 *   two targets — so a rebuild that swaps the button out mid-press sends it to a container instead,
 *   which is the failure this delegation exists to survive. mouseup goes to whatever button is
 *   under the pointer, and the replacement carries the same reset key.
 * - `click` covers keyboard activation, which raises neither of the above.
 *
 * All three are idempotent: whichever runs first removes the override, and the rest read its
 * absence as "already handled" — except `click` after a real mouse gesture, which needs its own
 * guard against the same button-swap race (`mouseHandled`, see below).
 *
 * Its position in the row was challenged (UX review, 2026-08-03), moved to the row's right edge,
 * looked at in the running app, and moved back — why it sits where it does, and why it carries
 * `.btn`, is on `.color-row .depth-reset` in styles.css, next to the rules that decide it. Three
 * measurements from that pass that the CSS doesn't carry:
 *
 * - The "consistent slot" the move was reaching for already existed: the ↺'s left edge measured
 *   168px on all four rows of a four-color list, since everything left of it is fixed width. **A
 *   fix depends on that** — putting anything variable-width left of it (a longer label, a per-row
 *   badge) breaks the column and reopens the question.
 * - Rejected alternatives, so they aren't re-attempted: the unit inside the field (`[2.40 mm]`)
 *   collides with Chrome's number-input spinners, which this app doesn't suppress; the unit before
 *   the value (`depth mm [2.40]`) reads wrongly, since a unit follows its number.
 * - Never checked on touch, or at the 900px minimum width the app renders at.
 */
function wireDepthReset(list: HTMLElement): void {
  if (list.dataset.depthResetWired) return;
  list.dataset.depthResetWired = '1';
  // Which row's "↺" the current press started on, so releasing on a different one — or on nothing
  // — cancels rather than resetting whatever happens to be under the pointer.
  let pressedKey: string | null = null;
  let mouseHandled = false;

  const buttonFor = (e: Event): HTMLElement | null => {
    const btn = (e.target as HTMLElement | null)?.closest?.('.depth-reset') as HTMLElement | null;
    // Primary button only, or the press that opens a context menu counts as a reset — and no click
    // follows a right- or middle-press to undo it.
    return !btn || (e as MouseEvent).button > 0 ? null : btn;
  };

  const clearOverride = (btn: HTMLElement, key: string): void => {
    if (!(key in state.colorSettings)) return;
    // Abandon whatever is half-typed in this row's field. The blur below fires its pending change,
    // which would otherwise re-store the very override this is clearing.
    btn
      .closest('.color-row')
      ?.querySelector<HTMLInputElement>('.depth-input')
      ?.setAttribute('data-abandoned', '1');
    // Settle a half-typed edit in *another* row now, while it still costs nothing. The mousedown
    // suppressed the blur that would normally commit it, so it would otherwise sit pending until
    // the rebuild below tore the field out — and Chrome's change-on-removal lands mid-render, after
    // this pass has already read colorSettings, buying a second full rebuild to show it. Blurring
    // here puts that change in this same tick, where the debounce folds it into one.
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
    // Hold the depth field's blur-`change` off until the press completes. Left to run, it re-stores
    // the override and schedules the rebuild that replaces this button mid-gesture.
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

  // A release outside the list entirely never reaches the mouseup listener above, so pressedKey
  // would otherwise still name that abandoned press the next time some *later, unrelated* gesture
  // happens to end on the same button — and the origin check there would wrongly call it a match.
  // Catching mouseup on the document as well, after the list's own listener has already read it,
  // closes that regardless of where the release actually lands.
  document.addEventListener('mouseup', () => {
    pressedKey = null;
  });

  list.addEventListener('click', (e) => {
    // A real mouseup already made this gesture's call, one line above. The click that immediately
    // follows it is the browser's own synthetic event, not a second independent one — normally
    // aimed at the common ancestor of the mousedown/mouseup targets and so off any button, but not
    // when the mousedown target was detached mid-press (this delegation's whole reason to exist):
    // then click lands directly on the mouseup target instead, with no origin check of its own.
    // Without this it would re-decide "what's under the pointer now" and could clear a row whose
    // press actually started elsewhere and was already correctly left alone above.
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
  // Biggest colour first, which is how someone finds the row they want to edit.
  //
  // Not the filament-slot order, and not labelled with slot numbers. This is the measurement
  // behind convention 16's exception: the export assigns materials in palette order while this
  // list sorts by area, and they genuinely disagree. A four-colour file whose rows read blue, red,
  // green, yellow exported them as slots 3, 4, 2, 5. Numbering rows by position would print a
  // number the file does not use, and a maker loading their AMS from it would load the wrong
  // spools; sorting by slot instead would fix the numbers by removing the ordering people navigate
  // with. Maintainer's call, 2026-08-17: ship neither. The slot *count* is on the line below,
  // which is the number a decision turns on.
  rows.sort((a, b) => b.areaPct - a.areaPct);
  if (baseEntry) renderBaseRow(list, baseEntry);
  else renderEmptyBaseRow(list);
  // Labels for the "merge with…" dropdown below, keyed by the same joined-hex string each row
  // uses as its own drag payload (row.dataset.hexes) — so a row's own entry can be excluded and
  // picking another produces exactly what dragging one onto the other would.
  const mergeTargets = rows
    .filter((c) => !c.isBackground)
    .map((c) => ({
      key: c.members.join(','),
      label: c.isMergeGroup ? `Merged (${c.members.length})` : c.color,
    }));
  rows.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'color-row';

    // Show what was asked for, and don't write it back. Seeding colorSettings from the build's
    // depth pinned every row to the *clamped* value on the first render: the second build then
    // compared 3.95 against 3.95, went quiet, and kept cutting the wrong depth — and lowering the
    // global Depth field, the fix the warning tells you to apply, no longer reached rows that now
    // carried an explicit override. colorSettings holds deliberate per-row overrides only.
    const shownDepth = requestedDepth(state.colorSettings, state.globalDepth, c.key);
    // A depth of zero or less cuts nothing, so the build raises it — and the field went on reading
    // 0.00 while the setting in use was 0.20, with the warning the only place that number
    // appeared.
    //
    // Says "raised to", never "cut at". What a part does with a setting is the mapper's business:
    // the wheel's cap cuts through at a fixed 3mm and an edge region cuts full thickness, so
    // naming a cut depth here would be false on both. zeroDepthWarning describes the setting for
    // exactly this reason, and this matches it.
    // Said beside the field instead of written into it: writing it back is what the comment above
    // records as pinning every row to the clamped value and silencing the warning.
    //
    // Only the zero case, which the panel can work out on its own. The other override, a depth
    // deeper than the part, depends on that part's geometry and is not knowable here
    // (docs/tech-debt.md).
    const raisedFromZero = shownDepth <= 0;
    // A row carrying its own depth looked identical to one following the global, so the global
    // Depth field appearing not to work had no visible cause and no visible undo — clearing the
    // field was the only way back, and it was documented only in the help panel.
    const isOverridden = Number.isFinite(state.colorSettings[c.key]?.depth);

    let swatchHtml: string,
      labelHtml: string,
      rightControlHtml: string,
      membersRowHtml = '';
    if (c.isBackground) {
      swatchHtml = `<div class="swatch" style="background:${c.color}"></div>`;
      labelHtml = `Background`;
      rightControlHtml = '';
    } else if (c.isMergeGroup) {
      swatchHtml = `<div class="swatch" style="background:${c.color}" title="Prints as this color (the group's dominant member)"></div>`;
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
      swatchHtml = `<div class="swatch${pinned ? ' pinned' : ''}" style="background:${c.color}" ${pinned ? 'title="Pulled out of auto-merge — click to re-allow merging"' : ''}></div>`;
      labelHtml = c.color;
      rightControlHtml = `<button class="btn small" data-add-base="${c.color}" title="Print this color in the body instead of cutting it">→ base</button>`;
    }

    // Keyboard/non-drag alternative to the drag-to-merge gesture below — same effect, listed by
    // the same label a target row shows itself. Only offered when there's something else to
    // merge with, and never on Background (it isn't a mergeable color).
    const ownKey = c.members.join(',');
    const otherTargets = c.isBackground ? [] : mergeTargets.filter((t) => t.key !== ownKey);
    const mergeSelectHtml = otherTargets.length
      ? `<select class="merge-with" title="Merge this color with another — same as dragging one onto the other" aria-label="Merge ${c.isMergeGroup ? `Merged (${c.members.length})` : c.color} with another color">
          <option value="">Merge with…</option>
          ${otherTargets.map((t) => `<option value="${t.key}">${t.label}</option>`).join('')}
        </select>`
      : '';

    // Nothing variable-width goes into `.depth-row` left of the ↺: its fixed left edge is the
    // reason it reads as a column and doesn't need moving (see wireDepthReset).
    row.innerHTML = `
      <div class="top">
        ${c.isBackground ? '' : '<span class="drag-grip" aria-hidden="true" title="Drag to merge with another color">⠿</span>'}
        ${swatchHtml}
        <div class="hex">${labelHtml}</div>
        <div class="area">${c.areaPct.toFixed(1)}%</div>
        ${rightControlHtml}
      </div>
      ${membersRowHtml}
      <div class="depth-row">
        <label>depth</label>
        <input type="number" class="depth-input${isOverridden ? ' overridden' : ''}" step="0.05" value="${shownDepth.toFixed(2)}" aria-label="Depth for ${c.isBackground ? 'Background' : labelHtml}" title="${
          isOverridden
            ? `Using its own depth (${shownDepth.toFixed(2)} mm) instead of the ${state.globalDepth.toFixed(2)} mm default`
            : 'Following the default depth set in Depth — type here to give this row its own'
        }">
        <span class="hint">mm</span>
        ${
          isOverridden
            ? `<button type="button" class="btn small depth-reset" data-reset-key="${c.key}" title="Reset to the default depth (${state.globalDepth.toFixed(2)} mm)" aria-label="Reset depth for ${c.isBackground ? 'Background' : labelHtml} to the default">↺</button>`
            : ''
        }
        ${raisedFromZero ? `<span class="hint">raised to ${MIN_CUT_DEPTH_MM.toFixed(2)}</span>` : ''}
        <span class="preset">${c.isBackground ? '—' : '≈ ' + nearestFilamentName(c.color)}</span>
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
    // Typing is a fresh, deliberate edit, so it re-arms a field the reset had marked. Covers the
    // reset that never produced a change to consume the marker — clicking ↺ with nothing typed —
    // which would otherwise leave it for the user's next edit to be swallowed by.
    depthField.addEventListener('input', () => depthField.removeAttribute('data-abandoned'));
    depthField.addEventListener('change', (e) => {
      // A typed 0 or a negative used to land here as 0.1, so the build never saw the number that
      // was actually asked for and couldn't say it had been overridden. Pass anything numeric
      // through and let the geometry clamp be the one place that reports the override. Clearing
      // the field drops the override entirely, so the row goes back to following the global Depth
      // rather than sticking at a magic 0.1 nobody asked for.
      // The reset button marks this field before the rebuild tears it out from under a pending
      // edit; without the guard that edit lands after the reset and undoes it. See wireDepthReset.
      // Strictly one event: the field usually goes away with the rebuild, but when that rebuild is
      // slow or fails the row stays mounted, and a marker left set would swallow every later edit
      // to it — silently, since nothing rebuilds either.
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

    // Drag-and-drop merge: drag one color onto another (or onto a merged group) to fuse them.
    // The draggable handle is the row's top strip so the depth field stays freely editable.
    if (!c.isBackground) {
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
    }

    list.appendChild(row);
  });
  // +1 for AMS slots: the body itself always occupies one physical filament slot (materials[0] in
  // both export paths — see exportPanel.ts), on top of every cut color/group listed below the Base
  // row. The colors stat stays rows.length — it counts cut regions, not filament slots.
  //
  // rows.length + 1 matches the export's material count in both modes: flat mode never emits a
  // color mesh without geometry, and assembly mode derives rows and materials from one predicate
  // (shippedColorIndices in geometry/assembly.ts). Export still re-checks the pill against its
  // own material count as the authoritative last word.
  const cutColors = rows.length;
  lastSlotsNeeded = cutColors + 1;
  lastRawColorCount = opts.rawColorCount ?? cutColors;
  renderSlotCount();
  // Reported from the rows actually on screen, so the Depth panel can only ever name overrides the
  // user can see and clear.
  refreshDepthOverrides(
    rows.filter((c) => Number.isFinite(state.colorSettings[c.key]?.depth)).map((c) => c.key),
  );
  $('#stat-colors').textContent = `${cutColors} color${cutColors === 1 ? '' : 's'}`;
  $('#stat-colors').style.display = '';
}

// Cached across renders so refreshSlotCountCapacity() (called when the printer picker changes,
// which doesn't itself trigger a rebuild) can redraw the slot line without rebuilding the list.
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
  // Always shown together, even when raw === cut colors (the common unmerged case) — seeing the
  // slot count alone reads as a bug the first time the +1-for-body offset shows up; the arrow
  // makes the relationship self-explanatory every time, not just after a merge changes the count.
  el.textContent =
    `${lastRawColorCount} color${lastRawColorCount === 1 ? '' : 's'} → ` +
    `${lastSlotsNeeded} slot${lastSlotsNeeded === 1 ? '' : 's'} needed`;
  // Same slotTier() the pill above is posted from, so the line's color and the pill can't disagree
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

/** Redraw the slot-count line against the selected printer's slot capacity — the counterpart to
 * refreshAutoMergeControl() etc. for this control. Needed because changing the printer picker
 * doesn't schedule a rebuild (it doesn't affect geometry), so nothing else would refresh this. */
export function refreshSlotCountCapacity(): void {
  renderSlotCount();
}

function updateAutoMergeLabels(level: number): void {
  $all('#automerge-labels span').forEach((el, i) => el.classList.toggle('active', i === level));
}

/** Push state.autoMergeLevel into the slider + label DOM — the counterpart to
 * refreshFitInputsFromState() for this control, needed by session restore (state/persist.ts),
 * which sets autoMergeLevel directly rather than through the slider's own input handler. */
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
