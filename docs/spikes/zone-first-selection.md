# Spike: zone-first selection with per-zone artwork slots

**Spike, not a plan. Nothing here is committed to and the prototype must not merge.** The
prototype was `src/ui/zoneListPanel.spike.ts` plus its wiring on the throwaway branch
`spike/zone-first-selection` — named `.spike.ts` so nobody could mistake it for the feature. Only
this write-up and the two proposed component specs were merged; **the code is not in the tree**,
which is the intended end state for a spike, not an omission. What it measured is below.

Driven 2026-08-08 against commit `c2d7767`, chair body, `MOSAIC_GPU=1`,
`ANGLE (Microsoft Corporation, D3D12 (NVIDIA GeForce RTX 2060), OpenGL ES 3.1)`.

## The target

Zones selectable from the moment the part loads, each holding its own artwork with its own fit,
empty zones a normal state, and the placement frame on the selected zone's frame. Order follows the
task and the task starts with _where_ (convention 9); a file dropped on a surface lands on that
surface with no rebinding step (convention 15).

**This is not what `+zone` does.** `+zone` takes a design that is already loaded and stamps a second
copy of it onto another surface — one source, several placements, chosen file-first. The target is
independent artwork per surface, chosen surface-first. Sizing that gap is what this spike is for.

## Read first, because it constrains the answer

[tech-debt.md](../tech-debt.md), "Artwork can't wrap unbroken from one flank around the back to the
other", records **three measured dead ends** — a cylindrical band (max stretch 2.113, 69.6% of the
surface), one merged LSCM zone (unwraps beautifully but self-overlaps 4.85%, so artwork cuts onto
the wrong sheet), and cross-chart registration (the flanks and the back share 10 vertices over
22 mm of a 500 mm boundary; a design registered across it flows through the handle posts and stops
everywhere else). There is no angle window between severing and folding.

**That is why a zone is the unit of artwork, and it is not a compromise to be designed around.** A
zone-first UI is not a workaround for the wrap being unfinished; it is the interface that matches
what the geometry actually is. Anything in this spike that tries to make zone boundaries feel less
real is going the wrong way.

## What the prototype found

### 1. The data model is already per-zone. This is the surprise.

`ArtworkInstance` ([src/types.ts](../../src/types.ts)) already carries `zone: ZoneRef | null` and
its own `offsetU`, `offsetV`, `scalePct`, `rotationDeg`, `flipX`, `flipY`, `mode`. "Each zone holds
its own artwork with its own fit" is the shape the data is in **today**. Persistence already stores
`zoneId` and re-resolves it against freshly loaded parts on restore.

The spike added exactly **one** new piece of state — `selectedZoneId` — and could list every
surface, show what was on it, and select one. Driven on the chair before any file was chosen:

```
zones listed BEFORE any file is chosen: ["Left side empty", "Back empty", "Front empty",
                                         "Right side empty", "Seat empty"]
```

`availableZones()` works from load. Empty is already representable. Screenshot:
`stubs/spike/1-zones-before-file.png`.

So the honest estimate is **not** "a different data model". It is "the data model is right and
three other things are wrong".

### 2. Selecting a surface first changes nothing about where the file lands

The spike's headline result, driven:

```
selected surface-first          : ["Front empty"]
the design actually bound to    : left
```

Select "Front", drop a file, and it goes to **Left side** — the first zone — because
`loadArtworkSource` binds a new instance to the first available zone unconditionally. The selection
is not consulted, because nothing before this spike had a selection to consult.

This is the feature, and it is one function. It is also convention 8 read backwards today: a
control acting on something other than the selection the user made.

### 3. The fit controls do not read the selected zone; they read a global

The real cost. Offset X/Y, Scale, Rotate and the flips write `state.offsetX/Y`, `state.scalePct`,
`state.rotationDeg`, `state.flipX/Y`, and `syncActiveArtworkPlacement()` mirrors those onto the
**active instance** at rebuild time. So:

- Selecting an _empty_ zone leaves the fit controls pointing at some other zone's design. The spike
  cannot do better; there is no instance to point at, and the controls have no concept of "none".
