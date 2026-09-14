import { describe, expect, it } from 'vitest';
import {
  addExpense,
  api,
  balanceOf,
  createGroup,
  expectError,
  getBalances,
  joinGroup,
  json,
  registerAndLogin,
} from './helpers';

async function twoPersonGroup() {
  const alice = await registerAndLogin('Alice');
  const bob = await registerAndLogin('Bob');
  const group = await createGroup(alice, 'Flatshare');
  await joinGroup(bob, group.inviteCode);
  return { alice, bob, group, both: [alice.userId, bob.userId] };
}

describe('recording expenses', () => {
  it('resolves an equal split and lists it newest first', async () => {
    const { alice, bob, group, both } = await twoPersonGroup();

    const first = await addExpense(alice, group.id, {
      amount: 2500,
      currency: 'USD',
      description: 'Groceries',
      paidBy: alice.userId,
      split: { type: 'equal', participants: both },
    });
    const second = await addExpense(bob, group.id, {
      amount: 1000,
      currency: 'USD',
      description: 'Milk',
      paidBy: bob.userId,
      split: { type: 'equal', participants: both },
    });

    const list = await json<{ data: Array<{ id: string; description: string }> }>(
      await api(`/v1/groups/${group.id}/expenses`, { token: bob.accessToken }),
    );
    expect(list.data.map((e) => e.id)).toEqual([second.id, first.id]);

    const detail = await json<{ splits: Array<{ userId: string; amount: number }> }>(
      await api(`/v1/expenses/${first.id}`, { token: bob.accessToken }),
    );
    // 2500 across two people cannot divide evenly, so the leftover unit is
    // assigned rather than lost.
    expect(detail.splits.reduce((sum, s) => sum + s.amount, 0)).toBe(2500);
  });

  it('supports all four split types', async () => {
    const { alice, group, both } = await twoPersonGroup();
    const [aliceId, bobId] = both;

    const cases = [
      { type: 'equal' as const, participants: both },
      { type: 'exact' as const, amounts: { [aliceId]: 400, [bobId]: 600 } },
      { type: 'percentage' as const, percentages: { [aliceId]: 25, [bobId]: 75 } },
      { type: 'shares' as const, shares: { [aliceId]: 1, [bobId]: 3 } },
    ];

    for (const split of cases) {
      const expense = await addExpense(alice, group.id, {
        amount: 1000,
        currency: 'USD',
        description: `Split by ${split.type}`,
        paidBy: aliceId,
        split,
      });
      const detail = await json<{
        splitType: string;
        splits: Array<{ amount: number }>;
      }>(await api(`/v1/expenses/${expense.id}`, { token: alice.accessToken }));
      expect(detail.splitType).toBe(split.type);
      expect(detail.splits.reduce((sum, s) => sum + s.amount, 0)).toBe(1000);
    }
  });

  it('returns 422, not 500, for a split that does not add up', async () => {
    const { alice, group, both } = await twoPersonGroup();
    const [aliceId, bobId] = both;

    await expectError(
      await api(`/v1/groups/${group.id}/expenses`, {
        body: {
          amount: 1000,
          currency: 'USD',
          description: 'Bad exact',
          paidBy: aliceId,
          split: { type: 'exact', amounts: { [aliceId]: 400, [bobId]: 500 } },
        },
        token: alice.accessToken,
      }),
      422,
      'VALIDATION_ERROR',
    );

    await expectError(
      await api(`/v1/groups/${group.id}/expenses`, {
        body: {
          amount: 1000,
          currency: 'USD',
          description: 'Bad percentage',
          paidBy: aliceId,
          split: { type: 'percentage', percentages: { [aliceId]: 30, [bobId]: 30 } },
        },
        token: alice.accessToken,
      }),
      422,
      'VALIDATION_ERROR',
    );
  });

  it('rejects a non-integer amount, a zero amount, and an absurd amount', async () => {
    const { alice, group, both } = await twoPersonGroup();
    const base = {
      currency: 'USD',
      description: 'Bad amount',
      paidBy: alice.userId,
      split: { type: 'equal', participants: both },
    };

    for (const amount of [10.5, 0, -100, 2_000_000_000]) {
      await expectError(
        await api(`/v1/groups/${group.id}/expenses`, {
          body: { ...base, amount },
          token: alice.accessToken,
        }),
        422,
        'VALIDATION_ERROR',
      );
    }
  });
});

