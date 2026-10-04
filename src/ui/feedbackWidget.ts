import { $ } from './dom';
import { track } from '../analytics/track';
import { getAppVersion } from '../version';

/**
 * A floating note-to-the-maintainer posted to Formspree. A non-modal popover, not a <dialog>: the
 * audience is mid-task and the part they're describing must stay on screen. Cost: Escape and focus
 * return are hand-wired below.
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

/** A 4xx is the form refusing, not the network faltering (429 monthly cap, 403 deactivated form); neither clears by retrying, so the 503 "try again" would be advice that can't work (docs/troubleshooting.md). */
function httpError(status: number): string {
  const remedy =
    status >= 400 && status < 500 ? 'Use the GitHub link below instead.' : 'Try again in a moment.';
  return `Couldn't send that (HTTP ${status}). ${remedy}`;
}

export function initFeedbackWidget(): void {
  // Read at init, not module scope: an import-time const leaves the two branches below unreachable from a test.
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

  // Written to, never hidden while open: a live region populated out of the accessibility tree and
  // then revealed is routinely not announced, so the box is a class, not a display toggle
  // (styles.css). A send resolving after close goes unannounced; its result is read on reopen.
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
    // A send that landed while closed leaves the form hidden, and nothing in a hidden form takes focus.
    (form.hidden ? closeBtn : message).focus();
  }

  /** Closing settles the last send, not opening: clearing on open wiped a success that landed while closed before anyone read it, and an in-flight send reopened to a dead Send button with no explanation. */
  function close(): void {
    // Only reclaim focus we had: Escape is window-level, and pressing it in a left-panel field shouldn't throw the caret to the bottom-right.
    const hadFocus = popover.contains(document.activeElement);
    if (sent) reset();
    // A failed send keeps what they typed but not its banner: reopening to a "Couldn't send that" for no attempt in progress reads as a fresh failure.
    else if (!sending) setStatus('', false);
    popover.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (hadFocus) trigger.focus();
  }

  // No outside-click dismiss: the point of a non-modal panel is the part staying workable, and
  // orbiting the model to look at the problem is a canvas pointerdown that would close the form
  // mid-sentence. × and Escape are the ways out; the trigger toggles.
  trigger.addEventListener('click', () => (popover.hidden ? open() : close()));
  closeBtn.addEventListener('click', () => close());

  addEventListener('keydown', (e) => {
    // A modal <dialog> on top owns the keystroke: help and confirm showModal(), and Escape at either closed this panel behind them too.
    if (e.key === 'Escape' && !popover.hidden && !document.querySelector('dialog[open]')) close();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (sending) return;
    const text = message.value.trim();
    // `required` blocks an empty submit but not all-whitespace; say so, or Send looks broken.
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
          // Accept: application/json makes Formspree answer JSON instead of redirecting to its thank-you page.
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          // Omitted, not sent empty: Formspree reads `email` as reply-to and validates it, so `''` fails every send that skipped the field.
          body: JSON.stringify({
            message: text,
            ...(address ? { email: address } : {}),
            version: getAppVersion(
              typeof __APP_VERSION__ === 'undefined' ? undefined : __APP_VERSION__,
            ),
          }),
          signal: abort.signal,
        });
        // Branch, not an early `return`: returning out of the try skips everything after the finally, which silently cost the HTTP-error path its analytics event.
        if (res.ok) {
          form.hidden = true;
          sent = true;
          setStatus(SENT, false);
          // The focused Send button is in the form being hidden, which would drop focus to <body> and lose a keyboard user's place.
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
      // Outside the send's try and inside its own: a throwing beacon there would rewrite a delivered report as failed, and loose it escapes as an unhandled rejection. The report already arrived either way.
      try {
        track('feedback_sent', { status: sent ? 'ok' : 'error' });
      } catch {
        /* a blocked or broken beacon is not the user's problem */
      }
    })();
  });
}
