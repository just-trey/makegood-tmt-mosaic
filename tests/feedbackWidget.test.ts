// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initFeedbackWidget } from '../src/ui/feedbackWidget';

const ENDPOINT = 'https://formspree.test/f/abc';

/** The parts of index.html's feedback block this module touches, and nothing else. */
function mountFeedbackDom(): void {
  document.body.innerHTML = `
    <div id="right"><div id="warnings"></div>
    <div id="feedback" hidden>
      <div id="feedback-popover" hidden>
        <button id="feedback-close"></button>
        <form id="feedback-form">
          <textarea id="feedback-message"></textarea>
          <input type="email" id="feedback-email" />
          <button type="submit" id="feedback-send">Send feedback</button>
        </form>
        <p id="feedback-status"></p>
      </div>
      <button id="feedback-trigger" aria-expanded="false">Feedback</button>
    </div></div>`;
}

const el = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;
const widget = () => el('#feedback');
const popover = () => el('#feedback-popover');
const trigger = () => el<HTMLButtonElement>('#feedback-trigger');
const form = () => el<HTMLFormElement>('#feedback-form');
const message = () => el<HTMLTextAreaElement>('#feedback-message');
const send = () => el<HTMLButtonElement>('#feedback-send');
const status = () => el('#feedback-status');

const submit = (): void => {
  form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
};

/** A fetch that stays pending until the test resolves it, so the in-flight state is observable. */
function deferredFetch(): { resolve: (r: unknown) => void; fetch: ReturnType<typeof vi.fn> } {
  let resolve!: (r: unknown) => void;
  const pending = new Promise((r) => (resolve = r));
  return { resolve, fetch: vi.fn(() => pending) };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  mountFeedbackDom();
  vi.stubGlobal('__FEEDBACK_ENDPOINT__', ENDPOINT);
  vi.stubGlobal('__APP_VERSION__', '9.9.9');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok: true, status: 200 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the widget only exists where an endpoint was configured', () => {
  it('stays hidden and unwired when the endpoint is empty', () => {
    vi.stubGlobal('__FEEDBACK_ENDPOINT__', '');
    initFeedbackWidget();

    expect(widget().hidden).toBe(true);
    trigger().click();
    expect(popover().hidden).toBe(true);
  });

  it('renders when the endpoint is set', () => {
    initFeedbackWidget();
    expect(widget().hidden).toBe(false);
  });
});

describe('opening and closing', () => {
  beforeEach(() => initFeedbackWidget());

  it('toggles on the trigger and tracks it in aria-expanded', () => {
    trigger().click();
    expect(popover().hidden).toBe(false);
    expect(trigger().getAttribute('aria-expanded')).toBe('true');

    trigger().click();
    expect(popover().hidden).toBe(true);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on Escape', () => {
    trigger().click();
    dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(popover().hidden).toBe(true);
  });

  it('stays open when the viewport behind it is clicked, so orbiting cannot close it', () => {
    trigger().click();

    el('#right').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));

    expect(popover().hidden).toBe(false);
  });

  it('closes on the × button', () => {
    trigger().click();
    el('#feedback-close').click();
    expect(popover().hidden).toBe(true);
  });

  it('leaves the Escape key to a modal dialog that is open over it', () => {
    trigger().click();
    document.body.insertAdjacentHTML('beforeend', '<dialog id="help-dialog" open></dialog>');

    dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(popover().hidden).toBe(false);

    el('#help-dialog').remove();
    dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(popover().hidden).toBe(true);
  });

  it('returns focus to the trigger when closed from inside the panel', () => {
    trigger().click();
    dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.activeElement).toBe(trigger());
  });

  it('leaves focus alone when Escape is pressed somewhere else in the app', () => {
    document.body.insertAdjacentHTML('beforeend', '<input id="p-elsewhere" />');
    const elsewhere = el<HTMLInputElement>('#p-elsewhere');

    trigger().click();
    elsewhere.focus();
    dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(popover().hidden).toBe(true);
    expect(document.activeElement).toBe(elsewhere);
  });

  it('lets #warnings reserve the trigger row only where a trigger renders', () => {
    expect(el('#right').classList.contains('has-feedback')).toBe(true);
  });
});

