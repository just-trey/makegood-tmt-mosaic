const KEY = 'tmt-mosaic:panels';

function read(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((e): e is [string, boolean] => typeof e[1] === 'boolean'),
    );
  } catch {
    return {};
  }
}

// Its own key, not the saved session: "Start fresh" resets the design, not how the user arranged the sidebar.
export function initPanelState(): void {
  const panels = Array.from(document.querySelectorAll<HTMLDetailsElement>('details[data-panel]'));
  const saved = read();
  for (const p of panels) {
    const open = saved[p.dataset.panel ?? ''];
    if (open !== undefined) p.open = open;
  }
  for (const p of panels) {
    p.addEventListener('toggle', () => {
      // Merged over what is stored so a panel this build no longer has keeps its entry.
      const next = { ...read(), [p.dataset.panel ?? '']: p.open };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Storage blocked — panels still toggle, they just reopen next load.
      }
    });
  }
}
