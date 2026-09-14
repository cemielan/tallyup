import * as api from './api.js';
import {
  alertBox,
  confirmAction,
  emptyState,
  field,
  formatDate,
  h,
  openModal,
  render,
  skeleton,
  toast,
  withPending,
} from './ui.js';

/** The group list: everything the signed-in user belongs to, plus the two
 *  ways in -- create one, or join someone else's with an invite code. */
export async function groupsView(root) {
  const body = h('div', { class: 'card__body--flush' }, skeleton(3));

  render(
    root,
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        { class: 'page-head__title' },
        h('h1', null, 'Your groups'),
        h('span', { class: 'page-head__sub' }, 'Shared expenses, one group at a time.'),
      ),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          { class: 'btn btn--secondary', type: 'button', onClick: () => joinDialog(reload) },
          'Join with code',
        ),
        h(
          'button',
          { class: 'btn', type: 'button', onClick: () => createDialog(reload) },
          'New group',
        ),
      ),
    ),
    h('div', { class: 'card' }, body),
  );

  async function reload() {
    render(body, skeleton(3));
    try {
      const { data } = await api.listGroups();
      render(body, data.length === 0 ? empty() : list(data));
    } catch (error) {
      render(body, h('div', { class: 'card__body' }, alertBox(describe(error))));
    }
  }

  function empty() {
    return h(
      'div',
      { class: 'card__body--flush' },
      emptyState({
        icon: '🧾',
        title: 'No groups yet',
        body: 'Create a group for a trip, a flatshare, or a dinner — then invite the others.',
        action: h(
          'button',
          {
            class: 'btn',
            type: 'button',
            style: { marginBlockStart: '0.5rem' },
            onClick: () => createDialog(reload),
          },
          'Create your first group',
        ),
      }),
    );
  }

  function list(groups) {
    return h(
      'div',
      { class: 'list' },
      groups.map((group) =>
        h(
          'a',
          { class: 'linkcard', href: `#/groups/${group.id}` },
          h(
            'div',
            { class: 'list__main' },
            h('span', { class: 'list__title' }, group.name),
            h(
              'span',
              { class: 'list__meta' },
              group.role === 'owner' ? 'You own this group' : 'Member',
              ' · joined ',
              formatDate(group.joinedAt),
            ),
          ),
          group.role === 'owner' && h('span', { class: 'badge badge--accent' }, 'Owner'),
          h('span', { class: 'linkcard__chevron', 'aria-hidden': 'true' }, '›'),
        ),
      ),
    );
  }

  await reload();
}

function describe(error) {
  return error instanceof api.ApiError ? error.message : 'Could not reach the API.';
}

function createDialog(onDone) {
  const nameInput = h('input', {
    class: 'input',
    type: 'text',
    maxLength: 120,
    required: true,
    placeholder: 'Bali Trip',
  });
  const errorSlot = h('div');

  const submit = h('button', { class: 'btn', type: 'submit' }, 'Create group');

  const form = h(
    'form',
    {
      class: 'stack',
      novalidate: true,
      onSubmit: async (event) => {
        event.preventDefault();
        render(errorSlot);
        const name = nameInput.value.trim();
        if (!name) {
          render(errorSlot, alertBox('Give the group a name.'));
          return;
        }
        try {
          const group = await withPending(submit, () => api.createGroup(name));
          dialog.close();
          toast(`Created “${group.name}”`, 'success');
          location.hash = `#/groups/${group.id}`;
          await onDone();
        } catch (error) {
          render(errorSlot, alertBox(describe(error)));
        }
      },
    },
    field({
      label: 'Group name',
      input: nameInput,
      hint: 'You become the owner and get an invite code to share.',
    }),
    errorSlot,
  );

  const dialog = openModal({
    title: 'New group',
    body: form,
    actions: [
      h(
        'button',
        { class: 'btn btn--secondary', type: 'button', onClick: () => dialog.close() },
        'Cancel',
      ),
      submit,
    ],
  });

  // The submit button lives in the footer, outside the form element, so wire
  // it up explicitly rather than relying on implicit submission.
  submit.addEventListener('click', () => form.requestSubmit());
  nameInput.focus();
}

function joinDialog(onDone) {
  const codeInput = h('input', {
    class: 'input',
    type: 'text',
    required: true,
    placeholder: 'A1B2-C3D4-E5F6-G7H8',
    autocapitalize: 'characters',
    spellcheck: false,
    style: { fontFamily: 'var(--font-mono)', letterSpacing: '0.05em' },
  });
  const errorSlot = h('div');
  const submit = h('button', { class: 'btn', type: 'submit' }, 'Join group');

  const form = h(
    'form',
    {
      class: 'stack',
      novalidate: true,
      onSubmit: async (event) => {
        event.preventDefault();
        render(errorSlot);
        try {
          const group = await withPending(submit, () => api.joinGroup(codeInput.value));
          dialog.close();
          toast(`Joined “${group.name}”`, 'success');
          location.hash = `#/groups/${group.id}`;
          await onDone();
        } catch (error) {
          const message =
            error instanceof api.ApiError && error.code === 'NOT_FOUND'
              ? 'That invite code is not valid. Check it and try again.'
              : describe(error);
          render(errorSlot, alertBox(message));
        }
      },
    },
    field({
      label: 'Invite code',
      input: codeInput,
      hint: 'Ask a member for the code. Case does not matter.',
    }),
    errorSlot,
  );

  const dialog = openModal({
    title: 'Join a group',
    body: form,
    actions: [
      h(
        'button',
        { class: 'btn btn--secondary', type: 'button', onClick: () => dialog.close() },
        'Cancel',
      ),
      submit,
    ],
  });

  submit.addEventListener('click', () => form.requestSubmit());
  codeInput.focus();
}

export { confirmAction };
