import * as api from './api.js';
import { alertBox, field, h, render, withPending } from './ui.js';

/**
 * Sign-in and registration on one screen, with a segmented toggle rather
 * than two pages -- fewer clicks between landing here and seeing the API do
 * something, which is the whole point of this client.
 */

/**
 * The illustrated panel. Pure SVG rather than an image file: it costs no
 * extra request, scales cleanly, and can pick up the theme.
 */
function heroArt() {
  const svg = `
    <svg viewBox="0 0 480 620" preserveAspectRatio="xMidYMid slice" role="presentation" width="100%" height="100%">
      <defs>
        <linearGradient id="tu-note" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#ffffff" stop-opacity="0.95"/>
          <stop offset="100%" stop-color="#ded8ff" stop-opacity="0.9"/>
        </linearGradient>
        <linearGradient id="tu-flow" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#ff9ecd" stop-opacity="0.85"/>
          <stop offset="100%" stop-color="#8b7cf6" stop-opacity="0.2"/>
        </linearGradient>
      </defs>

      <circle cx="60" cy="90" r="150" fill="#ffffff" opacity="0.06"/>
      <circle cx="430" cy="520" r="190" fill="#ffffff" opacity="0.05"/>

      <path d="M-20 470 C 120 430, 150 300, 250 250 S 430 170, 520 120"
            stroke="url(#tu-flow)" stroke-width="46" fill="none" stroke-linecap="round"/>

      <g opacity="0.95">
        <rect x="150" y="150" width="92" height="62" rx="10" fill="url(#tu-note)" transform="rotate(-14 196 181)"/>
        <circle cx="182" cy="176" r="5" fill="#6c5ce7" opacity="0.5" transform="rotate(-14 196 181)"/>
        <rect x="168" y="190" width="56" height="5" rx="2.5" fill="#6c5ce7" opacity="0.35" transform="rotate(-14 196 181)"/>
      </g>
      <g opacity="0.9">
        <rect x="286" y="262" width="80" height="54" rx="9" fill="url(#tu-note)" transform="rotate(11 326 289)"/>
        <rect x="300" y="298" width="44" height="5" rx="2.5" fill="#6c5ce7" opacity="0.35" transform="rotate(11 326 289)"/>
      </g>
      <g opacity="0.85">
        <rect x="96" y="326" width="74" height="50" rx="9" fill="#a8e6a3" transform="rotate(-8 133 351)"/>
        <text x="133" y="358" font-family="system-ui" font-size="22" font-weight="700"
              fill="#2f7a45" text-anchor="middle" transform="rotate(-8 133 351)">$</text>
      </g>
      <g opacity="0.8">
        <rect x="330" y="430" width="66" height="44" rx="8" fill="#a8e6a3" transform="rotate(15 363 452)"/>
        <text x="363" y="460" font-family="system-ui" font-size="20" font-weight="700"
              fill="#2f7a45" text-anchor="middle" transform="rotate(15 363 452)">$</text>
      </g>

      <circle cx="392" cy="132" r="24" fill="#ffd9b5"/>
      <path d="M368 168 q24 -22 48 0 l6 54 q-30 12 -60 0 z" fill="#ff9ecd"/>
      <circle cx="108" cy="486" r="26" fill="#ffd9b5"/>
      <path d="M82 526 q26 -24 52 0 l7 58 q-33 13 -66 0 z" fill="#7d7bf0"/>
    </svg>`;

  return h('div', { class: 'auth-hero__art', 'aria-hidden': 'true', html: svg });
}

