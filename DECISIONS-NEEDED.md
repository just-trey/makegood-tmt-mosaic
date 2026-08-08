# Decisions needed — type & spacing token adoption

Values that didn't fit the five type tokens or five spacing tokens cleanly. Each used the
nearest token and moved on, per the branch's own rule; recorded here rather than silently
picked. If this list grows past ~5, the scale itself is wrong and needs a second look before
merging — it currently sits at 4.

## 1. Icon glyphs are `em`, not a sixth `--text-*` token

Five rules size a Unicode glyph used as an icon, not text: `details.sec > summary::before` (▸),
`.member-x` (×), `.warn-dismiss` (×), `.color-row .depth-reset` (↺), `.close-btn` (×). None of
the five text tokens fit — an icon's size is optical, relative to the text beside it, which a
fixed token can't express and `em` can. Resolved as `em` against each glyph's inherited context,
tuned to land near (not pinned to) today's rendered size:

| Selector                        | Glyph | Ratio                             | Renders |
| ------------------------------- | ----- | --------------------------------- | ------- |
| `details.sec > summary::before` | ▸     | `0.8em` of `--text-label` (11px)  | 8.8px   |
| `.member-x`                     | ×     | `0.75em` of inherited body (12px) | 9px     |
| `.warn-dismiss`                 | ×     | `1.1em` of inherited body (12px)  | 13.2px  |
| `.color-row .depth-reset`       | ↺     | `1.1em` of inherited body (12px)  | 13.2px  |
| `.close-btn`                    | ×     | `1.25em` of inherited body (12px) | 15px    |

`design-system/README.md`'s Iconography section now states this explicitly, and
`scripts/check-type-scale.mjs`'s font-size check names these five selectors by an allowlist
constant — a sixth off-scale size appearing anywhere else is a real finding, not expected drift.

## 2. 20px spacing has no step of its own

`header { padding: 0 20px }` and `#confirm-dialog { padding: 20px }` sit exactly between
`--space-section` (16px) and `--space-panel` (24px). Taking `--space-panel` would make both
visibly airier than today, which the brief calls the wrong direction — compact is correct, so
both round down to `--space-section`.

## 3. 3px rounds down, not up

`.merge-members { gap: 3px }` and a few asymmetric paddings sit equidistant between
`--space-hair` (2px) and `--space-tight` (4px). Same reasoning as #2: compact is correct, so 3px
rounds down to `--space-hair` throughout, not up to `--space-tight`.

## 4. `--text-label` and `--text-meta` share a value on purpose

Both are 11px — a named token duplicating another token's value, which is exactly the criterion
this branch used to drop `--radius-xl` (UNSET in the app, value-duplicate of `--radius-lg`).
Not merged here, because the two are not interchangeable: `--text-label` is sans and tracked
(uppercase section headers), `--text-meta` is mono only. Mono at 11px optically matches sans at
12px, so the two diverge the moment `--text-body` moves — collapsing them into one token would
silently break that match on the next scale change. Recorded in a comment in `:root` (both
`src/styles.css` and `design-system/tokens/typography.css`) and in `design-system/README.md`'s
Typography section, so the next system audit reports the duplicate as intended rather than
flagging it under the rule this branch just applied.

## Likely (not certain) source of the audit's unexplained 6px radius

Not one of the four above — a side finding while converting spacing.
[src/ui/assemblyPanel.ts:413](src/ui/assemblyPanel.ts#L413) hardcodes an inline
`border-radius:6px` on the assembly-part STL/3MF dropzone, matching no radius token (the scale
tops out at `--radius-2xl`, 3px). This branch converts that rule's `padding` and (already
inherited) font-size but leaves the radius alone — radius values are explicitly out of scope
here. Flagging it because it is very likely the source of `docs/system-audit.md`'s "radius
source not conclusively identified" note; a radius-focused pass should look at this line first
rather than re-deriving it.
