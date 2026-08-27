// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initHelpPanel } from '../src/ui/helpPanel';
import { track } from '../src/analytics/track';

vi.mock('../src/analytics/track', () => ({ track: vi.fn() }));

/** The parts of index.html's help block this module touches, and nothing else. */
function mountHelpDom(): void {
  document.body.innerHTML = `
    <button id="btn-help"><span id="btn-help-badge"></span></button>
    <dialog id="help-dialog">
      <button id="btn-help-close"></button>
      <nav class="help-toc"><a href="#h-part">Part</a><a href="#h-export">Export</a></nav>
      <section id="h-part"></section>
      <section id="h-export"></section>
    </dialog>`;
  // jsdom implements <dialog> but not showModal's focus/inert side effects; open is enough here.
  const d = document.querySelector<HTMLDialogElement>('#help-dialog')!;
  d.showModal = function () {
    this.open = true;
  };
  d.close = function () {
    this.open = false;
  };
}

const back = (hash: string) => {
  location.hash = hash;
  dispatchEvent(new PopStateEvent('popstate'));
};

beforeEach(() => {
  vi.clearAllMocks();
  mountHelpDom();
  localStorage.clear();
  location.hash = '';
  initHelpPanel();
  document.querySelector<HTMLButtonElement>('#btn-help')!.click();
});

const dialog = () => document.querySelector<HTMLDialogElement>('#help-dialog')!;

describe('the help dialog and browser Back', () => {
  it('closes when Back leaves the section anchors behind', () => {
    expect(dialog().open).toBe(true);

    back('');

    expect(dialog().open).toBe(false);
  });

  it('stays open when Back moves between two of its own sections', () => {
    back('#h-export');
    expect(dialog().open).toBe(true);

    back('#h-part');

    expect(dialog().open).toBe(true);
  });

  it('leaves a closed dialog closed', () => {
    document.querySelector<HTMLButtonElement>('#btn-help-close')!.click();
    expect(dialog().open).toBe(false);

    back('');

    expect(dialog().open).toBe(false);
  });
});

describe('the help dialog itself', () => {
  it('opens from the header button and drops the unread badge', () => {
    expect(dialog().open).toBe(true);
    expect(document.querySelector('#btn-help-badge')!.classList.contains('show')).toBe(false);
  });

  it('shows the unread badge until help has been opened once', () => {
    localStorage.clear();
    mountHelpDom();
    initHelpPanel();

    expect(document.querySelector('#btn-help-badge')!.classList.contains('show')).toBe(true);
  });

  it('closes on a click landing on the backdrop rather than the panel', () => {
    dialog().dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(dialog().open).toBe(false);
  });
});

describe('help analytics', () => {
  it('fires help_opened from the header button', () => {
    expect(track).toHaveBeenCalledWith('help_opened');
  });

  it('fires help_topic_selected with the section id when a TOC pill is clicked', () => {
    document.querySelector<HTMLAnchorElement>('a[href="#h-part"]')!.click();

    expect(track).toHaveBeenCalledWith('help_topic_selected', { topic: 'part' });
  });

  it('does not fire help_topic_selected on close or backdrop clicks', () => {
    document.querySelector<HTMLButtonElement>('#btn-help-close')!.click();
    dialog().dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(track).not.toHaveBeenCalledWith('help_topic_selected', expect.anything());
  });
});