describe('submitting', () => {
  beforeEach(() => {
    initFeedbackWidget();
    trigger().click();
    message().value = '  the wheel came out hollow  ';
    el<HTMLInputElement>('#feedback-email').value = 'maker@example.com';
  });

  it('posts the trimmed message, the email and the app version as JSON', async () => {
    submit();
    await flush();

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Accept).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      message: 'the wheel came out hollow',
      email: 'maker@example.com',
      version: '9.9.9',
    });
  });

  it('sends nothing when the message is only whitespace', () => {
    message().value = '   ';
    submit();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('replaces the form with a thank-you on success', async () => {
    submit();
    await flush();

    expect(form().hidden).toBe(true);
    expect(status().textContent).toBe('Thanks, we got it.');
    expect(status().classList.contains('error')).toBe(false);
  });

  it('starts from a fresh form the next time it is opened after a send', async () => {
    submit();
    await flush();

    trigger().click();
    trigger().click();

    expect(form().hidden).toBe(false);
    expect(message().value).toBe('');
    expect(status().textContent).toBe('');
    expect(send().disabled).toBe(false);
  });

  it('names the status code and keeps what was typed on an HTTP error', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 503 } as Response);
    submit();
    await flush();

    expect(status().textContent).toBe("Couldn't send that (HTTP 503). Try again in a moment.");
    expect(status().classList.contains('error')).toBe(true);
    expect(form().hidden).toBe(false);
    expect(message().value).toBe('  the wheel came out hollow  ');
    expect(send().disabled).toBe(false);
  });

  it('points at GitHub rather than a retry when the form itself refuses', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 429 } as Response);
    submit();
    await flush();

    // 429 is Formspree's monthly cap: retrying cannot clear it (docs/troubleshooting.md).
    expect(status().textContent).toBe(
      "Couldn't send that (HTTP 429). Use the GitHub link below instead.",
    );
  });

  it('fires exactly one analytics event per send, on either outcome', async () => {
    const tracked: unknown[][] = [];
    vi.stubGlobal('umami', { track: (...args: unknown[]) => tracked.push(args) });

    submit();
    await flush();
    expect(tracked).toEqual([['feedback_sent', { status: 'ok' }]]);

    tracked.length = 0;
    trigger().click(); // close, resetting after the success
    trigger().click();
    message().value = 'again';
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 429 } as Response);
    submit();
    await flush();
    expect(tracked).toEqual([['feedback_sent', { status: 'error' }]]);
  });

  it('keeps an accurate HTTP message when the analytics call throws', async () => {
    vi.stubGlobal('umami', {
      track: () => {
        throw new Error('beacon blocked');
      },
    });
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 429 } as Response);
    submit();
    await flush();

    // Not overwritten by the offline line: a 429 is a cap, and "check your connection" is wrong.
    expect(status().textContent).toBe(
      "Couldn't send that (HTTP 429). Use the GitHub link below instead.",
    );
  });

  it('still reports a success whose analytics call threw', async () => {
    vi.stubGlobal('umami', {
      track: () => {
        throw new Error('beacon blocked');
      },
    });
    submit();
    await flush();

    expect(status().textContent).toBe('Thanks, we got it.');
    expect(form().hidden).toBe(true);
  });

  it('reports a connection failure when fetch rejects', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    submit();
    await flush();

    expect(status().textContent).toBe("Couldn't send that. Check your connection.");
    expect(status().classList.contains('error')).toBe(true);
    expect(message().value).toBe('  the wheel came out hollow  ');
  });

  it('omits the email key entirely when the field was left blank', async () => {
    el<HTMLInputElement>('#feedback-email').value = '  ';
    submit();
    await flush();

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).not.toHaveProperty('email');
  });

  it('aborts a send that hangs, instead of stranding the form at "Sending…"', async () => {
    vi.useFakeTimers();
    // A fetch that only settles when its signal aborts, the way a real hung request behaves.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_res, rej) =>
            init.signal?.addEventListener('abort', () => rej(new Error('aborted'))),
          ),
      ),
    );

    submit();
    expect(status().textContent).toBe('Sending…');

    await vi.advanceTimersByTimeAsync(15_000);

    expect(status().textContent).toBe("Couldn't send that. Check your connection.");
    expect(send().disabled).toBe(false);
    expect(message().value).toBe('  the wheel came out hollow  ');
    vi.useRealTimers();
  });

  it('clears a stale error banner when the form is reopened', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 503 } as Response);
    submit();
    await flush();
    expect(status().textContent).not.toBe('');

    trigger().click();
    trigger().click();

    expect(status().textContent).toBe('');
    // The typed message is the only copy, so reopening after a failure keeps it.
    expect(message().value).toBe('  the wheel came out hollow  ');
  });

  it('says so instead of going quiet when the message is only whitespace', () => {
    message().value = '   ';
    submit();

    expect(fetch).not.toHaveBeenCalled();
    expect(status().textContent).toBe('Add a note before sending.');
  });

  it('never drops the status out of the accessibility tree, only its box', async () => {
    expect(status().hidden).toBe(false);
    expect(status().classList.contains('show')).toBe(false);

    submit();
    await flush();

    expect(status().hidden).toBe(false);
    expect(status().classList.contains('show')).toBe(true);
  });

  it('puts focus somewhere reachable when reopened onto a hidden form', async () => {
    const { fetch: pendingFetch, resolve } = deferredFetch();
    vi.stubGlobal('fetch', pendingFetch);
    submit();
    trigger().click();
    resolve({ ok: true, status: 200 });
    await flush();

    trigger().click();

    expect(form().hidden).toBe(true);
    expect(document.activeElement).toBe(el('#feedback-close'));
  });

  it('keeps a success that landed while the panel was closed', async () => {
    const { fetch: pendingFetch, resolve } = deferredFetch();
    vi.stubGlobal('fetch', pendingFetch);
    submit();

    trigger().click(); // close mid-flight
    resolve({ ok: true, status: 200 });
    await flush();
    trigger().click(); // reopen

    expect(status().textContent).toBe('Thanks, we got it.');
    expect(form().hidden).toBe(true);
  });

  it('still explains itself when reopened during an in-flight send', () => {
    const { fetch: pendingFetch } = deferredFetch();
    vi.stubGlobal('fetch', pendingFetch);
    submit();

    trigger().click();
    trigger().click();

    expect(status().textContent).toBe('Sending…');
    expect(send().disabled).toBe(true);
  });

  it('moves focus off the form it hides on success', async () => {
    send().focus();
    submit();
    await flush();

    expect(document.activeElement).toBe(el('#feedback-close'));
  });

  it('sends once when submitted twice while a send is in flight', async () => {
    const { fetch: pendingFetch, resolve } = deferredFetch();
    vi.stubGlobal('fetch', pendingFetch);

    submit();
    expect(status().textContent).toBe('Sending…');
    expect(send().disabled).toBe(true);

    submit();
    expect(pendingFetch).toHaveBeenCalledTimes(1);

    resolve({ ok: true, status: 200 });
    await flush();
    expect(status().textContent).toBe('Thanks, we got it.');
  });
});