describe('editing and deleting expenses', () => {
  it('recomputes balances after an edit', async () => {
    const { alice, bob, group, both } = await twoPersonGroup();
    const expense = await addExpense(alice, group.id, {
      amount: 4000,
      currency: 'USD',
      description: 'Dinner',
      paidBy: alice.userId,
      split: { type: 'equal', participants: both },
    });
    expect(balanceOf((await getBalances(alice, group.id)).balances, bob.userId)).toBe(-2000);

    await json(
      await api(`/v1/expenses/${expense.id}`, {
        method: 'PATCH',
        body: { amount: 1000 },
        token: alice.accessToken,
      }),
    );
    expect(balanceOf((await getBalances(alice, group.id)).balances, bob.userId)).toBe(-500);

    // Reassigning the split moves the whole cost onto one person.
    await json(
      await api(`/v1/expenses/${expense.id}`, {
        method: 'PATCH',
        body: { split: { type: 'exact', amounts: { [bob.userId]: 1000 } } },
        token: alice.accessToken,
      }),
    );
    expect(balanceOf((await getBalances(alice, group.id)).balances, bob.userId)).toBe(-1000);
  });

  it('excludes a deleted expense from balances but keeps it out of sight, not out of history', async () => {
    const { alice, group, both } = await twoPersonGroup();
    const expense = await addExpense(alice, group.id, {
      amount: 4000,
      currency: 'USD',
      description: 'Cancelled',
      paidBy: alice.userId,
      split: { type: 'equal', participants: both },
    });

    expect(
      (await api(`/v1/expenses/${expense.id}`, { method: 'DELETE', token: alice.accessToken }))
        .status,
    ).toBe(204);

    expect((await getBalances(alice, group.id)).balances).toEqual([]);
    const list = await json<{ data: unknown[] }>(
      await api(`/v1/groups/${group.id}/expenses`, { token: alice.accessToken }),
    );
    expect(list.data).toEqual([]);
    // The row is soft-deleted, so it is no longer addressable either.
    await expectError(
      await api(`/v1/expenses/${expense.id}`, { token: alice.accessToken }),
      404,
      'NOT_FOUND',
    );
  });

  it('lets the group owner edit a member expense, but not the other way round', async () => {
    const { alice, bob, group, both } = await twoPersonGroup();
    const byBob = await addExpense(bob, group.id, {
      amount: 1000,
      currency: 'USD',
      description: 'Bob paid',
      paidBy: bob.userId,
      split: { type: 'equal', participants: both },
    });
    const byAlice = await addExpense(alice, group.id, {
      amount: 1000,
      currency: 'USD',
      description: 'Alice paid',
      paidBy: alice.userId,
      split: { type: 'equal', participants: both },
    });

    // Owner may edit anything in their group.
    await json(
      await api(`/v1/expenses/${byBob.id}`, {
        method: 'PATCH',
        body: { description: 'Corrected by owner' },
        token: alice.accessToken,
      }),
    );

    // A plain member may not touch someone else's expense.
    await expectError(
      await api(`/v1/expenses/${byAlice.id}`, {
        method: 'PATCH',
        body: { description: 'Nope' },
        token: bob.accessToken,
      }),
      403,
      'FORBIDDEN',
    );
  });

  it('rejects an empty patch body', async () => {
    const { alice, group, both } = await twoPersonGroup();
    const expense = await addExpense(alice, group.id, {
      amount: 1000,
      currency: 'USD',
      description: 'Something',
      paidBy: alice.userId,
      split: { type: 'equal', participants: both },
    });

    await expectError(
      await api(`/v1/expenses/${expense.id}`, {
        method: 'PATCH',
        body: {},
        token: alice.accessToken,
      }),
      422,
      'VALIDATION_ERROR',
    );
  });
});

