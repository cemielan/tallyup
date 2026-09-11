import { describe, expect, it } from 'vitest';
import {
  addExpense,
  api,
  balanceOf,
  createGroup,
  expectError,
  getBalances,
  getSuggested,
  joinGroup,
  json,
  registerAndLogin,
} from './helpers';

describe('groups', () => {
  it('makes the creator an owner and lets others join with the invite code', async () => {
    const alice = await registerAndLogin('Alice');
    const bob = await registerAndLogin('Bob');
    const group = await createGroup(alice, 'Bali Trip');

    expect(group.inviteCode).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    await joinGroup(bob, group.inviteCode);

    const detail = await json<{ members: Array<{ id: string; role: string }> }>(
      await api(`/v1/groups/${group.id}`, { token: alice.accessToken }),
    );
    expect(detail.members).toHaveLength(2);
    expect(detail.members.find((m) => m.id === alice.userId)?.role).toBe('owner');
    expect(detail.members.find((m) => m.id === bob.userId)?.role).toBe('member');
  });

  it('hides the invite code from non-owners', async () => {
    const alice = await registerAndLogin('Alice');
    const bob = await registerAndLogin('Bob');
    const group = await createGroup(alice, 'Private Code');
    await joinGroup(bob, group.inviteCode);

    const asOwner = await json<{ inviteCode?: string }>(
      await api(`/v1/groups/${group.id}`, { token: alice.accessToken }),
    );
    const asMember = await json<{ inviteCode?: string }>(
      await api(`/v1/groups/${group.id}`, { token: bob.accessToken }),
    );
    expect(asOwner.inviteCode).toBe(group.inviteCode);
    expect(asMember.inviteCode).toBeUndefined();
  });

  it('refuses a second join and an unknown invite code', async () => {
    const alice = await registerAndLogin('Alice');
    const bob = await registerAndLogin('Bob');
    const group = await createGroup(alice, 'Once Only');
    await joinGroup(bob, group.inviteCode);

    await expectError(
      await api('/v1/groups/join', {
        body: { inviteCode: group.inviteCode },
        token: bob.accessToken,
      }),
      409,
      'ALREADY_MEMBER',
    );
    await expectError(
      await api('/v1/groups/join', {
        body: { inviteCode: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' },
        token: bob.accessToken,
      }),
      404,
      'NOT_FOUND',
    );
  });

  it('invalidates the old invite code when an owner rotates it', async () => {
    const alice = await registerAndLogin('Alice');
    const bob = await registerAndLogin('Bob');
    const carol = await registerAndLogin('Carol');
    const group = await createGroup(alice, 'Rotating');
    await joinGroup(bob, group.inviteCode);

    const rotated = await json<{ inviteCode: string }>(
      await api(`/v1/groups/${group.id}/invite/rotate`, { method: 'POST', token: alice.accessToken }),
    );
    expect(rotated.inviteCode).not.toBe(group.inviteCode);

    await expectError(
      await api('/v1/groups/join', {
        body: { inviteCode: group.inviteCode },
        token: carol.accessToken,
      }),
      404,
      'NOT_FOUND',
    );
    await joinGroup(carol, rotated.inviteCode);
  });

  it('lets only an owner rotate the invite code', async () => {
    const alice = await registerAndLogin('Alice');
    const bob = await registerAndLogin('Bob');
    const group = await createGroup(alice, 'Owner Only');
    await joinGroup(bob, group.inviteCode);

    await expectError(
      await api(`/v1/groups/${group.id}/invite/rotate`, { method: 'POST', token: bob.accessToken }),
      403,
      'FORBIDDEN',
    );
  });

  it('lists only the groups the caller belongs to, paginated', async () => {
    const alice = await registerAndLogin('Alice');
    const stranger = await registerAndLogin('Stranger');
    await createGroup(alice, 'One');
    await createGroup(alice, 'Two');

    const mine = await json<{ data: unknown[]; pagination: { total: number; pageSize: number } }>(
      await api('/v1/groups?pageSize=1', { token: alice.accessToken }),
    );
    expect(mine.pagination.total).toBe(2);
    expect(mine.data).toHaveLength(1);

    const theirs = await json<{ pagination: { total: number } }>(
      await api('/v1/groups', { token: stranger.accessToken }),
    );
    expect(theirs.pagination.total).toBe(0);
  });

  it('caps pageSize at 100', async () => {
    const alice = await registerAndLogin('Alice');
    await expectError(
      await api('/v1/groups?pageSize=500', { token: alice.accessToken }),
      422,
      'VALIDATION_ERROR',
    );
  });
});

/**
 * NFR-102: no group-scoped route may be reachable by a non-member. Every
 * route is listed here on purpose -- a new route that forgets its membership
 * check should fail this test, not ship.
 */
describe('authorization', () => {
  it('answers 404 on every group-scoped route for a non-member', async () => {
    const alice = await registerAndLogin('Alice');
    const outsider = await registerAndLogin('Outsider');
    const group = await createGroup(alice, 'Members Only');
    const expense = await addExpense(alice, group.id, {
      amount: 1000,
      currency: 'USD',
      description: 'Coffee',
      paidBy: alice.userId,
      split: { type: 'equal', participants: [alice.userId] },
    });

    const routes: Array<[string, string, unknown?]> = [
      ['GET', `/v1/groups/${group.id}`],
      ['GET', `/v1/groups/${group.id}/expenses`],
      ['GET', `/v1/groups/${group.id}/balances`],
      ['GET', `/v1/groups/${group.id}/settlements`],
      ['GET', `/v1/groups/${group.id}/settlements/suggested`],
      ['POST', `/v1/groups/${group.id}/invite/rotate`],
      ['DELETE', `/v1/groups/${group.id}/members/${alice.userId}`],
      [
        'POST',
        `/v1/groups/${group.id}/expenses`,
        {
          amount: 500,
          currency: 'USD',
          description: 'Sneaky',
          paidBy: alice.userId,
          split: { type: 'equal', participants: [alice.userId] },
        },
      ],
      [
        'POST',
        `/v1/groups/${group.id}/settlements`,
        { toUserId: alice.userId, amount: 500, currency: 'USD' },
      ],
      ['GET', `/v1/expenses/${expense.id}`],
      ['PATCH', `/v1/expenses/${expense.id}`, { description: 'Hijacked' }],
      ['DELETE', `/v1/expenses/${expense.id}`],
    ];

    for (const [method, path, body] of routes) {
      const response = await api(path, { method, body, token: outsider.accessToken });
      expect(response.status, `${method} ${path} leaked to a non-member`).toBe(404);
    }
  });

  it('refuses an expense naming someone outside the group', async () => {
    const alice = await registerAndLogin('Alice');
    const outsider = await registerAndLogin('Outsider');
    const group = await createGroup(alice, 'Closed');

    await expectError(
      await api(`/v1/groups/${group.id}/expenses`, {
        body: {
          amount: 1000,
          currency: 'USD',
          description: 'Dinner',
          paidBy: alice.userId,
          split: { type: 'equal', participants: [alice.userId, outsider.userId] },
        },
        token: alice.accessToken,
      }),
      422,
      'NON_MEMBER_PARTICIPANT',
    );
  });
});

describe('leaving a group', () => {
  it('blocks departure while a balance is outstanding, and allows it once settled', async () => {
    const alice = await registerAndLogin('Alice');
    const bob = await registerAndLogin('Bob');
    const group = await createGroup(alice, 'Settle First');
    await joinGroup(bob, group.inviteCode);

    const expense = await addExpense(alice, group.id, {
      amount: 3000,
      currency: 'USD',
      description: 'Taxi',
      paidBy: alice.userId,
      split: { type: 'equal', participants: [alice.userId, bob.userId] },
    });

    await expectError(
      await api(`/v1/groups/${group.id}/members/${bob.userId}`, {
        method: 'DELETE',
        token: bob.accessToken,
      }),
      409,
      'NONZERO_BALANCE',
    );

    // Removing the expense clears the debt, because balances are derived.
    expect(
      (await api(`/v1/expenses/${expense.id}`, { method: 'DELETE', token: alice.accessToken }))
        .status,
    ).toBe(204);
    expect(balanceOf((await getBalances(alice, group.id)).balances, bob.userId)).toBe(0);

    expect(
      (
        await api(`/v1/groups/${group.id}/members/${bob.userId}`, {
          method: 'DELETE',
          token: bob.accessToken,
        })
      ).status,
    ).toBe(204);
  });

  it('lets a member remove only themself unless they own the group', async () => {
    const alice = await registerAndLogin('Alice');
    const bob = await registerAndLogin('Bob');
    const carol = await registerAndLogin('Carol');
    const group = await createGroup(alice, 'Owner Removes');
    await joinGroup(bob, group.inviteCode);
    await joinGroup(carol, group.inviteCode);

    await expectError(
      await api(`/v1/groups/${group.id}/members/${carol.userId}`, {
        method: 'DELETE',
        token: bob.accessToken,
      }),
      403,
      'FORBIDDEN',
    );
    expect(
      (
        await api(`/v1/groups/${group.id}/members/${carol.userId}`, {
          method: 'DELETE',
          token: alice.accessToken,
        })
      ).status,
    ).toBe(204);
  });

  it('hands ownership to the longest-standing member when the owner leaves', async () => {
    const alice = await registerAndLogin('Alice');
    const bob = await registerAndLogin('Bob');
    const group = await createGroup(alice, 'Succession');
    await joinGroup(bob, group.inviteCode);

    expect(
      (
        await api(`/v1/groups/${group.id}/members/${alice.userId}`, {
          method: 'DELETE',
          token: alice.accessToken,
        })
      ).status,
    ).toBe(204);

    const detail = await json<{ members: Array<{ id: string; role: string }> }>(
      await api(`/v1/groups/${group.id}`, { token: bob.accessToken }),
    );
    expect(detail.members).toEqual([expect.objectContaining({ id: bob.userId, role: 'owner' })]);
  });
});

describe('balances and settlement suggestions', () => {
  it('nets a multi-person, multi-expense scenario down to two transfers', async () => {
    const alice = await registerAndLogin('Alice');
    const bob = await registerAndLogin('Bob');
    const carol = await registerAndLogin('Carol');
    const group = await createGroup(alice, 'Road Trip');
    await joinGroup(bob, group.inviteCode);
    await joinGroup(carol, group.inviteCode);
    const everyone = [alice.userId, bob.userId, carol.userId];

    // Alice fronts 12000, Bob fronts 3000, split equally three ways.
    await addExpense(alice, group.id, {
      amount: 12_000,
      currency: 'USD',
      description: 'Hotel',
      paidBy: alice.userId,
      split: { type: 'equal', participants: everyone },
    });
    await addExpense(bob, group.id, {
      amount: 3000,
      currency: 'USD',
      description: 'Fuel',
      paidBy: bob.userId,
      split: { type: 'equal', participants: everyone },
    });

    // Total 15000, so each owes 5000: Alice is up 7000, Bob down 2000,
    // Carol down 5000.
    const { balances } = await getBalances(alice, group.id);
    expect(balanceOf(balances, alice.userId)).toBe(7000);
    expect(balanceOf(balances, bob.userId)).toBe(-2000);
    expect(balanceOf(balances, carol.userId)).toBe(-5000);
    expect(balances.reduce((sum, b) => sum + b.amount, 0)).toBe(0);

    const { suggested } = await getSuggested(alice, group.id);
    expect(suggested).toEqual([
      { from: carol.userId, to: alice.userId, amount: 5000, currency: 'USD' },
      { from: bob.userId, to: alice.userId, amount: 2000, currency: 'USD' },
    ]);
  });

  it('keeps currencies apart instead of netting them', async () => {
    const alice = await registerAndLogin('Alice');
    const bob = await registerAndLogin('Bob');
    const group = await createGroup(alice, 'Multi Currency');
    await joinGroup(bob, group.inviteCode);
    const both = [alice.userId, bob.userId];

    await addExpense(alice, group.id, {
      amount: 10_000,
      currency: 'USD',
      description: 'Flights',
      paidBy: alice.userId,
      split: { type: 'equal', participants: both },
    });
    await addExpense(bob, group.id, {
      amount: 400_000,
      currency: 'IDR',
      description: 'Warung',
      paidBy: bob.userId,
      split: { type: 'equal', participants: both },
    });

    const { balances } = await getBalances(alice, group.id);
    expect(balanceOf(balances, alice.userId, 'USD')).toBe(5000);
    expect(balanceOf(balances, alice.userId, 'IDR')).toBe(-200_000);

    // Two separate obligations, so two separate transfers -- a USD credit
    // does not cancel an IDR debt.
    const { suggested } = await getSuggested(alice, group.id);
    expect(suggested).toHaveLength(2);
    expect(new Set(suggested.map((t) => t.currency))).toEqual(new Set(['USD', 'IDR']));
  });
});
