# Decisions needed

Per-run inbox. Each entry is a question a run could not answer for itself, with
enough context to answer it in one line. Drains to empty before the branch
merges — see CLAUDE.md.

## The part thumbnail is a flat `--accent` fill, which reads as a selection state

The thumbnail beside the Part dropdown
([src/ui/shapeThumb.ts](src/ui/shapeThumb.ts)) paints the whole silhouette in
`--accent`, depth-shaded between 70% and 100% of it. So the picture of the part
is the same hue the app uses for "this one is selected" — and convention 19 of
[docs/ui-conventions.md](docs/ui-conventions.md) says selection is never
communicated by tinting a thing an accent hue, on the grounds that blue is also
a filament a user owns.

It is arguably not a violation: the thumbnail is chrome describing the part, not
a selection affordance, and one hue throughout is what keeps it reading as an
icon rather than as a tiny render. But it is the same question, and the answer
decides whether the silhouette should be a neutral (`--text-2`, say, or a
panel-relative grey) with the accent kept for actual selection.

Left alone deliberately in the round that changed the thumbnail's angle and
resolution: it is a design call about the visual language, not a rendering bug,
and `design-system/` owns the palette. Nothing else in this branch depends on
the answer.

**Needs:** a colour, or "accent is correct here" — either way it becomes a
comment next to the `--accent` read in `renderSilhouette()`, or a conventions
entry if the rule needs the exception written down.
