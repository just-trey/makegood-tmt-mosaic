An inline banner stacked over the viewport, used for recoverable issues ("Boolean subtraction failed for color #e8a13a…").

Rendered by [src/ui/warningsView.ts](../../../src/ui/warningsView.ts) as plain DOM, not a component.

## Two tones

The tone is chosen by the warning's `level`, and both ship:

| Tone              | Class             | Background      | Border            | Text            | Prefix |
| ----------------- | ----------------- | --------------- | ----------------- | --------------- | ------ |
| Warning (default) | `.warn-pill`      | `--danger-wash` | `--danger-border` | `--danger-text` | `⚠ `   |
| Info              | `.warn-pill.info` | `--accent-wash` | `--accent`        | `--text-dim`    | `ℹ `   |

The info tone is not a muted warning — it carries accent blue and dimmed body text, so it reads
as a notice rather than a problem. Use it for something the user should know about a result that
is still correct; reserve the danger tone for something that went wrong.

## Structure

```html
<div class="warn-pill info">
  <span class="warn-text">ℹ Merged two colors that resolve to the same recess.</span>
  <button class="warn-dismiss" aria-label="Dismiss this warning">×</button>
</div>
```

Every pill is individually dismissable. When more than one is showing, a "clear all" control
appears above the stack. The container is `pointer-events: none` so the viewport stays
draggable behind the pills; each pill restores `pointer-events: auto` for itself.

`max-width: 520px`, inherits body text size (`--text-body`, 12px — it sets no `font-size` of
its own), `--radius-lg` corners, long strings wrap on `word-break`.
