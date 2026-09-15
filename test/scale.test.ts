import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';
import {
  balancesByCurrency,
  expenseSplitsOf,
  ledgerRows,
  netBalances,
  recordExpense,
  replaceSplits,
  suggestedTransfers,
} from '../src/ledger';
import * as schema from '../src/schema';
import { api, json, registerAndLogin } from './helpers';

/**
 * The scale test NFR-201/NFR-202 require: the balance and settlement path
 * must stay inside the per-request CPU budget for a group at the documented
 * 50-member cap.
 *
 * Fixtures are written straight to D1 rather than driven through the HTTP
 * API. Registering 50 users would spend the whole test budget on password
 * hashing and tell us nothing -- what is under test here is the read path,
 * not signup.
 */

const CPU_BUDGET_MS = 10;
const MAX_MEMBERS = 50;
const EXPENSES = 200;

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * D1 allows 100 bound parameters per statement, so the rows per insert
 * depend on how wide the table is. Passing the column count keeps each
 * statement inside the limit instead of guessing a batch size.
 */
const D1_MAX_BOUND_PARAMS = 100;

async function insertChunked<T>(
  rows: T[],
  columns: number,
  insert: (chunk: T[]) => Promise<unknown>,
): Promise<void> {
  const size = Math.max(1, Math.floor(D1_MAX_BOUND_PARAMS / columns));
  for (let i = 0; i < rows.length; i += size) {
    await insert(rows.slice(i, i + size));
  }
}

async function seedGroup(db: Db, memberCount: number, expenseCount: number) {
  const now = Date.now();
  const users = Array.from({ length: memberCount }, (_, i) => ({
    id: crypto.randomUUID(),
    email: `scale-${now}-${i}@example.test`,
    passwordHash: 'pbkdf2-sha256$1000$AAAA$AAAA',
    displayName: `Member ${i}`,
    // Set explicitly rather than leaning on the column default, which
    // Drizzle would inline as a SQL expression once per row.
    createdAt: now,
  }));

  const groupId = crypto.randomUUID();

  await insertChunked(users, 5, (chunk) => db.insert(schema.users).values(chunk));
  await db.insert(schema.groups).values({
    id: groupId,
    name: 'Scale Test',
    inviteCode: `SCALE-${now}`,
    createdBy: users[0].id,
    createdAt: now,
  });
  await insertChunked(
    users.map((user, index) => ({
      groupId,
      userId: user.id,
      role: index === 0 ? ('owner' as const) : ('member' as const),
      joinedAt: now,
    })),
    4,
    (chunk) => db.insert(schema.groupMembers).values(chunk),
  );

  // Every expense splits across every member, which is the worst realistic
  // shape: the join behind a balance read returns members × expenses rows.
  const expenses = [];
  const splits = [];
  for (let i = 0; i < expenseCount; i += 1) {
    const expenseId = crypto.randomUUID();
    const amount = 1000 + i;
    expenses.push({
      id: expenseId,
      groupId,
      paidBy: users[i % memberCount].id,
      createdBy: users[i % memberCount].id,
      amount,
      currency: 'USD',
      description: `Expense ${i}`,
      splitType: 'exact' as const,
      createdAt: now + i,
      updatedAt: now + i,
    });

    const base = Math.floor(amount / memberCount);
    const remainder = amount - base * memberCount;
    for (const [index, user] of users.entries()) {
      splits.push({
        id: crypto.randomUUID(),
        expenseId,
        userId: user.id,
        amount: base + (index < remainder ? 1 : 0),
      });
    }
  }

  await insertChunked(expenses, 11, (chunk) => db.insert(schema.expenses).values(chunk));
  await insertChunked(splits, 4, (chunk) => db.insert(schema.expenseSplits).values(chunk));

  return { groupId, users };
}

