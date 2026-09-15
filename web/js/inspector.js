import { apiEvents, callLog, clearCallLog } from './api.js';
import { h, render } from './ui.js';

/**
 * The API inspector.
 *
 * This client exists so a developer can watch the API work, so every request
 * it makes is listed here with its method, path, status, duration and both
 * payloads. It is the difference between "the button worked" and "the button
 * sent this and got that back".
 *
 * Tokens and passwords are redacted in `api.js` before anything arrives
 * here, so the panel is safe to leave open while demonstrating to a room.
 */

const statusClass = (status) =>
  status === 0 || status >= 400 ? 'call__status--err' : 'call__status--ok';

function formatJson(value) {
  if (value === null || value === undefined) return '—';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function callRow(call, index) {
  const detail = h(
    'div',
    { class: 'call__detail' },
    call.request !== undefined &&
      call.request !== null &&
      h(
        'div',
        null,
        h('p', { class: 'call__label' }, 'Request body'),
        h('pre', { class: 'call__json' }, formatJson(call.request)),
      ),
    h(
      'div',
      null,
      h('p', { class: 'call__label' }, call.status === 0 ? 'Network error' : 'Response body'),
      h('pre', { class: 'call__json' }, formatJson(call.response)),
    ),
  );

  return h(
    'details',
    { class: 'call', open: index === 0 },
    h(
      'summary',
      { class: 'call__summary' },
      h('span', { class: 'call__method' }, call.method),
      h('span', { class: 'call__path' }, call.path),
      h(
        'span',
        { class: `call__status ${statusClass(call.status)}` },
        call.status === 0 ? 'ERR' : String(call.status),
      ),
      h('span', { class: 'call__time' }, `${call.ms} ms`),
    ),
    detail,
  );
}

/** Opens the inspector. Re-renders itself as new calls arrive. */
export function openInspector() {
  const body = h('div', { class: 'inspector__body' });

  const draw = () => {
    render(
      body,
      callLog.length === 0
        ? h(
            'p',
            { class: 'inspector__empty' },
            'No requests yet. Do something in the app and every call will appear here.',
          )
        : callLog.map((call, index) => callRow(call, index)),
    );
  };

  const dialog = h(
    'dialog',
    { class: 'inspector', 'aria-labelledby': 'inspector-title' },
    h(
      'div',
      { class: 'modal__head' },
      h(
        'div',
        null,
        h('h2', { id: 'inspector-title' }, 'API activity'),
        h(
          'p',
          { class: 'small muted' },
          'Every request this page sends to the Tallyup API. Tokens are redacted.',
        ),
      ),
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
    body,
    h(
      'div',
      { class: 'modal__foot' },
      h(
        'a',
        { class: 'btn btn--secondary btn--sm', href: '/docs', target: '_blank', rel: 'noreferrer' },
        'Open API reference',
      ),
      h(
        'button',
        {
          class: 'btn btn--ghost btn--sm',
          type: 'button',
          onClick: () => {
            clearCallLog();
          },
        },
        'Clear',
      ),
    ),
  );

  const onCall = () => draw();
  apiEvents.addEventListener('call', onCall);
  dialog.addEventListener('close', () => {
    apiEvents.removeEventListener('call', onCall);
    dialog.remove();
  });

  document.body.append(dialog);
  draw();
  dialog.showModal();
  return dialog;
}

/** The floating button that opens the inspector, with a live call count. */
export function inspectorToggle() {
  const count = h('span', null, '');

  const button = h(
    'button',
    {
      class: 'inspector-toggle',
      type: 'button',
      onClick: () => openInspector(),
    },
    h('span', { class: 'inspector-toggle__dot', 'aria-hidden': 'true' }),
    'API',
    count,
  );

  const update = () => {
    count.textContent = callLog.length > 0 ? ` · ${callLog.length}` : '';
    button.setAttribute(
      'aria-label',
      `Open API activity. ${callLog.length} request${callLog.length === 1 ? '' : 's'} logged.`,
    );
  };

  apiEvents.addEventListener('call', update);
  update();
  return button;
}