- Two zones with different fits are two instances whose values are only correct while each is
  active. The globals are a single slot that the active instance borrows.

**This is the work.** Not the zone list, not the picking (already fixed this run), not the data
model. Every fit control has to address the selected zone's instance directly, and the globals have
to stop being the source of truth. `designGizmo.ts`'s drag handlers write the globals too, so it is
the same change.

### 4. There is no "artwork changed" notification

`onAssemblyPartsChanged` exists and takes exactly **one** subscriber (`notifyPartsChanged = fn`).
There is no equivalent for artwork: `renderArtworkList()` is called directly from about eight sites.
A second panel that must stay in step with artwork state has to be threaded into every one of them,
and the spike visibly failed to — after the load, its rows still read `empty` while the artwork list
showed the design bound to `left` (`stubs/spike/2-zones-after-file.png`). That is a prototype bug,
and it is also the shape of a real one waiting for the second panel.

### 5. `zone: null` is overloaded and has to be split

`null` currently means both "this part has one implicit surface" (wheel, footrest) and "All zones"
(broadcast onto every surface). `sharesSurface()` and `zoneCoverage()` both special-case it. In a
zone-first model those are different things: the first is "there is one surface and it is selected
by default", the second is a deliberate broadcast that a surface list has to render somehow — five
rows all showing the same design, or a sixth row above them. Leaving them fused is how a zone list
ends up unable to say what is on a surface.

### 6. What a conventions review saw in the prototype that I did not

Run against the screenshots and the rubric alone — no code, no diff, no statement of intent. Three
of its findings are about the prototype and change what the plan should be:

- **The surface list is the last thing in the panel, under the file picker.** Rows start at y≈788
  of a 920px panel and the fifth is clipped by the panel edge. The component satisfies convention 9;
  the _placement_ inverts it — the "where" step is below the "what" step and below the fold. That is
  not a prototype shortcut to wave away, it is the actual question the feature has to answer, and
  the answer is that the surface list goes **above** the dropzone, not below it. Add that to item 1.
- **The panel-level dropzone wins over the per-surface rows, and both are on screen.** In the
  after-file screenshot the file went to the dropzone while "Front" was selected and every row still
  read `empty`. Convention 15 wants the file dropped on the thing it applies to; a generic dropzone
  sitting directly above five per-zone drop targets _is_ the rebinding step. So item 7 is not
  optional polish — either the rows take the drop or the panel dropzone goes away.
- **The row gap is 1px.** Rows pitch at 27px separated by a single `--panel` pixel. `--space-row`
  is 8px and `--space-hair`'s own comment says "Never rhythm between rows". Prototype CSS, but it
  says the spec should state the gap explicitly rather than leave it to whoever builds it.

And one about the two proposed specs that is worth more than the specs are:

- **`design-system/README.md`'s Fidelity section and convention 31 contradict each other, and
  these two files sit on the seam.** Fidelity says, unconditionally, "Every component documented
  here has a live counterpart in the app", and names three specs deleted for breaking it.
  Convention 31 says a change needing a missing component "proposes it as an addition —
  `Name.jsx`, `Name.d.ts`, `Name.prompt.md`". But the README deleted every `.jsx` and `.d.ts` in
  the bundle, permanently, because "the app is vanilla TypeScript on Vite and can never import a
  React component". So convention 31 prescribes an artifact set the design system forbids, and
  filing a proposal at all makes the Fidelity sentence false.
  Titling both files PROPOSED is a patch over that, not a resolution. The real fix is one of:
  a `components/proposed/` directory, or a Fidelity paragraph defining the tier. **Either way
  convention 31's `Name.jsx, Name.d.ts` clause should go** — it is prescribing React files in a
  repo that deleted them on purpose. That is a live contradiction between two authoritative
  documents and it was found by pointing a reviewer at both. **Promoted out of this spike** —
  it is a finding rather than a spike result, and it now has its own section in
  [tech-debt.md](../tech-debt.md).
