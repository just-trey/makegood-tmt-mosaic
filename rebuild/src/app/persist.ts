import { initialState, type AppState } from './state';

const KEY = 'tmt-inlay.session.v1';
const MAX_BYTES = 4_500_000;

export interface SavedSession {
  savedAt: number;
  state: AppState;
}

/** Save the session. Images ride along as data URLs; a session too big for the browser is trimmed to the designs that fit and the caller is told. */
export function saveSession(state: AppState): { ok: boolean; dropped: string[] } {
  const dropped: string[] = [];
  let s = state;
  for (;;) {
    const json = JSON.stringify({ savedAt: Date.now(), state: s } satisfies SavedSession);
    if (json.length <= MAX_BYTES) {
      try {
        localStorage.setItem(KEY, json);
        return { ok: true, dropped };
      } catch {
        return { ok: false, dropped };
      }
    }
    const big = s.designs
      .map((d, i) => ({ i, size: (d.imageDataUrl?.length ?? 0) + (d.svgText?.length ?? 0) }))
      .sort((a, b) => b.size - a.size)[0];
    if (!big) return { ok: false, dropped };
    dropped.push(s.designs[big.i].name);
    s = { ...s, designs: s.designs.filter((_, i) => i !== big.i) };
  }
}

export function loadSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedSession;
    if (!parsed || typeof parsed !== 'object' || !parsed.state) return null;
    // Fill anything a newer version added.
    return { savedAt: parsed.savedAt, state: { ...initialState(), ...parsed.state } };
  } catch {
    return null;
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}