describe(`a group at the ${MAX_MEMBERS}-member cap`, () => {
  it(
    'computes balances and a settlement plan inside the CPU budget',
    { timeout: 180_000 },
    async () => {
      const db = drizzle(env.DB, { schema });
      const { groupId } = await seedGroup(db, MAX_MEMBERS, EXPENSES);

      // Only CPU counts against the limit -- time spent waiting on D1 does
      // not -- so the read and the netting are measured apart.
      const startedRead = performance.now();
      const rows = await ledgerRows(db, groupId);
      const readMs = performance.now() - startedRead;

      const startedNet = performance.now();
      const sheets = netBalances(rows);
      const netMs = performance.now() - startedNet;

      const startedSimplify = performance.now();
      const transfers = suggestedTransfers(sheets);
      const simplifyMs = performance.now() - startedSimplify;

      const cpuMs = netMs + simplifyMs;

      console.log(
        `\n${MAX_MEMBERS} members x ${EXPENSES} expenses (${rows.length} split rows):\n` +
          `  D1 read (not CPU-billed) : ${readMs.toFixed(2)} ms\n` +
          `  netBalances              : ${netMs.toFixed(2)} ms\n` +
          `  simplifyDebts            : ${simplifyMs.toFixed(2)} ms\n` +
          `  CPU total                : ${cpuMs.toFixed(2)} ms of ${CPU_BUDGET_MS} ms\n` +
          `  transfers produced       : ${transfers.length}\n`,
      );

      // At most n-1 transfers settle n people; anything more means the
      // simplification stopped simplifying.
      expect(transfers.length).toBeLessThanOrEqual(MAX_MEMBERS - 1);
      expect(
        cpuMs,
        `Netting ${rows.length} split rows and simplifying costs ${cpuMs.toFixed(2)}ms of CPU, over ` +
          `the ${CPU_BUDGET_MS}ms request budget. See the ponytail note on netBalances in src/ledger.ts.`,
      ).toBeLessThan(CPU_BUDGET_MS);

      // Sanity: the sheet must still balance to zero after all that.
      expect(Object.values(sheets.USD).reduce((sum, amount) => sum + amount, 0)).toBe(0);
    },
  );

  /**
   * Regression test for a real bug: `expense_splits` rows were written in a
   * single INSERT, which binds four parameters per row. Past 25 participants
   * that exceeds D1's 100-parameter statement limit, so an expense shared by
   * a large group failed with "too many SQL variables" -- while the API
   * happily accepts groups of 50 and splits naming all of them.
   */
  it(
    'records an expense split across every member of a full group',
    { timeout: 180_000 },
    async () => {
      const db = drizzle(env.DB, { schema });
      const { groupId, users } = await seedGroup(db, MAX_MEMBERS, 0);
      const everyone = users.map((user) => user.id);

      const expense = await recordExpense(db, {
        groupId,
        paidBy: everyone[0],
        createdBy: everyone[0],
        amount: 100_000,
        currency: 'USD',
        description: 'Villa for the whole group',
        split: { type: 'equal', participants: everyone },
      });

      expect(expense.splits).toHaveLength(MAX_MEMBERS);
      expect(expense.splits.reduce((sum, s) => sum + s.amount, 0)).toBe(100_000);

      // And the stored rows match, so the chunked write did not drop any.
      const stored = await expenseSplitsOf(db, expense.id);
      expect(stored).toHaveLength(MAX_MEMBERS);
      expect(stored.reduce((sum, s) => sum + s.amount, 0)).toBe(100_000);

      const sheets = await balancesByCurrency(db, groupId);
      const total = Object.values(sheets.USD).reduce((sum, amount) => sum + amount, 0);
      expect(total).toBe(0);

      // Editing it rewrites every split row through the same path.
      const replaced = await replaceSplits(
        db,
        expense.id,
        Object.fromEntries(everyone.map((id, index) => [id, index === 0 ? 100_000 : 0])),
      );
      expect(replaced).toHaveLength(MAX_MEMBERS);
      expect(await expenseSplitsOf(db, expense.id)).toHaveLength(MAX_MEMBERS);
    },
  );

  it('refuses to grow past the member cap', { timeout: 120_000 }, async () => {
    const db = drizzle(env.DB, { schema });
    const { groupId } = await seedGroup(db, MAX_MEMBERS, 0);

    const group = await db.query.groups.findFirst({
      where: (groups, { eq }) => eq(groups.id, groupId),
    });
    const newcomer = await registerAndLogin('One Too Many');

    // The cap is enforced at the API layer so a request fails with a clear
    // validation error rather than a request silently exceeding its budget.
    const response = await api('/v1/groups/join', {
      body: { inviteCode: group!.inviteCode },
      token: newcomer.accessToken,
    });
    const body = await json<{ error: { code: string } }>(response, 422);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});
