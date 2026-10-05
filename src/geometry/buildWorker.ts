import { startBuildWorker } from './buildWorkerCore';
import type { FromWorker, ToWorker } from './buildWire';

// The DOM lib types `self` as a Window, whose postMessage wants a target origin.
const scope = self as unknown as {
  postMessage(msg: FromWorker, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
};
const handle = startBuildWorker((msg, transfer) => scope.postMessage(msg, transfer));
scope.onmessage = (e) => void handle(e.data);
