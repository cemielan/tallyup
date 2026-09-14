/**
 * A small DOM and formatting toolkit. Deliberately not a framework: this app
 * is forms and lists, and `h()` plus full re-renders of a section covers it
 * without a dependency, a build step, or a virtual DOM to reason about.
 */

/**
 * Build an element. Children may be nodes, strings, or nested arrays;
 * null/undefined/false are skipped so `cond && h(...)` works inline.
 *
 * Generic over the tag so `h('input', ...)` is typed as an
 * `HTMLInputElement` -- callers read `.value` or call `.requestSubmit()`
 * without a cast, and a typo in a property name is a type error.
 *
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Record<string, any> | null} [props]
 * @param {...any} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function h(tag, props = null, ...children) {
  const el = document.createElement(tag);

  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;

    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'html') el.innerHTML = value;
    // Properties the DOM exposes directly (value, checked, disabled, hidden,
    // textContent) must be set as properties; everything else -- ARIA, href,
    // type, custom attributes -- as attributes.
    else if (key in el && key !== 'list' && key !== 'form') {
      /** @type {any} */ (el)[key] = value;
    } else el.setAttribute(key, value === true ? '' : String(value));
  }

  append(el, children);
  return el;
}

function append(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Replace everything inside `parent` with `children`. */
export function render(parent, ...children) {
  parent.replaceChildren();
  append(parent, children);
  return parent;
}

export const $ = (selector, root = document) => root.querySelector(selector);

/* ---------- Money ---------- */

/**
 * How many minor units make one major unit for a currency. Derived from
 * `Intl`, so JPY (0 decimals) and USD (2) are both right without a hardcoded
 * table to maintain.
 *
 * @param {string} currency
 */
export function currencyDigits(currency) {
  try {
    return (
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    // An unknown currency code throws rather than falling back.
    return 2;
  }
}

/**
 * Parse what a person typed into integer minor units, by string surgery
 * rather than multiplication -- `Math.round(10.075 * 100)` is the kind of
 * float error that puts a cent in the wrong place and never gets noticed.
 *
 * @param {string} input
 * @param {string} currency
 * @returns {number} minor units, or NaN if unparseable
 */
export function toMinorUnits(input, currency) {
  const digits = currencyDigits(currency);
  const match = String(input).trim().replace(/[\s,](?=\d{3}\b)/g, '').match(/^(\d*)(?:[.](\d*))?$/);
  if (!match) return Number.NaN;

  const [, whole = '', fraction = ''] = match;
  if (!whole && !fraction) return Number.NaN;
  if (fraction.length > digits) return Number.NaN;

  const padded = (fraction + '0'.repeat(digits)).slice(0, digits);
  return Number(`${whole || '0'}${padded}`);
}

/** Integer minor units back to a decimal string suitable for an input. */
export function toMajorString(minor, currency) {
  const digits = currencyDigits(currency);
  if (digits === 0) return String(minor);
  const sign = minor < 0 ? '-' : '';
  const abs = String(Math.abs(minor)).padStart(digits + 1, '0');
  return `${sign}${abs.slice(0, -digits)}.${abs.slice(-digits)}`;
}

/**
 * @param {number} minor
 * @param {string} currency
 */
export function formatMoney(minor, currency) {
  const digits = currencyDigits(currency);
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(
      minor / 10 ** digits,
    );
  } catch {
    return `${toMajorString(minor, currency)} ${currency}`;
  }
}

/** A money element coloured by sign: green when owed, red when owing. */
export function money(minor, currency, { signed = false } = {}) {
  const tone = minor > 0 ? 'positive' : minor < 0 ? 'negative' : 'muted';
  const text = formatMoney(signed ? Math.abs(minor) : minor, currency);
  return h(
    'span',
    { class: `money money--${tone}` },
    signed && minor > 0 ? `+${text}` : signed && minor < 0 ? `−${text}` : text,
  );
}

/* ---------- Formatting ---------- */

export function formatDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

export function relativeDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const units = /** @type {const} */ ([
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ]);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return formatter.format(0, 'minute');
}

/** Up to two initials, for the member avatars. */
export function initials(name) {
  return (name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('');
}

/* ---------- Feedback ---------- */

/**
 * @param {string} message
 * @param {'info' | 'success' | 'error'} [tone]
 */
export function toast(message, tone = 'info') {
  const host = document.getElementById('toasts');
  if (!host) return;

  const node = h('div', { class: `toast toast--${tone}` }, message);
  host.append(node);

  const remove = () => node.remove();
  setTimeout(remove, tone === 'error' ? 6000 : 3500);
  node.addEventListener('click', remove);
}

/** A non-blocking inline error block for forms. */
export function alertBox(message, tone = 'error') {
  return h('div', { class: `alert alert--${tone}`, role: tone === 'error' ? 'alert' : null }, message);
}

/**
 * @param {{icon?: string, title: string, body?: string, action?: Node | null}} options
 */
export function emptyState({ icon = '·', title, body, action = null }) {
  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'empty__icon', 'aria-hidden': 'true' }, icon),
    h('p', { class: 'empty__title' }, title),
    body && h('p', { class: 'small' }, body),
    action,
  );
}

