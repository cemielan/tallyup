import * as api from './api.js';
import {
  alertBox,
  avatar,
  emptyState,
  formatMoney,
  h,
  money,
  relativeDate,
  render,
  skeleton,
} from './ui.js';
import { createGroupDialog, joinGroupDialog } from './view-groups.js';

/**
 * The overview screen: what you owe, what you are owed, and which groups are
 * still open.
 *
 * There is no aggregate endpoint for this, so it is assembled client-side
 * from one `/groups` call plus a `/balances` call per group. That is
 * deliberate for a reference client -- it shows exactly how a real consumer
 * would compose the primitives -- but it is also why only the first few
 * groups are summarised rather than all of them.
 */
const SUMMARISED_GROUPS = 6;

export async function dashboardView(root) {
  const me = api.currentUser();
  const tiles = h('div', { class: 'tiles' }, skeletonTiles());
  const groupsSlot = h('div');

  render(
    root,
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        { class: 'page-head__title' },
        h('h1', null, `Hi, ${me?.displayName?.split(' ')[0] ?? 'there'}`),
        h('span', { class: 'page-head__sub' }, 'Here is where everything stands.'),
      ),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'btn btn--secondary',
            type: 'button',
            onClick: () => joinGroupDialog(() => dashboardView(root)),
          },
          'Join with code',
        ),
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onClick: () => createGroupDialog(() => dashboardView(root)),
          },
          'New group',
        ),
      ),
    ),
    tiles,
    groupsSlot,
  );

  render(groupsSlot, h('div', { class: 'card' }, h('div', { class: 'card__body' }, skeleton(3))));

  let groups;
  try {
    groups = (await api.listGroups()).data;
  } catch (error) {
    render(tiles);
    render(
      groupsSlot,
      alertBox(
        error instanceof api.ApiError ? error.message : 'Could not reach the API. Is it running?',
      ),
    );
    return;
  }

  if (groups.length === 0) {
    render(tiles);
    render(
      groupsSlot,
      h(
        'div',
        { class: 'card' },
        emptyState({
          icon: '🧾',
          title: 'No groups yet',
          body: 'Create one for a trip, a flatshare or a dinner, then invite the others with the code.',
          action: h(
            'button',
            {
              class: 'btn',
              type: 'button',
              style: { marginBlockStart: '0.75rem' },
              onClick: () => createGroupDialog(() => dashboardView(root)),
            },
            'Create your first group',
          ),
        }),
      ),
    );
    return;
  }

  // Balances per group, fetched together rather than one after another.
  const summarised = groups.slice(0, SUMMARISED_GROUPS);
  const settled = await Promise.all(
    summarised.map(async (group) => {
      try {
        const { balances } = await api.getBalances(group.id);
        return { group, balances };
      } catch {
        return { group, balances: [] };
      }
    }),
  );

  /** @type {Map<string, {owed: number, owing: number}>} */
  const perCurrency = new Map();
  for (const { balances } of settled) {
    for (const entry of balances) {
      if (entry.userId !== me?.id) continue;
      const bucket = perCurrency.get(entry.currency) ?? { owed: 0, owing: 0 };
      if (entry.amount > 0) bucket.owed += entry.amount;
      else bucket.owing += -entry.amount;
      perCurrency.set(entry.currency, bucket);
    }
  }

  render(tiles, summaryTiles(perCurrency, groups.length));
  render(groupsSlot, groupsCard(settled, groups.length, me?.id));
}

function skeletonTiles() {
  return Array.from({ length: 3 }, () =>
    h('div', { class: 'skeleton', style: { height: '112px', borderRadius: '22px' } }),
  );
}

function summaryTiles(perCurrency, groupCount) {
  if (perCurrency.size === 0) {
    return [
      h(
        'div',
        { class: 'tile tile--mint' },
        h('div', { class: 'tile__icon', 'aria-hidden': 'true' }, '✓'),
        h('span', { class: 'tile__label' }, 'All settled'),
        h('span', { class: 'tile__value' }, 'Nothing owed'),
        h('span', { class: 'tile__meta' }, 'Across every group you are in'),
      ),
      groupsTile(groupCount),
    ];
  }

  const tiles = [];
  for (const [currency, { owed, owing }] of perCurrency) {
    if (owed > 0) {
      tiles.push(
        h(
          'div',
          { class: 'tile tile--mint' },
          h('div', { class: 'tile__icon', 'aria-hidden': 'true' }, '↙'),
          h('span', { class: 'tile__label' }, `You are owed · ${currency}`),
          h('span', { class: 'tile__value' }, formatMoney(owed, currency)),
          h('span', { class: 'tile__meta' }, 'Waiting to come back to you'),
        ),
      );
    }
    if (owing > 0) {
      tiles.push(
        h(
          'div',
          { class: 'tile tile--peach' },
          h('div', { class: 'tile__icon', 'aria-hidden': 'true' }, '↗'),
          h('span', { class: 'tile__label' }, `You owe · ${currency}`),
          h('span', { class: 'tile__value' }, formatMoney(owing, currency)),
          h('span', { class: 'tile__meta' }, 'Settle up from a group'),
        ),
      );
    }
  }

  tiles.push(groupsTile(groupCount));
  return tiles;
}

function groupsTile(groupCount) {
  return h(
    'div',
    { class: 'tile tile--lilac' },
    h('div', { class: 'tile__icon', 'aria-hidden': 'true' }, '👥'),
    h('span', { class: 'tile__label' }, 'Groups'),
    h('span', { class: 'tile__value' }, String(groupCount)),
    h('span', { class: 'tile__meta' }, groupCount === 1 ? 'One shared ledger' : 'Shared ledgers'),
  );
}

function groupsCard(settled, total, myId) {
  return h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'card__head' },
      h('h2', null, 'Your groups'),
      total > settled.length && h('a', { class: 'small', href: '#/groups' }, `View all ${total}`),
    ),
    h(
      'div',
      { class: 'list' },
      settled.map(({ group, balances }) => {
        const mine = balances.filter((entry) => entry.userId === myId);
        const others = [...new Set(balances.map((entry) => entry.displayName).filter(Boolean))];

        return h(
          'a',
          { class: 'linkcard', href: `#/groups/${group.id}` },
          h(
            'div',
            { class: 'list__main' },
            h('span', { class: 'list__title' }, group.name),
            h(
              'span',
              { class: 'list__meta' },
              group.role === 'owner' ? 'You own this · ' : '',
              `joined ${relativeDate(group.joinedAt)}`,
            ),
          ),
          others.length > 0 &&
            h(
              'div',
              { class: 'avatar-stack' },
              others.slice(0, 3).map((name) => avatar(name, 'sm')),
            ),
          mine.length === 0
            ? h('span', { class: 'badge badge--positive' }, 'settled')
            : h(
                'div',
                { class: 'list__aside' },
                mine.map((entry) => money(entry.amount, entry.currency, { signed: true })),
              ),
          h('span', { class: 'linkcard__chevron', 'aria-hidden': 'true' }, '›'),
        );
      }),
    ),
  );
}