export function authView(root, { onSignedIn }) {
  let mode = /** @type {'login' | 'register'} */ ('login');

  function form() {
    const isRegister = mode === 'register';
    const errorSlot = h('div');

    const emailInput = h('input', {
      class: 'input',
      type: 'email',
      name: 'email',
      autocomplete: 'email',
      required: true,
      placeholder: 'you@example.com',
    });

    const passwordInput = h('input', {
      class: 'input',
      type: 'password',
      name: 'password',
      autocomplete: isRegister ? 'new-password' : 'current-password',
      required: true,
      placeholder: '••••••••••',
    });

    const nameInput = h('input', {
      class: 'input',
      type: 'text',
      name: 'displayName',
      autocomplete: 'name',
      required: true,
      maxLength: 80,
      placeholder: 'Alex Rivera',
    });

    const submit = h(
      'button',
      { class: 'btn btn--ink btn--block', type: 'submit' },
      isRegister ? 'Create account' : 'Sign in',
    );

    return h(
      'form',
      {
        class: 'stack',
        novalidate: true,
        onSubmit: async (event) => {
          event.preventDefault();
          render(errorSlot);

          const credentials = {
            email: emailInput.value.trim(),
            password: passwordInput.value,
            displayName: nameInput.value.trim(),
          };

          // Caught here as well as server-side (FR-102), so the rule is
          // visible before a round trip rather than after one.
          if (isRegister && credentials.password.length < 10) {
            render(errorSlot, alertBox('Password must be at least 10 characters.'));
            passwordInput.focus();
            return;
          }

          try {
            await withPending(submit, () =>
              isRegister ? api.register(credentials) : api.login(credentials),
            );
            onSignedIn();
          } catch (error) {
            render(
              errorSlot,
              alertBox(
                error instanceof api.ApiError
                  ? error.message
                  : 'Could not reach the API. Is the server running?',
              ),
            );
            passwordInput.focus();
            passwordInput.select();
          }
        },
      },
      isRegister && field({ label: 'Display name', input: nameInput }),
      field({ label: 'Email', input: emailInput }),
      field({
        label: 'Password',
        input: passwordInput,
        hint: isRegister ? 'At least 10 characters, and not a common password.' : undefined,
      }),
      errorSlot,
      submit,
    );
  }

  function draw() {
    const isRegister = mode === 'register';
    const formSlot = h('div', null, form());

    const swap = (next) => {
      mode = next;
      render(formSlot, form());
      /** @type {HTMLInputElement | null} */
      const first = formSlot.querySelector('input');
      first?.focus();
    };

    render(
      root,
      h(
        'div',
        { class: 'auth-layout' },

        h(
          'aside',
          { class: 'auth-hero' },
          heroArt(),
          h(
            'div',
            { class: 'auth-hero__body' },
            h('h2', null, 'Save your time and money'),
            h(
              'p',
              null,
              'Share costs with the people you travel, live and eat with — then settle up in as few payments as possible.',
            ),
            h(
              'ul',
              { class: 'auth-hero__points' },
              [
                'Equal, exact, percentage and share splits',
                'Balances kept separate per currency',
                'Every API call visible as you go',
              ].map((point) =>
                h(
                  'li',
                  null,
                  h('span', { class: 'auth-hero__tick', 'aria-hidden': 'true' }, '✓'),
                  point,
                ),
              ),
            ),
          ),
        ),

        h(
          'div',
          { class: 'auth-panel' },
          h(
            'div',
            { class: 'auth-card' },
            h(
              'div',
              { class: 'auth-card__brand' },
              h('div', { class: 'auth-card__mark', 'aria-hidden': 'true' }, '₸'),
              h('h1', null, 'Tallyup'),
              h(
                'p',
                { class: 'auth-card__tagline' },
                'The reference client for the Tallyup API.',
              ),
            ),

            h(
              'div',
              { class: 'card' },
              h(
                'div',
                { class: 'card__body stack' },
                h(
                  'div',
                  {
                    class: 'segmented',
                    role: 'group',
                    'aria-label': 'Sign in or create an account',
                  },
                  h('input', {
                    type: 'radio',
                    name: 'auth-mode',
                    id: 'auth-login',
                    checked: !isRegister,
                    onChange: () => swap('login'),
                  }),
                  h('label', { for: 'auth-login' }, 'Sign in'),
                  h('input', {
                    type: 'radio',
                    name: 'auth-mode',
                    id: 'auth-register',
                    checked: isRegister,
                    onChange: () => swap('register'),
                  }),
                  h('label', { for: 'auth-register' }, 'Create account'),
                ),
                formSlot,
              ),
            ),

            h(
              'p',
              {
                class: 'small muted',
                style: { marginBlockStart: '1.25rem', textAlign: 'center' },
              },
              'Prefer raw HTTP? ',
              h('a', { href: '/docs' }, 'Browse the API reference'),
              '.',
            ),
          ),
        ),
      ),
    );
  }

  draw();
}
