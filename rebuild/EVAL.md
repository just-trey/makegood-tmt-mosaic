# Acceptance scenarios

The same scenarios, in the same order, for every build. Score each one on the sheet at the
bottom. Open every exported 3MF in Bambu Studio (and one in Snapmaker Orca) before scoring:
the 3D view lying and the slicer telling the truth is the most common failure.

Files named here live in `reference/artwork/` and `reference/parts/`.

## S1. Two-color SVG on the wheel

- Load `cow.svg` (60 × 60mm, two flat colors) on the wheel, Bambu X1C.
- Scale it to cover most of the face. Export.
- **Pass:** opens in Bambu Studio with two recess objects and the body, three slots assigned,
  wheel half oriented and placed as `verified-prints` has it, prime tower clear of the part.

## S2. Traced logo on a hubcap, cut to silhouette

- Set the hubcap to 180mm. Load `makegood-logo.png` (transparent background).
- Turn on cut-to-outline. Export for Snapmaker U1.
- **Pass:** the disc is the logo's silhouette with the four clips intact, the colors fit in four
  slots including the body, the slicer opens it with no repair prompt.

## S3. Repeating fill on the footrest

- Load `zebra.svg` on the footrest as a repeating fill, tile size 40mm.
- Export for Bambu X1C.
- **Pass:** the pattern tiles across the whole face, black shares one slot, the footrest stands
  on its long edge as the verified print has it, support settings match the verified print.

## S4. Depth guards

- On the wheel with `cow.svg` loaded, set the default depth to 0, then to 60mm.
- **Pass:** 0 is raised to a depth that prints and says so; 60mm is capped at what the part has
  and says so, naming the part and the number. Neither crashes or exports a hole.

## S5. Unsupported SVG content

- Load `gradient.svg` (a shape with a gradient fill next to a flat one).
- **Pass:** the flat shape loads, the gradient one is skipped, and a warning names what was
  skipped and why. No crash, export still works.

## S6. Design across a chair join

- Pick the chair body, Standard casters, left side surface. Download the template.
- Load `dino-ring.svg` (from the manifest, if provided; otherwise `tiger.svg`) so it crosses at
  least one join between printed pieces. Export for Bambu X1C.
- **Pass:** the template is true size and marks the joins; the export has every piece the chair
  needs on plates laid out as the verified chair project has them, the design is cut into each
  piece it crosses and lines up at the join, the three pieces that carry no design are still in
  the export uncut.

## S7. Photograph down to four slots

- Load a photograph (from the manifest, if provided; otherwise any JPG of a face or a pet) on
  the wheel. Reduce it to three colors plus the body. Export for Bambu X1C.
- **Pass:** four slots total, edges smooth at print size, no speckle smaller than a 0.4mm nozzle
  can lay down, and the tool says how many colors and regions it found.

## S8. Session restore

- With S1 set up, reload. Accept the restore.
- **Pass:** the part, design, placement, depth and colors come back as they were.

## Score sheet

One row per scenario per build. `Result` is one of **pass / partial / fail / not built**.
`Steps` is the number of clicks or edits a volunteer needed from a fresh load. Time is minutes
from opening the tool to a file the slicer accepts.

| Scenario | Result | Steps | Minutes | Slicer opened clean? | Warnings clear? | Notes |
| -------- | ------ | ----- | ------- | -------------------- | --------------- | ----- |
| S1       |        |       |         |                      |                 |       |
| S2       |        |       |         |                      |                 |       |
| S3       |        |       |         |                      |                 |       |
| S4       |        |       |         |                      |                 |       |
| S5       |        |       |         |                      |                 |       |
| S6       |        |       |         |                      |                 |       |
| S7       |        |       |         |                      |                 |       |
| S8       |        |       |         |                      |                 |       |

Build-level, filled once per build:

| Measure                                         | Value |
| ----------------------------------------------- | ----- |
| Wall-clock time, first prompt to last commit     |       |
| Follow-up prompts used (see README protocol)     |       |
| Cost, if the harness reports it                  |       |
| Lines of code, `git ls-files \| xargs wc -l`     |       |
| Runtime dependencies                             |       |
| Time to run on a clean machine, per its README   |       |
| Runs with no network after first load?           |       |
| Would you hand it to a volunteer today?          |       |
