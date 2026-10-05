import { buildAssemblyGeometry } from './assembly';
import { decodeInput, packBuild, partBuffers, type FromWorker, type ToWorker } from './buildWire';
import { armCsgFaults } from './csgFault';
import { armCancel, RebuildCancelled, requestCancel } from '../cancel';
import { setProgressSink } from '../progress';
import { clearWarnings, journalWarnings, type WarningCall } from '../warnings';

/**
 * The worker's half of the build, apart from `self` so tests can drive it in-process. One build at
 * a time: the page never sends another until this one has answered (app/buildClient.ts).
 */
export function startBuildWorker(
  post: (msg: FromWorker, transfer: Transferable[]) => void,
): (msg: ToWorker) => Promise<void> {
  const cache = new Map<number, unknown>();
  let running: number | null = null;
  return async (msg) => {
    if (msg.type === 'cancel') {
      if (msg.id === running) requestCancel();
      return;
    }
    const { id } = msg;
    running = id;
    armCancel();
    armCsgFaults(msg.search);
    // Standing state here is never shown; the page replays the calls onto its own list.
    clearWarnings();
    const warnings: WarningCall[] = [];
    journalWarnings(warnings);
    // Once per percent: the curtain shows whole percents, and a union loop reports per merge.
    let shown = -1;
    setProgressSink((fraction) => {
      const pct = Math.round(fraction * 100);
      if (pct === shown) return;
      shown = pct;
      post({ type: 'progress', id, fraction }, []);
    });
    try {
      const input = decodeInput(msg.input, cache);
      const built = await buildAssemblyGeometry(input);
      if (!built) post({ type: 'done', id, build: null, warnings }, []);
      else {
        const { wire, transfer } = packBuild(built, input.parts, partBuffers(input.parts));
        post({ type: 'done', id, build: wire, warnings }, transfer);
      }
    } catch (e) {
      if (e instanceof RebuildCancelled) post({ type: 'cancelled', id }, []);
      else post({ type: 'failed', id, message: (e as Error)?.message ?? String(e), warnings }, []);
    } finally {
      journalWarnings(null);
      setProgressSink(null);
      running = null;
    }
  };
}
