/**
 * The client pass: proof that this browser passed a Cloudflare Turnstile
 * check, needed to create an event or send a payment claim
 * (docs/05-SECURITY.md §3). Most people never see the check. Turnstile only
 * shows a widget when it is unsure, which is what `interaction-only` means.
 *
 * One pass lasts a day and is kept in localStorage, so a phone is checked
 * at most once a day.
 */

declare global {
  interface Window {
    turnstile?: {
      render(container: HTMLElement, options: Record<string, unknown>): string;
      remove(widgetId: string): void;
    };
  }
}

// Cloudflare's documented always-pass test sitekey, for development. A
// production build must set VITE_TURNSTILE_SITE_KEY (docs/06-DEPLOYMENT.md).
const SITE_KEY: string = import.meta.env.VITE_TURNSTILE_SITE_KEY || '1x00000000000000000000AA';
const STORE = 'tallyup.pass';

let script: Promise<void> | undefined;

function loadScript(): Promise<void> {
  script ??= new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    tag.async = true;
    tag.onload = () => resolve();
    tag.onerror = () => {
      script = undefined;
      reject(new Error('Could not load the browser check. Check your connection.'));
    };
    document.head.append(tag);
  });
  return script;
}

/** Run the Turnstile check and return its single-use token. */
async function challenge(): Promise<string> {
  await loadScript();
  const turnstile = window.turnstile;
  if (!turnstile) throw new Error('Could not load the browser check.');

  const box = document.createElement('div');
  box.className = 'turnstile-box';
  document.body.append(box);

  try {
    return await new Promise<string>((resolve, reject) => {
      const id = turnstile.render(box, {
        sitekey: SITE_KEY,
        appearance: 'interaction-only',
        callback: (token: string) => resolve(token),
        'error-callback': () => reject(new Error('The browser check failed. Try again.')),
        'timeout-callback': () => reject(new Error('The browser check timed out. Try again.')),
      });
      box.dataset.widget = id;
    });
  } finally {
    if (box.dataset.widget) turnstile.remove(box.dataset.widget);
    box.remove();
  }
}

function stored(): string | undefined {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return undefined;
    const { pass, expiresAt } = JSON.parse(raw) as { pass: string; expiresAt: string };
    // A minute of slack, so a pass does not expire between here and the server.
    return Date.parse(expiresAt) > Date.now() + 60_000 ? pass : undefined;
  } catch {
    return undefined;
  }
}

/** A valid pass, from storage or from a fresh check. `fresh` forces a new one. */
export async function getPass(fresh = false): Promise<string> {
  const cached = fresh ? undefined : stored();
  if (cached) return cached;

  const token = await challenge();
  const response = await fetch('/v1/pass', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok || !body?.pass) throw new Error(body?.error?.message ?? 'The browser check failed. Try again.');

  try {
    localStorage.setItem(STORE, JSON.stringify(body));
  } catch {
    // Private mode: the pass still works for this page; it is just not remembered.
  }
  return body.pass;
}