describe('settlements', () => {
  it('zeroes a balance only once the recipient confirms', async () => {
    const { alice, bob, group, both } = await twoPersonGroup();
    await addExpense(alice, group.id, {
      amount: 4000,
      currency: 'USD',
      description: 'Dinner',
      paidBy: alice.userId,
      split: { type: 'equal', participants: both },
    });

    const settlement = await json<{ id: string; status: string }>(
      await api(`/v1/groups/${group.id}/settlements`, {
        body: { toUserId: alice.userId, amount: 2000, currency: 'USD' },
        token: bob.accessToken,
      }),
      201,
    );
    expect(settlement.status).toBe('pending');

    // A pending settlement changes nothing.
    expect(balanceOf((await getBalances(alice, group.id)).balances, bob.userId)).toBe(-2000);

    // The payer cannot confirm their own payment (FR-404).
    await expectError(
      await api(`/v1/settlements/${settlement.id}/confirm`, {
        method: 'POST',
        token: bob.accessToken,
      }),
      404,
      'NOT_FOUND',
    );

    await json(
      await api(`/v1/settlements/${settlement.id}/confirm`, {
        method: 'POST',
        token: alice.accessToken,
      }),
    );
    expect((await getBalances(alice, group.id)).balances).toEqual([]);
  });

  it('leaves balances untouched when the recipient declines', async () => {
    const { alice, bob, group, both } = await twoPersonGroup();
    await addExpense(alice, group.id, {
      amount: 4000,
      currency: 'USD',
      description: 'Dinner',
      paidBy: alice.userId,
      split: { type: 'equal', participants: both },
    });

    const settlement = await json<{ id: string }>(
      await api(`/v1/groups/${group.id}/settlements`, {
        body: { toUserId: alice.userId, amount: 2000, currency: 'USD' },
        token: bob.accessToken,
      }),
      201,
    );

    await json(
      await api(`/v1/settlements/${settlement.id}/decline`, {
        method: 'POST',
        token: alice.accessToken,
      }),
    );
    expect(balanceOf((await getBalances(alice, group.id)).balances, bob.userId)).toBe(-2000);

    // A resolved settlement cannot be resolved twice.
    await expectError(
      await api(`/v1/settlements/${settlement.id}/confirm`, {
        method: 'POST',
        token: alice.accessToken,
      }),
      422,
      'VALIDATION_ERROR',
    );
  });

  it('refuses a settlement aimed at yourself or at a non-member', async () => {
    const { alice, bob, group } = await twoPersonGroup();
    const outsider = await registerAndLogin('Outsider');

    await expectError(
      await api(`/v1/groups/${group.id}/settlements`, {
        body: { toUserId: bob.userId, amount: 100, currency: 'USD' },
        token: bob.accessToken,
      }),
      422,
      'VALIDATION_ERROR',
    );
    await expectError(
      await api(`/v1/groups/${group.id}/settlements`, {
        body: { toUserId: outsider.userId, amount: 100, currency: 'USD' },
        token: alice.accessToken,
      }),
      422,
      'NON_MEMBER_PARTICIPANT',
    );
  });
});

describe('service surface', () => {
  it('serves a health check and a generated OpenAPI document', async () => {
    expect((await json<{ status: string }>(await api('/health'))).status).toBe('ok');

    const spec = await json<{ openapi: string; paths: Record<string, unknown> }>(
      await api('/v1/openapi.json'),
    );
    expect(spec.openapi).toMatch(/^3\./);
    // Every documented route is present, so the spec cannot silently drift
    // from the implementation (NFR-301).
    expect(Object.keys(spec.paths)).toContain('/groups/{groupId}/settlements/suggested');
  });

  it('answers an unknown endpoint with the standard error envelope', async () => {
    await expectError(await api('/v1/nope'), 404, 'NOT_FOUND');
  });
});
