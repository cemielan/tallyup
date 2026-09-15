import * as api from './api.js';
import { inspectorToggle, openInspector } from './inspector.js';
import { alertBox, avatar, h, render, toast } from './ui.js';
import { authView } from './view-auth.js';
import { dashboardView } from './view-dashboard.js';
import { groupView } from './view-group.js';
import { createGroupDialog, groupsView } from './view-groups.js';

/**
 * Bootstrap and routing.
 *
 * Hash routing, not the History API, and deliberately: the Worker serves
 * this app as static assets and routes everything it does not recognise to
 * the API. Real paths would need a server-side catch-all rewrite, and that
 * rewrite would also swallow a mistyped `/v1/...` into the app instead of
 * returning a clean 404 to an API client. A `#/...` fragment never reaches
 * the server at all.
 */

const shell = /** @type {HTMLElement} */ (document.getElementById('shell'));
const nav = /** @type {HTMLElement} */ (document.getElementById('nav'));
const main = /** @type {HTMLElement} */ (document.getElementById('main'));
const tabbarSlot = /** @type {HTMLElement} */ (document.getElementById('tabbar-slot'));

const NAV_ITEMS = /** @type {const} */ ([
  ['#/', '◈', 'Overview'],
  ['#/groups', '👥', 'Groups'],
]);

/** Which nav entry the current hash belongs to. */
function activeHref() {
  return location.hash.startsWith('#/groups') ? '#/groups' : '#/';
}

function drawChrome(signedIn) {
  shell.classList.toggle('shell--signed-in', signedIn);

  if (!signedIn) {
    render(nav);
    render(tabbarSlot);
    return;
  }

  const user = api.currentUser();
  const current = activeHref();

  render(
    nav,
    h(
      'a',
      { class: 'brand', href: '#/' },
      h('span', { class: 'brand__mark', 'aria-hidden': 'true' }, '₸'),
      'Tallyup',
    ),
    NAV_ITEMS.map(([href, icon, label]) =>
      h(
        'a',
        { class: 'nav__link', href, 'aria-current': href === current ? 'page' : null },
        h('span', { class: 'nav__icon', 'aria-hidden': 'true' }, icon),
        label,
      ),
    ),
    h(
      'a',
      { class: 'nav__link', href: '/docs', target: '_blank', rel: 'noreferrer' },
      h('span', { class: 'nav__icon', 'aria-hidden': 'true' }, '⌘'),
      'API reference',
    ),
    h(
      'div',
      { class: 'nav__foot' },
      h(
        'div',
        { class: 'nav__user' },
        avatar(user?.displayName ?? '?'),
        h(
          'div',
          { style: { minWidth: '0' } },
          h('div', { class: 'nav__username' }, user?.displayName ?? ''),
          h('div', { class: 'nav__email' }, user?.email ?? ''),
        ),
      ),
      h(
        'button',
        { class: 'btn btn--ghost btn--sm', type: 'button', onClick: signOut },
        'Sign out',
      ),
    ),
  );

  // The raised centre action mirrors the sidebar's primary action on phones.
  render(
    tabbarSlot,
    h(
      'nav',
      { class: 'tabbar', 'aria-label': 'Main' },
      h(
        'a',
        { class: 'tabbar__item', href: '#/', 'aria-current': current === '#/' ? 'page' : null },
        h('span', { 'aria-hidden': 'true' }, '◈'),
        h('span', null, 'Overview'),
      ),
      h(
        'a',
        {
          class: 'tabbar__item',
          href: '#/groups',
          'aria-current': current === '#/groups' ? 'page' : null,
        },
        h('span', { 'aria-hidden': 'true' }, '👥'),
        h('span', null, 'Groups'),
      ),
      h(
        'button',
        {
          class: 'tabbar__fab',
          type: 'button',
          'aria-label': 'New group',
          onClick: () => createGroupDialog(route),
        },
        '+',
      ),
      h(
        'button',
        { class: 'tabbar__item', type: 'button', onClick: () => openInspector() },
        h('span', { 'aria-hidden': 'true' }, '⚡'),
        h('span', null, 'API'),
      ),
      h(
        'button',
        { class: 'tabbar__item', type: 'button', onClick: signOut },
        h('span', { 'aria-hidden': 'true' }, '⏻'),
        h('span', null, 'Sign out'),
      ),
    ),
    inspectorToggle(),
  );
}

async function signOut() {
  await api.logout();
  location.hash = '';
  route();
}

async function route() {
  if (!api.currentUser()) {
    drawChrome(false);
    authView(main, {
      onSignedIn: () => {
        if (!location.hash.startsWith('#/')) location.hash = '#/';
        else route();
      },
    });
    return;
  }

  drawChrome(true);

  // #/ | #/groups | #/groups/:id | #/groups/:id/:tab
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);

  try {
    if (parts[0] === 'groups' && parts[1]) await groupView(main, parts[1]);
    else if (parts[0] === 'groups') await groupsView(main);
    else await dashboardView(main);
  } catch (error) {
    if (error instanceof api.ApiError && error.status === 401) return; // signOut already fired
    render(
      main,
      alertBox('Something went wrong loading that page. Check the API is running, then reload.'),
    );
    console.error(error);
  }

  main.focus({ preventScroll: true });
}

/** A refresh failure anywhere in the app lands here. */
api.authEvents.addEventListener('signout', () => {
  toast('Your session expired. Sign in again.', 'error');
  location.hash = '';
  route();
});

window.addEventListener('hashchange', route);

// A first paint that fails silently is the worst failure mode for a demo,
// so surface a module-level error rather than leaving a blank page.
route().catch((error) => {
  console.error(error);
  render(main, alertBox('The app failed to start. Check the browser console for details.'));
});

// Warn clearly if the app is opened from the filesystem rather than served
// by the Worker, since every API call would then be cross-origin.
if (location.protocol === 'file:') {
  render(
    main,
    alertBox(
      'Open this app through the Worker (npm run dev, then http://localhost:8787) rather than from the filesystem — the API is served from the same origin.',
    ),
  );
}
