import * as api from './api.js';
import { alertBox, field, h, render, withPending } from './ui.js';

/**
 * Sign-in and registration, on one screen with a segmented toggle. Two
 * separate pages would be more clicks for a demo whose whole point is to get
 * someone to a group quickly.
 */
export function authView(root, { onSignedIn }) {
  let mode = /** @type {'login' | 'register'} */ ('login');

  function draw() {
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
      minLength: isRegister ? 10 : 1,
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
      { class: 'btn btn--block', type: 'submit' },
      isRegister ? 'Create account' : 'Sign in',
    );

    const form = h(
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

          // Catch the password rule here rather than making someone wait for
          // a round trip to learn it (FR-102 enforces it server-side too).
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
            const message =
              error instanceof api.ApiError
                ? error.message
                : 'Could not reach the API. Is the server running?';
            render(errorSlot, alertBox(message));
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

    return h(
      'div',
      { class: 'auth' },
      h(
        'div',
        { class: 'auth__brand' },
        h('div', { class: 'auth__mark', 'aria-hidden': 'true' }, '₸'),
        h('h1', null, 'Tallyup'),
        h(
          'p',
          { class: 'auth__tagline' },
          'Split shared expenses, then settle up in the fewest payments possible.',
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
            { class: 'segmented', role: 'group', 'aria-label': 'Sign in or create an account' },
            h('input', {
              type: 'radio',
              name: 'auth-mode',
              id: 'auth-login',
              checked: !isRegister,
              onChange: () => {
                mode = 'login';
                draw2();
              },
            }),
            h('label', { for: 'auth-login' }, 'Sign in'),
            h('input', {
              type: 'radio',
              name: 'auth-mode',
              id: 'auth-register',
              checked: isRegister,
              onChange: () => {
                mode = 'register';
                draw2();
              },
            }),
            h('label', { for: 'auth-register' }, 'Create account'),
          ),
          form,
        ),
      ),

      h(
        'p',
        { class: 'small muted', style: { marginBlockStart: '1rem', textAlign: 'center' } },
        'This is the reference client for the Tallyup API. ',
        h('a', { href: '/docs' }, 'Browse the API'),
        '.',
      ),
    );
  }

  function draw2() {
    render(root, draw());
    /** @type {HTMLInputElement | null} */
    const first = root.querySelector('input:not([type="radio"])');
    first?.focus();
  }

  render(root, draw());
}
