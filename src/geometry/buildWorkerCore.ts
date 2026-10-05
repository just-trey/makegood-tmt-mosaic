import { buildAssemblyGeometry } from './assembly';
import {
  decodeInput,
  packBuild,
  partBuffers,
  WireError,
  type FromWorker,
  type ToWorker,
} from './buildWire';
import { armCsgFaults } from './csgFault';
import { takeEngineTrapped } from './manifold';
import { PartCache } from './partCache';
import { armCancel, RebuildCancelled, requestCancel } from '../cancel';
import { setProgressSink } from '../progress';
import { clearWarnings, journalWarnings, type WarningCall } from '../warnings';

/**
 * The worker's half of the build, apart from `self` so tests can drive it in-process. One build at
 * a time: the page never sends another until this one has answered (app/buildClient.ts).
 */
export function startBuildWorker(post: (msg: FromWorker, transfer: Transferable[]) => void): {
  onMessage: (msg: ToWorker) => Promise<void>;
  onMessageError: () => void;
} {
  const cache = new Map<number, unknown>();
  // Dropped with the worker, which the page replaces after a trap or a failed build.
  const partCache = new PartCache();
  let running: number | null = null;
  const onMessage = async (msg: ToWorker): Promise<void> => {
    if (msg.type === 'cancel') {
      if (msg.id === running) requestCancel();
      return;
    }
    const { id } = msg;
    running = id;
    armCancel();
    armCsgFaults(msg.search);
    takeEngineTrapped();
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
      const cached = partCache.begin(input.parts);
      const built = await buildAssemblyGeometry(input, cached);
      const trapped = takeEngineTrapped();
      const { reused, cut } = cached;
      if (!built) post({ type: 'done', id, build: null, warnings, trapped, reused, cut }, []);
      else {
        const { wire, transfer } = packBuild(built, input.parts, partBuffers(input.parts));
        post({ type: 'done', id, build: wire, warnings, trapped, reused, cut }, transfer);
      }
    } catch (e) {
      if (e instanceof RebuildCancelled)
        post({ type: 'cancelled', id, trapped: takeEngineTrapped() }, []);
      else {
        const message = (e as Error)?.message ?? String(e);
        post({ type: 'failed', id, message, warnings, wire: e instanceof WireError }, []);
      }
    } finally {
      journalWarnings(null);
      setProgressSink(null);
      running = null;
    }
  };
  // Nothing in a message that failed to arrive says which build it was; the page has one pending.
  const onMessageError = (): void => post({ type: 'unreadable' }, []);
  return { onMessage, onMessageError };
}
