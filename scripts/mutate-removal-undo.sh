#!/usr/bin/env bash
# Mutation run for the removal-undo guards: each mutant must fail a test in tests/artworkListPanel.test.ts.
# Run from the repo root with a clean tree; it restores src/ after every mutant.
set -u
cd "$(dirname "$0")/.."
A=src/state/artwork.ts
P=src/ui/artworkListPanel.ts

run() {
  if npx vitest run tests/artworkListPanel.test.ts >/dev/null 2>&1; then
    echo "SURVIVED  $1"
  else
    echo "killed    $1"
  fi
  git checkout -q -- src
}

sed -i 's/if (removal.fingerprint !== editFingerprint()) {/if (false \&\& removal.fingerprint !== editFingerprint()) {/' $A
run "offer never ends (fingerprint check off)"
sed -i "s/if (document.querySelector('.artwork-removed') \&\& !removalOffer()) renderArtworkList();//" $P
run "stale line never swept"
sed -i 's/if (isEditable(e.target) || document/if (document/' $P
run "Ctrl+Z fires inside a field"
sed -i 's/colorSettings: copyColorSettings(state.colorSettings),/colorSettings: state.colorSettings,/' $A
run "colorSettings kept by reference"
sed -i 's/for (const n of r.notices) {/for (const n of []) {/' $A
run "dismissed notices not re-raised"
sed -i 's/ || e.shiftKey || e.altKey//' $P
run "Ctrl+Shift+Z counts as Undo"
sed -i 's/  state.parsed = r.parsed;/  state.parsed = null;/' $A
run "parsed not restored"
sed -i 's/  Object.assign(state, r.placement);//' $A
run "placement not restored"
sed -i 's/state.assembly.variantId,$/null,/' $A
run "variant switch not in fingerprint"
sed -i 's/state.assembly.kindId,$/null,/' $A
run "kind switch not in fingerprint"
sed -i 's/    state.artworks,$/    null,/' $A
run "instances (placement, zone) not in fingerprint"