export function skeleton(rows = 3) {
  return h(
    'div',
    { class: 'card__body stack', 'aria-hidden': 'true' },
    Array.from({ length: rows }, (_, index) =>
      h('div', {
        class: 'skeleton',
        style: { height: '1.1rem', width: `${100 - index * 12}%` },
      }),
    ),
  );
}

/* ---------- Buttons ---------- */

/**
 * Run an async action with the button disabled and spinning, so a slow
 * request cannot be double-submitted.
 *
 * Takes whatever an event handler hands over, so call sites can pass
 * `event.currentTarget` directly; anything that is not a button simply runs
 * the action without the pending state.
 *
 * @template T
 * @param {EventTarget | HTMLButtonElement | null} target
 * @param {() => Promise<T>} action
 * @returns {Promise<T>}
 */
export async function withPending(target, action) {
  const button = target instanceof HTMLButtonElement ? target : null;
  if (!button) return action();

  const original = [...button.childNodes];
  button.disabled = true;
  render(button, h('span', { class: 'btn__spinner', 'aria-hidden': 'true' }), 'Working…');
  try {
    return await action();
  } finally {
    button.disabled = false;
    render(button, original);
  }
}

/* ---------- Modal ---------- */

/**
 * A modal built on the native `<dialog>` element, which brings focus
 * trapping, Escape-to-close, inertness of the page behind it, and the
 * backdrop for free.
 *
 * @param {{title: string, body: Node, actions?: Node[], onClose?: () => void}} options
 * @returns {HTMLDialogElement}
 */
export function openModal({ title, body, actions = [], onClose }) {
  const dialog = /** @type {HTMLDialogElement} */ (
    h(
      'dialog',
      { class: 'modal', 'aria-labelledby': 'modal-title' },
      h(
        'div',
        { class: 'modal__head' },
        h('h2', { id: 'modal-title' }, title),
        h(
          'button',
          {
            class: 'modal__close',
            type: 'button',
            'aria-label': 'Close',
            onClick: () => dialog.close(),
          },
          '×',
        ),
      ),
      h('div', { class: 'modal__body' }, body),
      actions.length > 0 && h('div', { class: 'modal__foot' }, actions),
    )
  );

  dialog.addEventListener('close', () => {
    onClose?.();
    dialog.remove();
  });

  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

/**
 * Confirmation for a destructive or irreversible action. Resolves true only
 * when the user actively confirms; dismissing resolves false.
 *
 * @param {{title: string, body: string, confirmLabel?: string, tone?: 'danger' | 'primary'}} options
 * @returns {Promise<boolean>}
 */
export function confirmAction({ title, body, confirmLabel = 'Confirm', tone = 'danger' }) {
  return new Promise((resolve) => {
    let answer = false;
    const dialog = openModal({
      title,
      body: h('p', null, body),
      actions: [
        h(
          'button',
          { class: 'btn btn--secondary', type: 'button', onClick: () => dialog.close() },
          'Cancel',
        ),
        h(
          'button',
          {
            class: tone === 'danger' ? 'btn btn--danger' : 'btn',
            type: 'button',
            onClick: () => {
              answer = true;
              dialog.close();
            },
          },
          confirmLabel,
        ),
      ],
      onClose: () => resolve(answer),
    });
  });
}

/* ---------- Forms ---------- */

/**
 * A labelled form control. Returns the wrapper, and hangs the input off it
 * as `.control` so callers can read its value without another query.
 *
 * @param {{label: string, hint?: string, input: HTMLElement}} options
 */
export function field({ label, hint, input }) {
  const id = input.id || `field-${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;

  const wrapper = h(
    'div',
    { class: 'field' },
    h('label', { class: 'field__label', for: id }, label),
    input,
    hint && h('span', { class: 'field__hint' }, hint),
  );

  /** @type {any} */ (wrapper).control = input;
  return wrapper;
}

/** Currencies offered in the expense form. ISO 4217, as the API requires. */
export const CURRENCIES = ['USD', 'IDR', 'EUR', 'GBP', 'SGD', 'AUD', 'JPY', 'MYR'];
