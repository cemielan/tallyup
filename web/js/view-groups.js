import * as api from './api.js';
import {
  alertBox,
  avatar,
  emptyState,
  field,
  h,
  openModal,
  relativeDate,
  render,
  skeleton,
  toast,
  withPending,
} from './ui.js';

/** The full group list, and the two ways in: create one, or join with a code. */
export async function groupsView(root) {
  const body = h('div');

  render(
    root,
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        { class: 'page-head__title' },
        h('h1', null, 'Groups'),
        h('span', { class: 'page-head__sub' }, 'Every shared ledger you belong to.'),
      ),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          { class: 'btn btn--secondary', type: 'button', onClick: () => joinGroupDialog(reload) },
          'Join with code',
        ),
        h(
          'button',
          { class: 'btn', type: 'button', onClick: () => createGroupDialog(reload) },
          'New group',
        ),
      ),
    ),
    h('div', { class: 'card' }, body),
  );

  async function reload() {
    render(body, h('div', { class: 'card__body' }, skeleton(3)));
    try {
      const { data } = await api.listGroups();
      render(body, data.length === 0 ? empty() : list(data));
    } catch (error) {
      render(body, h('div', { class: 'card__body' }, alertBox(describe(error))));
    }
  }

  function empty() {
    return emptyState({
      icon: '🧾',
      title: 'No groups yet',
      body: 'Create a group for a trip, a flatshare or a dinner — then invite the others.',
      action: h(
        'button',
        {
          class: 'btn',
          type: 'button',
          style: { marginBlockStart: '0.75rem' },
          onClick: () => createGroupDialog(reload),
        },
        'Create your first group',
      ),
    });
  }

  function list(groups) {
    return h(
      'div',
      { class: 'list' },
      groups.map((group) =>
        h(
          'a',
          { class: 'linkcard', href: `#/groups/${group.id}` },
          avatar(group.name),
          h(
            'div',
            { class: 'list__main' },
            h('span', { class: 'list__title' }, group.name),
            h(
              'span',
              { class: 'list__meta' },
              group.role === 'owner' ? 'You own this group' : 'Member',
              ' · joined ',
              relativeDate(group.joinedAt),
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

/** Shared by the dashboard and the group list, so both stay in step. */
export function createGroupDialog(onDone) {
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

  // The submit button lives in the dialog footer, outside the form, so it
  // is wired up explicitly rather than relying on implicit submission.
  submit.addEventListener('click', () => form.requestSubmit());
  nameInput.focus();
}

export function joinGroupDialog(onDone) {
  const codeInput = h('input', {
    class: 'input mono',
    type: 'text',
    required: true,
    placeholder: 'A1B2-C3D4-E5F6-G7H8',
    autocapitalize: 'characters',
    spellcheck: false,
    style: { letterSpacing: '0.06em' },
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
              : error instanceof api.ApiError && error.code === 'ALREADY_MEMBER'
                ? 'You are already in this group.'
                : describe(error);
          render(errorSlot, alertBox(message));
        }
      },
    },
    field({
      label: 'Invite code',
      input: codeInput,
      hint: 'Ask a member for the code. Case and spacing do not matter.',
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