- `ZoneListRow` was filed under `layout/`, which the README says holds the Panel section shell. Its
  nearest analogue, `ColorRow`, is in `misc/`. Moved.
- `FilamentSlotStrip` marks over-capacity slots with a `--danger` border around swatches that are
  themselves arbitrary filament colours — a pink border on a pink filament, which is the
  blue-frame-on-blue-artwork problem in a new place (conventions 19 and 21). The spec needs a
  non-hue marker for that state before anyone builds it.

## What it would cost

Ordered by risk, not by size. The first two are the feature; the rest is what makes it honest.

| #   | Work                                                                                              | Size | Risk                                                                            |
| --- | ------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------- |
| 1   | `selectedZoneId` in the store; zone list panel; two-way with viewport picking                     | S    | low — picking already hits what is visible as of this run                       |
| 2   | New designs bind to the selected zone instead of the first                                        | S    | low                                                                             |
| 3   | **Fit controls and the gizmo address the selected instance, retiring the placement globals**      | L    | **high** — touches every fit control, the gizmo, persistence and `state.parsed` |
| 4   | An artwork-changed subscription, or one render entry point both panels go through                 | S    | low                                                                             |
| 5   | Split `zone: null` into "implicit single surface" and "all zones"                                 | M    | medium — `sharesSurface`, `zoneCoverage`, the cascade, the coverage notice      |
| 6   | Empty-zone state for the fit panel: collapsed or absent, not open and inert (conventions 7 and 8) | S    | low                                                                             |
| 7   | Drop a file onto a zone row (convention 15)                                                       | S    | low                                                                             |

**Item 3 is the whole spike's answer.** Everything else is a week's worth of small, safe work; item
3 is the one that can go wrong, and it goes wrong quietly — a placement written to the wrong
instance is a design that cuts in the wrong place and still exports. It should be its own branch,
with its own live verification, before any of the rest lands.

## The thing that makes it worth doing, measured

[docs/findings/zone-rebuild-cost.md](../findings/zone-rebuild-cost.md), same machine, same day:

- All five zones in one rebuild: **4.0 s** (17.0 s with a design large enough to cover them).
- Five zones bound one at a time: **8.3 s** total (22.1 s), but **no single wait over 5.3 s**.

So zone-first does **not** make the work smaller — it makes it about twice as frequent. What it buys
is the shape of the wait: five short pauses each naming one surface, against one long pause naming
nothing. Convention 23 wants an operation over a few seconds to be cancellable and to name what it
is working on, and a per-zone rebuild is a far easier thing to make both than a whole-assembly one.

That is a real argument for the design, and it is the opposite of the one you would guess. It
should be in the plan, because "zone-first is faster" is the claim someone will make and it is not
true.

## Components this needs and the system lacks

Proposed, not built, per convention 31 — both carry PROPOSED in their titles so they cannot be
mistaken for specs of shipped UI:

- [`components/misc/ZoneListRow.prompt.md`](../../design-system/components/misc/ZoneListRow.prompt.md)
- [`components/misc/FilamentSlotStrip.prompt.md`](../../design-system/components/misc/FilamentSlotStrip.prompt.md)

Convention 31 also names **viewport selection state** as a gap. It is not proposed here because
this run settled it in code rather than in a spec — the placement frame and its handles are both
`--text` now, instead of accent blue. (An earlier pass in the same run did try a `--text` line
against `--bg` handles; the handles measured 1.06:1 against the stage and were dropped, which is
exactly the kind of thing a spec written ahead of the code would have enshrined.) A spec should
follow the shipped thing, not lead it, so that one is worth writing after this lands and can
describe what exists.

## What the prototype deliberately did not do

`src/state/artwork.ts`, `src/ui/artworkListPanel.ts` and `src/state/persist.ts` were not
restructured — the spike is one new file, one field, and a CSS block. That constraint is why
findings 3, 4 and 5 are stated in terms of what the prototype _couldn't_ do: those are the edges of
the feature, and hitting them from outside is a cheaper way to find them than starting the rewrite.
