import { $ } from './dom';
import { track } from '../analytics/track';
import { getAppVersion } from '../version';

/**
 * A floating note-to-the-maintainer, posted straight to Formspree. Deliberately a non-modal
 * popover rather than a <dialog>: the audience is mid-task when something goes wrong, and the
 * part they want to describe has to stay on screen while they describe it. The cost is that
 * Escape and focus return are hand-wired below.
 */

/* A submit the user is sitting in front of, not a background job: a request still open after
   this is one they have already given up on, and leaving it open strands the form at "Sending…"
   with no way back. Armed with AbortController rather than AbortSignal.timeout, which needs
   Safari 16: the app's floor is 15.4 today (Array.prototype.at, src/raster/curve.ts), and where
   the newer call is missing it throws inside the try and reports every send on a working
   connection as a connection failure. */
const TIMEOUT_MS = 15_000;

const SENDING = 'Sending…';
const SENT = 'Thanks, we got it.';
const OFFLINE = "Couldn't send that. Check your connection.";
const EMPTY = 'Add a note before sending.';

/**
 * A 4xx is the form refusing, not the network faltering: 429 is the monthly submission cap and
 * 403 a deactivated form, and neither clears by retrying. Sending them the same "try again" as a
 * 503 is advice that cannot work (docs/troubleshooting.md).
 */
function httpError(status: number): string {
  const remedy =
    status >= 400 && status < 500 ? 'Use the GitHub link below instead.' : 'Try again in a moment.';
  return `Couldn't send that (HTTP ${status}). ${remedy}`;
}

export function initFeedbackWidget(): void {
  // Read at init, not at module scope: a module-level const is captured at import time, which
  // leaves the two branches below unreachable from a test.
  const endpoint = typeof __FEEDBACK_ENDPOINT__ === 'undefined' ? '' : __FEEDBACK_ENDPOINT__;
  if (!endpoint) return;

  const widget = $('#feedback');
  const popover = $('#feedback-popover');
  const trigger = $<HTMLButtonElement>('#feedback-trigger');
  const form = $<HTMLFormElement>('#feedback-form');
  const message = $<HTMLTextAreaElement>('#feedback-message');
  const email = $<HTMLInputElement>('#feedback-email');
  const send = $<HTMLButtonElement>('#feedback-send');
  const status = $('#feedback-status');
  const closeBtn = $<HTMLButtonElement>('#feedback-close');

  widget.hidden = false;
  // Lets #warnings reserve the trigger's row, in the builds that have a trigger.
  widget.parentElement?.classList.add('has-feedback');

  let sending = false;
  let sent = false;

  // Written to, never hidden while the panel is open. A live region that is populated out of the
  // accessibility tree, then revealed, is the shape screen readers routinely fail to announce, so
  // the box is a class rather than a display toggle (styles.css). A send that resolves after the
  // panel is closed still goes unannounced: its result is read on reopen, not spoken.
  function setStatus(text: string, isError: boolean): void {
    status.textContent = text;
    status.classList.toggle('show', text !== '');
    status.classList.toggle('error', isError);
  }

  function reset(): void {
    form.reset();
    form.hidden = false;
    setStatus('', false);
    send.disabled = false;
    sent = false;
  }

  function open(): void {
    popover.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    // A send that landed while the panel was closed leaves the form hidden, and nothing inside a
    // hidden form can take focus.
    (form.hidden ? closeBtn : message).focus();
  }

  /**
   * Closing is what settles the last send, not opening. Clearing on open instead meant a success
   * that landed after the panel was closed was wiped before anyone read it, and an in-flight
   * send reopened to a form with a dead Send button and nothing saying why.
   */
  function close(): void {
    // Only reclaim focus we already had. Escape is a window-level key, and someone pressing it in
    // a left-panel field should not have the caret thrown to the bottom-right corner.
    const hadFocus = popover.contains(document.activeElement);
    if (sent) reset();
    // A failed send keeps what they typed but not its banner: reopening to a "Couldn't send
    // that" describing no attempt in progress reads as a fresh failure.
    else if (!sending) setStatus('', false);
    popover.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (hadFocus) trigger.focus();
  }

  // No outside-click dismiss. The point of a non-modal panel here is that the part stays visible
  // and workable while they describe it, and orbiting the model to look at the problem is a
  // pointerdown on the canvas: light dismiss would close the form mid-sentence. The × and Escape
  // are the ways out, and the trigger toggles.
  trigger.addEventListener('click', () => (popover.hidden ? open() : close()));
  closeBtn.addEventListener('click', () => close());

  addEventListener('keydown', (e) => {
    // A modal <dialog> on top owns the keystroke: help and confirm both showModal(), and Escape
    // aimed at either used to close this panel behind them as well.
    if (e.key === 'Escape' && !popover.hidden && !document.querySelector('dialog[open]')) close();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (sending) return;
    const text = message.value.trim();
    // `required` blocks an empty submit, but not one that is all whitespace. Say so: returning
    // silently leaves Send looking broken.
    if (!text) {
      setStatus(EMPTY, true);
      return;
    }

    sending = true;
    send.disabled = true;
    setStatus(SENDING, false);

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);

    void (async () => {
      try {
        const address = email.value.trim();
        const res = await fetch(endpoint, {
          method: 'POST',
          // Accept: application/json is what makes Formspree answer with JSON instead of
          // redirecting the page to its own thank-you screen.
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          // The key is omitted rather than sent empty: Formspree reads `email` as the reply-to
          // address and validates it, so `''` would fail every send that skipped the field.
          body: JSON.stringify({
            message: text,
            ...(address ? { email: address } : {}),
            version: getAppVersion(
              typeof __APP_VERSION__ === 'undefined' ? undefined : __APP_VERSION__,
            ),
          }),
          signal: abort.signal,
        });
        // Branch rather than an early `return`: returning out of the try skips everything after
        // the finally, which silently cost the HTTP-error path its analytics event.
        if (res.ok) {
          form.hidden = true;
          sent = true;
          setStatus(SENT, false);
          // The focused Send button is inside the form being hidden, which would drop focus to
          // <body> and lose a keyboard user's place.
          closeBtn.focus();
        } else {
          setStatus(httpError(res.status), true);
        }
      } catch {
        // Leave what they typed in place: it is the only copy, and a retry is one click away.
        setStatus(OFFLINE, true);
      } finally {
        clearTimeout(timer);
        sending = false;
        // Not re-enabled on success — the form is gone, and the button goes with it.
        if (!sent) send.disabled = false;
      }
      // Outside the send's try, and inside its own: a throwing beacon in there would have
      // rewritten a delivered report as a failed one, and left loose it escapes as an unhandled
      // rejection instead. Either way the user's report already arrived.
      try {
        track('feedback_sent', { status: sent ? 'ok' : 'error' });
      } catch {
        /* a blocked or broken beacon is not the user's problem */
      }
    })();
  });
}
