// A module of its own so that it calls asmLoadFullAssembly through the import, which the restore
// tests mock; a call inside parts.ts would bypass the mock.
import { state } from '../state/store';
import { asmLoadFullAssembly, asmLoadWasAbandoned, type AssemblyLoadOutcome } from './parts';

/**
 * Switch to a kind and load it, putting the previous kind, variant and parts back if the load
 * fails or throws. Rolled back rather than staged: the load is live (parts appear as each role
 * arrives), its mid-load guard compares the live array by identity, and each part finds its role
 * through the live `kindId`. A superseded load is not rolled back: the newer switch owns the list.
 */
export async function asmSwitchKindAndLoad(
  kindId: string,
  variantId: string | null,
): Promise<AssemblyLoadOutcome> {
  const { kindId: prevKind, variantId: prevVariant, parts: prevParts } = state.assembly;
  state.assembly.kindId = kindId;
  state.assembly.variantId = variantId;
  // Cleared here, not by asmLoadFullAssembly's confirm-gated clear: the boot's auto-load always
  // fills the list, so a restore raised a second dialog, and cancelling it left the previous kind's
  // parts under the restored `kindId`. Measured 2026-08-24: a restored footrest session exported
  // `mosaic-footrest.3mf` holding the wheel's Top/Bottom/Cap, printable, no warning.
  state.assembly.parts = [];
  let outcome: AssemblyLoadOutcome;
  try {
    // Quiet: the caller reports the failure once, in its own words.
    outcome = await asmLoadFullAssembly({ quiet: true });
  } catch (e) {
    console.error(e);
    outcome = 'failed';
  }
  if (outcome !== 'failed') return outcome;
  state.assembly.kindId = prevKind;
  state.assembly.variantId = prevVariant;
  state.assembly.parts = prevParts;
  // The list put back was mid-load when this switch cleared it, and that load has since given up
  // on it: finish it, or the previous kind comes back with only the roles that had arrived.
  if (asmLoadWasAbandoned(prevParts)) {
    state.assembly.parts = [];
    void asmLoadFullAssembly();
  }
  return outcome;
}
