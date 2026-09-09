#!/usr/bin/env bash
# Assemble the rebuild-experiment repo from this checkout plus the gitignored stubs/.
# Usage: experiment/bootstrap.sh [<target dir>]   (default ../tmt-mosaic-rebuild)
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
OUT=${1:-"$ROOT/../tmt-mosaic-rebuild"}

if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
  echo "refusing to write into non-empty $OUT" >&2
  exit 1
fi

mkdir -p "$OUT"/reference/{parts,artwork,brand,verified-prints}

cp "$HERE/PROMPT.md" "$HERE/EVAL.md" "$OUT"/
cp "$HERE/AGENTS.md" "$OUT"/AGENTS.md
cp "$HERE/AGENTS.md" "$OUT"/CLAUDE.md

cp "$ROOT"/public/stl/*.3mf "$OUT"/reference/parts/
sed 's#"stl/#"#' "$ROOT"/public/stl/parts.json > "$OUT"/reference/parts/parts.json
cp "$ROOT"/public/patterns/*.svg "$HERE"/artwork/* "$OUT"/reference/artwork/
cp "$ROOT"/public/assets/makegood-logo.png "$OUT"/reference/artwork/
cp "$ROOT"/public/filaments.json "$OUT"/reference/
cp "$ROOT"/design-system/tokens/{colors,spacing,typography}.css "$OUT"/reference/brand/
cp "$ROOT"/public/assets/makegood-logo.png "$OUT"/reference/brand/

# Verified slicer projects, from gitignored stubs/. "src|description" per line.
VERIFIED=(
  "chair-body-all-parts.3mf|MakeGood's own Bambu Studio project for the complete chair: 12 plates, orientations, packing and per-part print overrides checked by a human. The chair's ground truth."
  "chair-tower-reference-snapmaker.3mf|The chair exported with four filaments on a Snapmaker U1 (270mm bed), every plate's prime tower dragged into place in the slicer."
  "chair-tower-reference-a1.3mf|Same as above on a Bambu A1 (256mm bed)."
  "whlle-reference.3mf|The wheel as MakeGood ships it: the shipped product's own slicer project. (Filename typo is original.)"
  "mosaic-wheel-snapmaker.3mf|A wheel export on the Snapmaker U1 with the hub cap placed relative to the top half and the prime tower placed by hand."
  "mosaic-wheel-mount-left.3mf|The left wheel mount's reference project, carrying the brim setting the part prints with."
  "dead-zones.3mf|The printed wheel only (two halves plus the cap), useful for seeing what the wheel covers on the assembled chair."
)
# Extra test designs, same source. "src|dest" per line.
ARTWORK=(
  "mario.png|mario.png"
  "mario.webp|mario.webp"
  "dino ring.svg|dino-ring.svg"
  "temp/snoopy.svg|snoopy.svg"
  "temp/Sunny MLP 2.svg|sunny-mlp.svg"
  "temp/pappa.svg|pappa.svg"
  "temp/smurfette.svg|smurfette.svg"
)

missing=()
{
  echo "# Verified prints"
  echo
  echo "Slicer projects checked by a human on a real printer. Treat as ground truth for orientation, plate layout, prime tower position and print settings."
  echo
  echo "| File | What it is |"
  echo "| ---- | ---------- |"
  for entry in "${VERIFIED[@]}"; do
    src=${entry%%|*}; desc=${entry#*|}
    if [ -f "$ROOT/stubs/$src" ]; then
      cp "$ROOT/stubs/$src" "$OUT/reference/verified-prints/$src"
      echo "| \`$src\` | $desc |"
    else
      missing+=("stubs/$src")
    fi
  done
  echo
  echo "The footrest's own reference project is not in the list above. If you have it, add it here with a description."
} > "$OUT/reference/verified-prints/MANIFEST.md"

{
  echo "# Test designs"
  echo
  echo "| File | What it is |"
  echo "| ---- | ---------- |"
  echo "| \`cow.svg\`, \`dalmatian.svg\`, \`zebra.svg\`, \`tiger.svg\` | Flat-color pattern tiles, 60 × 60mm, two colors each. Meant for repeating fill. |"
  echo "| \`makegood-logo.png\` | The MakeGood logo, RGBA with a transparent background. |"
  echo "| \`gradient.svg\` | One flat-filled shape beside one gradient-filled shape. For the unsupported-content scenario. |"
  for entry in "${ARTWORK[@]}"; do
    src=${entry%%|*}; dest=${entry#*|}
    if [ -f "$ROOT/stubs/$src" ]; then
      cp "$ROOT/stubs/$src" "$OUT/reference/artwork/$dest"
      echo "| \`$dest\` | Volunteer-style test design. |"
    else
      missing+=("stubs/$src")
    fi
  done
  if [ -d "$ROOT/stubs/raster stock" ]; then
    mkdir -p "$OUT/reference/artwork/photos"
    cp "$ROOT/stubs/raster stock"/* "$OUT/reference/artwork/photos/"
    echo "| \`photos/\` | Stock photographs, for the photograph scenario. |"
  else
    missing+=("stubs/raster stock/ (run: node scripts/fetch-raster-stock.mjs)")
  fi
} > "$OUT/reference/artwork/MANIFEST.md"

cat > "$OUT/LOG.md" <<'LOG'
# Experiment log

## fable
Harness / model:
Round 0 sent:            ended:
Follow-up 1 sent:        ended:
Cost:
Notes:

## codex
Harness / model:
Round 0 sent:            ended:
Follow-up 1 sent:        ended:
Cost:
Notes:
LOG

cd "$OUT"
git init -q -b main
git add -A
git -c user.name="${GIT_AUTHOR_NAME:-experiment}" -c user.email="${GIT_AUTHOR_EMAIL:-experiment@localhost}" \
  commit -q -m "Experiment kit: brief, acceptance scenarios, reference files"
git branch fable
git branch codex

echo "assembled $OUT"
echo "  $(git ls-files | wc -l | tr -d ' ') files, $(du -sh . | cut -f1) on disk"
if [ ${#missing[@]} -gt 0 ]; then
  echo
  echo "not found in $ROOT/stubs/ (add them and re-run, or fill MANIFEST.md by hand):"
  printf '  %s\n' "${missing[@]}"
fi
echo
echo "next:"
echo "  create an empty private GitHub repo, then"
echo "  cd $OUT && git remote add origin <url> && git push -u origin main fable codex"
