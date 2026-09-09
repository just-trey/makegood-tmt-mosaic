import { engine } from '../geometry/csg';
import { cutAll, type CutJob, type CutResult } from '../geometry/inlay';

/** Runs the cut off the main thread so a long fill never freezes the page. */
export type WorkerRequest = { type: 'cut'; gen: number; job: Omit<CutJob, 'wasm'> };
export type WorkerReply =
  | { type: 'progress'; gen: number; message: string; frac: number }
  | { type: 'done'; gen: number; result: Omit<CutResult, 'slotsUsed'> & { slotsUsed: number[] } }
  | { type: 'error'; gen: number; message: string };

const ctx = self as unknown as { postMessage: (m: WorkerReply, transfer?: Transferable[]) => void; onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null };

ctx.onmessage = async (e) => {
  const { gen, job } = e.data;
  try {
    const wasm = await engine();
    const result = await cutAll({ ...job, wasm }, (message, frac) => {
      ctx.postMessage({ type: 'progress', gen, message, frac });
    });
    const transfer: Transferable[] = [];
    for (const p of result.pieces) {
      transfer.push(p.body.pos.buffer, p.body.idx.buffer);
      for (const i of p.inlays) transfer.push(i.mesh.pos.buffer, i.mesh.idx.buffer);
    }
    // A piece left uncut shares its buffers with the input; those were copied in, so they are ours to hand back.
    ctx.postMessage({ type: 'done', gen, result: { ...result, slotsUsed: [...result.slotsUsed] } }, [...new Set(transfer)]);
  } catch (err) {
    ctx.postMessage({ type: 'error', gen, message: err instanceof Error ? err.message : String(err) });
  }
};
