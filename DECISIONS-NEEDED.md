# Decisions needed

## `--sans` and `--mono` app-side values differ from the design system's

`src/styles.css`'s `:root` and `design-system/tokens/typography.css` declare these under the
same name, but the literal values are not identical — `docs/system-audit.md`'s "33 co-declared,
matching value" count was computed from resolved rendering (which font actually painted), not
from a side-by-side string diff of the two `:root` blocks.

| Token    | App (`src/styles.css`)                                                       | Design system (`design-system/tokens/typography.css`) |
| -------- | ---------------------------------------------------------------------------- | ----------------------------------------------------- |
| `--sans` | `'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif` | `'Inter', -apple-system, 'Segoe UI', sans-serif`      |
| `--mono` | `'IBM Plex Mono', 'SF Mono', 'Consolas', 'Menlo', monospace`                 | `'IBM Plex Mono', 'SF Mono', Consolas, monospace`     |

Both lists lead with the same first-choice font (`Inter`, `IBM Plex Mono`), so on any machine
where that font loads, this is invisible — which is exactly how the audit's computed-style
measurement missed it. The difference only shows up in the fallback chain: the app additionally
falls back to `BlinkMacSystemFont` and `Roboto` (`--sans`) and to `Menlo` (`--mono`) before
hitting the generic family. Quoting style (`Consolas` vs `'Consolas'`) is not a real difference —
both resolve identically — only the added font names are.

All other 31 co-declared tokens (16 in `colors.css`, 9 in `spacing.css`, 6 more in
`typography.css` — `--heading`, `--text-label`, `--text-meta`, `--text-body`, `--text-emphasis`,
`--text-display`) are byte-identical between the two sides. No app-only token (one with no
design-system counterpart) exists among the 33 currently co-declared. `--radius-sm/md/lg/2xl`
are declared on both sides too (in `design-system/tokens/spacing.css`), matching — they are not
app-side-only, so the "leave `--radius-*` alone if app-only" case in the branch instructions
does not apply.

**Decision needed:** should `--sans` and `--mono` converge on the design system's shorter fallback
chains (dropping `BlinkMacSystemFont`, `Roboto`, `Menlo` from what ships), or should
`design-system/tokens/typography.css` be widened to match the app's current chains? Either is a
one-line change once picked; this is a taste call (which fallback fonts are worth keeping), not a
bug, so it isn't being decided here.

**What this branch did in the meantime:** imported `design-system/tokens/{colors,spacing,typography}.css`
via `@import` and deleted every other redeclaration from `src/styles.css`'s `:root`, but left
`--sans` and `--mono` declared in the app's `:root` (after the `@import`, so they still win the
cascade) with their current, unchanged values — computed output is byte-identical to before this
branch, and neither side's value was picked as a winner. Once this decision is made, delete
whichever of the two declarations loses and this file's entry goes with it.
