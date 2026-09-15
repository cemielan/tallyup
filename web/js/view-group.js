import * as api from './api.js';
import { openExpenseForm } from './expense-form.js';
import {
  alertBox,
  avatar,
  confirmAction,
  emptyState,
  formatMoney,
  h,
  money,
  relativeDate,
  render,
  skeleton,
  toast,
  withPending,
} from './ui.js';

const TABS = /** @type {const} */ ([
  ['expenses', 'Expenses'],
  ['balances', 'Balances'],
  ['settle', 'Settle up'],
  ['members', 'Members'],
]);

/**
 * One group, with everything about it behind four tabs. Each tab loads its
 * own data on demand rather than fetching all four up front -- a Worker gets
 * a limited number of subrequests, and most visits only look at one tab.
 */
export async function groupView(root, groupId) {
  const me = api.currentUser();
  let group = null;
  let tab = /** @type {string} */ (
    TABS.some(([id]) => id === location.hash.split('/')[3]) ? location.hash.split('/')[3] : 'expenses'
  );

  const header = h('div');
  const panel = h('div');

  render(root, h('a', { class: 'backlink', href: '#/groups' }, '‹ All groups'), header, panel);
  render(panel, h('div', { class: 'card' }, skeleton(4)));

  try {
    group = await api.getGroup(groupId);
  } catch (error) {
    const message =
      error instanceof api.ApiError && error.status === 404
        ? 'That group does not exist, or you are not a member of it.'
        : 'Could not load this group.';
    render(panel, alertBox(message));
    return;
  }

  const isOwner = group.members.find((member) => member.id === me?.id)?.role === 'owner';
  const nameOf = (userId) =>
    group.members.find((member) => member.id === userId)?.displayName ?? 'Former member';

  function drawHeader() {
    render(
      header,
      h(
        'div',
        { class: 'page-head' },
        h(
          'div',
          { class: 'page-head__title' },
          h('h1', null, group.name),
          h(
            'div',
            { class: 'row', style: { gap: '0.6rem' } },
            h(
              'div',
              { class: 'avatar-stack' },
              group.members.slice(0, 5).map((member) => avatar(member.displayName, 'sm')),
            ),
            h(
              'span',
              { class: 'page-head__sub' },
              `${group.members.length} ${group.members.length === 1 ? 'member' : 'members'}`,
              isOwner ? ' · you own this group' : '',
            ),
          ),
        ),
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onClick: () =>
              openExpenseForm({
                groupId,
                members: group.members,
                currentUserId: me?.id ?? '',
                onSaved: () => show(tab),
              }),
          },
          'Add expense',
        ),
      ),
      h(
        'div',
        { class: 'tabs', role: 'tablist' },
        TABS.map(([id, label]) =>
          h(
            'button',
            {
              class: 'tab',
              type: 'button',
              role: 'tab',
              'aria-selected': String(tab === id),
              onClick: () => {
                tab = id;
                history.replaceState(null, '', `#/groups/${groupId}/${id}`);
                drawHeader();
                show(id);
              },
            },
            label,
          ),
        ),
      ),
    );
  }

  async function show(which) {
    render(panel, h('div', { class: 'card' }, skeleton(4)));
    try {
      if (which === 'expenses') await showExpenses();
      else if (which === 'balances') await showBalances();
      else if (which === 'settle') await showSettle();
      else await showMembers();
    } catch (error) {
      render(
        panel,
        alertBox(error instanceof api.ApiError ? error.message : 'Could not load that.'),
      );
    }
  }

  /* ---------- Expenses ---------- */

  async function showExpenses(page = 1) {
    const { data, pagination } = await api.listExpenses(groupId, page);

    if (data.length === 0) {
      render(
        panel,
        h(
          'div',
          { class: 'card' },
          emptyState({
            icon: '🧾',
            title: 'No expenses yet',
            body: 'Add the first one and balances will work themselves out.',
          }),
        ),
      );
      return;
    }

    render(
      panel,
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'list' },
          data.map((expense) => expenseRow(expense)),
        ),
      ),
      pagination.totalPages > 1 && pager(pagination, (next) => showExpenses(next)),
    );
  }

  function expenseRow(expense) {
    const canEdit = expense.createdBy === me?.id || isOwner;

    return h(
      'div',
      { class: 'list__item' },
      avatar(nameOf(expense.paidBy)),
      h(
        'div',
        { class: 'list__main' },
        h(
          'span',
          { class: 'list__title' },
          expense.description,
          expense.isSettlement && ' ',
          expense.isSettlement && h('span', { class: 'badge badge--positive' }, 'Settlement'),
        ),
        h(
          'span',
          { class: 'list__meta' },
          `${nameOf(expense.paidBy)} paid · ${expense.splitType} split · ${relativeDate(expense.createdAt)}`,
        ),
      ),
      h(
        'div',
        { class: 'list__aside' },
        money(expense.amount, expense.currency),
        canEdit &&
          !expense.isSettlement &&
          h(
            'button',
            {
              class: 'btn btn--ghost btn--sm',
              type: 'button',
              'aria-label': `Edit ${expense.description}`,
              onClick: async () => {
                const full = await api.getExpense(expense.id);
                openExpenseForm({
                  groupId,
                  members: group.members,
                  currentUserId: me?.id ?? '',
                  expense: full,
                  onSaved: () => show('expenses'),
                });
              },
            },
            'Edit',
          ),
        canEdit &&
          h(
            'button',
            {
              class: 'btn btn--ghost btn--sm',
              type: 'button',
              'aria-label': `Delete ${expense.description}`,
              onClick: async (event) => {
                const ok = await confirmAction({
                  title: 'Delete this expense?',
                  body: `“${expense.description}” will stop counting towards everyone’s balance. The record is kept for history, not removed.`,
                  confirmLabel: 'Delete expense',
                });
                if (!ok) return;
                await withPending(event.currentTarget, () => api.deleteExpense(expense.id));
                toast('Expense deleted', 'success');
                await show('expenses');
              },
            },
            'Delete',
          ),
      ),
    );
  }

  /* ---------- Balances ---------- */

  async function showBalances() {
    const { balances } = await api.getBalances(groupId);

    if (balances.length === 0) {
      render(
        panel,
        h(
          'div',
          { class: 'card' },
          emptyState({
            icon: '🎉',
            title: 'Everyone is settled up',
            body: 'No outstanding balances in this group.',
          }),
        ),
      );
      return;
    }

    // One card per currency: the API keeps them apart and so must the UI, or
    // it would imply that a USD credit cancels an IDR debt.
    const byCurrency = new Map();
    for (const entry of balances) {
      if (!byCurrency.has(entry.currency)) byCurrency.set(entry.currency, []);
      byCurrency.get(entry.currency).push(entry);
    }

    render(
      panel,
      h(
        'div',
        { class: 'stack' },
        [...byCurrency].map(([currency, entries]) => balanceCard(currency, entries)),
      ),
    );
  }

  function balanceCard(currency, entries) {
    // Creditors first, then debtors, each biggest first -- the people at the
    // top of the list are the ones with something to do about it.
    const sorted = [...entries].sort((a, b) => b.amount - a.amount);
    const mine = sorted.find((entry) => entry.userId === me?.id)?.amount ?? 0;

    return h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'card__head' },
        h('h2', null, currency),
        h(
          'span',
          { class: 'small muted' },
          mine > 0
            ? `You are owed ${formatMoney(mine, currency)}`
            : mine < 0
              ? `You owe ${formatMoney(-mine, currency)}`
              : 'You are settled up',
        ),
      ),
      h(
        'div',
        { class: 'list' },
        sorted.map((entry) =>
          h(
            'div',
            { class: 'list__item' },
            avatar(entry.displayName ?? nameOf(entry.userId)),
            h(
              'div',
              { class: 'list__main' },
              h(
                'span',
                { class: 'list__title' },
                entry.userId === me?.id ? 'You' : (entry.displayName ?? nameOf(entry.userId)),
              ),
              h(
                'span',
                { class: 'list__meta' },
                entry.amount > 0 ? 'is owed' : entry.amount < 0 ? 'owes' : 'settled up',
              ),
            ),
            h('div', { class: 'list__aside' }, money(entry.amount, currency, { signed: true })),
          ),
        ),
      ),
    );
  }

  /* ---------- Settle up ---------- */

  async function showSettle() {
    const [{ suggested }, settlements] = await Promise.all([
      api.getSuggested(groupId),
      api.listSettlements(groupId),
    ]);

    const pending = settlements.data.filter((item) => item.status === 'pending');
    const resolved = settlements.data.filter((item) => item.status !== 'pending');

    render(
      panel,
      h(
        'div',
        { class: 'stack' },
        pendingCard(pending),
        suggestedCard(suggested, pending),
        resolved.length > 0 && historyCard(resolved),
      ),
    );
  }

  function suggestedCard(suggested, pending) {
    return h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'card__head' },
        h('h2', null, 'Suggested payments'),
        h('span', { class: 'small muted' }, 'The fewest transfers that clear the group'),
      ),
      suggested.length === 0
        ? emptyState({ icon: '✓', title: 'Nothing to settle', body: 'Everyone is square.' })
        : h(
            'div',
            { class: 'list' },
            suggested.map((transfer) => {
              const alreadyProposed = pending.some(
                (item) =>
                  item.fromUserId === transfer.from &&
                  item.toUserId === transfer.to &&
                  item.currency === transfer.currency,
              );
              const isMine = transfer.from === me?.id;

              return h(
                'div',
                { class: 'list__item' },
                avatar(nameOf(transfer.from)),
                h(
                  'div',
                  { class: 'list__main' },
                  h(
                    'span',
                    { class: 'list__title' },
                    `${isMine ? 'You' : nameOf(transfer.from)} → ${transfer.to === me?.id ? 'you' : nameOf(transfer.to)}`,
                  ),
                  h(
                    'span',
                    { class: 'list__meta' },
                    alreadyProposed ? 'Already marked as paid, awaiting confirmation' : 'Suggested',
                  ),
                ),
                h(
                  'div',
                  { class: 'list__aside' },
                  money(transfer.amount, transfer.currency),
                  isMine &&
                    !alreadyProposed &&
                    h(
                      'button',
                      {
                        class: 'btn btn--secondary btn--sm',
                        type: 'button',
                        onClick: async (event) => {
                          await withPending(event.currentTarget, () =>
                            api.proposeSettlement(groupId, {
                              toUserId: transfer.to,
                              amount: transfer.amount,
                              currency: transfer.currency,
                            }),
                          );
                          toast(`${nameOf(transfer.to)} has to confirm they received it`, 'success');
                          await show('settle');
                        },
                      },
                      'I paid this',
                    ),
                ),
              );
            }),
          ),
    );
  }

  function pendingCard(pending) {
    if (pending.length === 0) return null;

    return h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'card__head' },
        h('h2', null, 'Awaiting confirmation'),
        h('span', { class: 'badge badge--warning' }, `${pending.length} pending`),
      ),
      h(
        'div',
        { class: 'list' },
        pending.map((item) => {
          // Only the person being paid can confirm they got the money, so a
          // payer cannot write off their own debt (FR-404).
          const iAmRecipient = item.toUserId === me?.id;

          return h(
            'div',
            { class: 'list__item' },
            avatar(nameOf(item.fromUserId)),
            h(
              'div',
              { class: 'list__main' },
              h(
                'span',
                { class: 'list__title' },
                `${item.fromUserId === me?.id ? 'You' : nameOf(item.fromUserId)} paid ${
                  iAmRecipient ? 'you' : nameOf(item.toUserId)
                }`,
              ),
              h(
                'span',
                { class: 'list__meta' },
                iAmRecipient
                  ? 'Confirm once the money has actually reached you.'
                  : `Waiting for ${nameOf(item.toUserId)} to confirm.`,
              ),
            ),
            h(
              'div',
              { class: 'list__aside' },
              money(item.amount, item.currency),
              iAmRecipient &&
                h(
                  'button',
                  {
                    class: 'btn btn--ghost btn--sm',
                    type: 'button',
                    onClick: async (event) => {
                      const ok = await confirmAction({
                        title: 'Decline this payment?',
                        body: `Balances stay exactly as they are, and ${nameOf(item.fromUserId)} will still owe this amount.`,
                        confirmLabel: 'Decline',
                      });
                      if (!ok) return;
                      await withPending(event.currentTarget, () => api.declineSettlement(item.id));
                      toast('Payment declined — balances unchanged');
                      await show('settle');
                    },
                  },
                  'Decline',
                ),
              iAmRecipient &&
                h(
                  'button',
                  {
                    class: 'btn btn--sm',
                    type: 'button',
                    onClick: async (event) => {
                      await withPending(event.currentTarget, () => api.confirmSettlement(item.id));
                      toast('Confirmed — balances updated', 'success');
                      await show('settle');
                    },
                  },
                  'Confirm received',
                ),
            ),
          );
        }),
      ),
    );
  }

  function historyCard(resolved) {
    return h(
      'div',
      { class: 'card' },
      h('div', { class: 'card__head' }, h('h2', null, 'Settlement history')),
      h(
        'div',
        { class: 'list' },
        resolved.map((item) =>
          h(
            'div',
            { class: 'list__item' },
            h(
              'div',
              { class: 'list__main' },
              h(
                'span',
                { class: 'list__title' },
                `${nameOf(item.fromUserId)} → ${nameOf(item.toUserId)}`,
              ),
              h('span', { class: 'list__meta' }, relativeDate(item.resolvedAt ?? item.createdAt)),
            ),
            h(
              'div',
              { class: 'list__aside' },
              money(item.amount, item.currency),
              h(
                'span',
                { class: `badge badge--${item.status === 'confirmed' ? 'positive' : 'negative'}` },
                item.status,
              ),
            ),
          ),
        ),
      ),
    );
  }

  /* ---------- Members ---------- */

  async function showMembers() {
    render(
      panel,
      h(
        'div',
        { class: 'stack' },
        isOwner && inviteCard(),
        h(
          'div',
          { class: 'card' },
          h('div', { class: 'card__head' }, h('h2', null, 'Members')),
          h(
            'div',
            { class: 'list' },
            group.members.map((member) => memberRow(member)),
          ),
        ),
      ),
    );
  }

  function inviteCard() {
    const codeEl = h('code', { class: 'invite__code' }, group.inviteCode ?? '—');

    return h(
      'div',
      { class: 'card' },
      h('div', { class: 'card__head' }, h('h2', null, 'Invite code')),
      h(
        'div',
        { class: 'card__body stack' },
        h(
          'p',
          { class: 'small muted' },
          'Anyone with this code can join the group. Rotate it if it leaks.',
        ),
        h(
          'div',
          { class: 'invite' },
          codeEl,
          h(
            'button',
            {
              class: 'btn btn--secondary btn--sm',
              type: 'button',
              onClick: async () => {
                try {
                  await navigator.clipboard.writeText(group.inviteCode);
                  toast('Invite code copied', 'success');
                } catch {
                  // Clipboard access needs a secure context and permission;
                  // the code is selectable either way.
                  toast('Select the code and copy it manually');
                }
              },
            },
            'Copy',
          ),
          h(
            'button',
            {
              class: 'btn btn--ghost btn--sm',
              type: 'button',
              onClick: async (event) => {
                const ok = await confirmAction({
                  title: 'Rotate the invite code?',
                  body: 'The current code stops working immediately. Anyone still holding it will not be able to join.',
                  confirmLabel: 'Rotate code',
                });
                if (!ok) return;
                const result = await withPending(event.currentTarget, () =>
                  api.rotateInvite(groupId),
                );
                group.inviteCode = result.inviteCode;
                codeEl.textContent = result.inviteCode;
                toast('New invite code generated', 'success');
              },
            },
            'Rotate',
          ),
        ),
      ),
    );
  }

  function memberRow(member) {
    const isMe = member.id === me?.id;
    const canRemove = isMe || isOwner;

    return h(
      'div',
      { class: 'list__item' },
      avatar(member.displayName),
      h(
        'div',
        { class: 'list__main' },
        h('span', { class: 'list__title' }, member.displayName, isMe ? ' (you)' : ''),
        h('span', { class: 'list__meta' }, `Joined ${relativeDate(member.joinedAt)}`),
      ),
      h(
        'div',
        { class: 'list__aside' },
        member.role === 'owner' && h('span', { class: 'badge badge--accent' }, 'Owner'),
        canRemove &&
          h(
            'button',
            {
              class: 'btn btn--danger btn--sm',
              type: 'button',
              onClick: async (event) => {
                const ok = await confirmAction({
                  title: isMe ? 'Leave this group?' : `Remove ${member.displayName}?`,
                  body: 'This only works if their balance is zero — nobody can walk away from a debt.',
                  confirmLabel: isMe ? 'Leave group' : 'Remove',
                });
                if (!ok) return;

                try {
                  await withPending(event.currentTarget, () =>
                    api.removeMember(groupId, member.id),
                  );
                } catch (error) {
                  if (error instanceof api.ApiError && error.code === 'NONZERO_BALANCE') {
                    toast(
                      `${isMe ? 'You have' : `${member.displayName} has`} an outstanding balance. Settle up first.`,
                      'error',
                    );
                    return;
                  }
                  throw error;
                }

                if (isMe) {
                  toast('You left the group', 'success');
                  location.hash = '#/groups';
                } else {
                  toast(`${member.displayName} removed`, 'success');
                  group = await api.getGroup(groupId);
                  drawHeader();
                  await show('members');
                }
              },
            },
            isMe ? 'Leave' : 'Remove',
          ),
      ),
    );
  }

  /* ---------- Pagination ---------- */

  function pager(pagination, onPage) {
    return h(
      'div',
      { class: 'row row--between', style: { marginBlockStart: '0.9rem' } },
      h(
        'span',
        { class: 'small muted' },
        `Page ${pagination.page} of ${pagination.totalPages} · ${pagination.total} total`,
      ),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'btn btn--secondary btn--sm',
            type: 'button',
            disabled: pagination.page <= 1,
            onClick: () => onPage(pagination.page - 1),
          },
          'Previous',
        ),
        h(
          'button',
          {
            class: 'btn btn--secondary btn--sm',
            type: 'button',
            disabled: pagination.page >= pagination.totalPages,
            onClick: () => onPage(pagination.page + 1),
          },
          'Next',
        ),
      ),
    );
  }

  drawHeader();
  await show(tab);
}
