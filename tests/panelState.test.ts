// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { initPanelState } from '../src/ui/panelState';

const KEY = 'tmt-mosaic:panels';
const mount = () => {
  document.body.innerHTML = `
    <details data-panel="part" open><summary>Part</summary></details>
    <details data-panel="colors" open><summary>Colors</summary></details>
    <details data-panel="export" open><summary>Export</summary></details>`;
};
const panel = (id: string) => document.querySelector<HTMLDetailsElement>(`[data-panel="${id}"]`)!;
const toggle = async (id: string, open: boolean) => {
  panel(id).open = open;
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  localStorage.clear();
  mount();
});

describe('panel open/closed state', () => {
  it('remembers a collapsed panel across a reload and leaves the rest open', async () => {
    initPanelState();
    await toggle('part', false);
    await toggle('colors', false);
    mount();
    initPanelState();
    expect(panel('part').open).toBe(false);
    expect(panel('colors').open).toBe(false);
    expect(panel('export').open).toBe(true);
  });

  it('remembers a panel the user reopened', async () => {
    initPanelState();
    await toggle('part', false);
    await toggle('part', true);
    mount();
    initPanelState();
    expect(panel('part').open).toBe(true);
  });

  it('leaves every panel open when nothing is stored', () => {
    initPanelState();
    expect(Array.from(document.querySelectorAll('details')).every((d) => d.open)).toBe(true);
  });

  it('ignores a corrupt entry', () => {
    localStorage.setItem(KEY, '{"part":"no","colors":false');
    initPanelState();
    expect(panel('part').open).toBe(true);
    localStorage.setItem(KEY, '[false]');
    initPanelState();
    expect(panel('part').open).toBe(true);
  });

  it('still toggles when storage throws', async () => {
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.getItem = () => {
      throw new Error('blocked');
    };
    Storage.prototype.setItem = () => {
      throw new Error('blocked');
    };
    try {
      initPanelState();
      await toggle('part', false);
      expect(panel('part').open).toBe(false);
      expect(panel('export').open).toBe(true);
    } finally {
      Storage.prototype.getItem = getItem;
      Storage.prototype.setItem = setItem;
    }
  });

  it('keeps an unknown stored panel when another is toggled', async () => {
    localStorage.setItem(KEY, '{"gone":false}');
    initPanelState();
    await toggle('part', false);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ gone: false, part: false });
  });
});
