import * as api from './api.js';
import { alertBox, h, render, toast } from './ui.js';
import { authView } from './view-auth.js';
import { groupView } from './view-group.js';
import { groupsView } from './view-groups.js';

/**
 * Bootstrap and routing.
 *
 * Hash routing, not the History API, and deliberately: the Worker serves
 * this app as a static asset and routes everything it does not recognise to
 * the API. Real paths would need a server-side catch-all rewrite, which
 * would also swallow `/v1/...` typos into the app instead of returning a
 * clean 404. A `#/...` fragment never reaches the server at all.
 */

const main = /** @type {HTMLElement} */ (document.getElementById('main'));
const topbar = /** @type {HTMLElement} */ (document.getElementById('topbar'));
const footer = /** @type {HTMLElement} */ (document.getElementById('footer'));
const userLabel = /** @type {HTMLElement} */ (document.getElementById('topbar-user'));
const signOutButton = /** @type {HTMLButtonElement} */ (document.getElementById('sign-out'));

function chrome(signedIn) {
  topbar.hidden = !signedIn;
  footer.hidden = !signedIn;
  const user = api.currentUser();
  userLabel.textContent = user ? user.displayName : '';
}

async function route() {
  const user = api.currentUser();

  if (!user) {
    chrome(false);
    authView(main, {
      onSignedIn: () => {
        // Land on the group list unless a deep link brought them here.
        if (!location.hash.startsWith('#/groups')) location.hash = '#/groups';
        else route();
      },
    });
    return;
  }

  chrome(true);

  // #/groups | #/groups/:id | #/groups/:id/:tab
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);

  try {
    if (parts[0] === 'groups' && parts[1]) {
      await groupView(main, parts[1]);
    } else {
      await groupsView(main);
    }
  } catch (error) {
    if (error instanceof api.ApiError && error.status === 401) return; // signOut already fired
    render(
      main,
      alertBox(
        'Something went wrong loading that page. Check that the API is running, then reload.',
      ),
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

signOutButton.addEventListener('click', async () => {
  await api.logout();
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

// Warn early and clearly if the app is opened from the filesystem rather
// than served by the Worker, since every API call would then be cross-origin.
if (location.protocol === 'file:') {
  render(
    main,
    h(
      'div',
      { class: 'auth' },
      alertBox(
        'Open this app through the Worker (npm run dev, then http://localhost:8787) rather than from the filesystem — the API is served from the same origin.',
      ),
    ),
  );
}
