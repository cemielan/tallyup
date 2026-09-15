import { DebtSimplifyError, calculateBalances, resolveSplit, simplifyDebtsMulti } from 'debt-simplify';
import type { Balances, Split, Transfer } from 'debt-simplify';
import { and, eq, isNull } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { newId } from './crypto';
import { ApiError } from './errors';
import * as schema from './schema';

type Db = DrizzleD1Database<typeof schema>;

/**
 * D1 allows at most 100 bound parameters per statement, and each statement
 * inside a `batch` is counted on its own. An `expense_splits` row binds four
 * of them, so a single insert can carry 25 rows -- while a group may have up
 * to 50 members, every one of whom can share an expense.
 *
 * Splitting the insert is therefore not a micro-optimisation: without it, an
 * expense shared by more than 25 people fails outright with
 * "too many SQL variables".
 */
const SPLIT_ROWS_PER_STATEMENT = 25;

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

type BatchStatements = Parameters<Db['batch']>[0];

/** Insert statements for a set of split rows, chunked to fit D1's limit. */
function splitInserts(db: Db, splitRows: Array<typeof schema.expenseSplits.$inferInsert>) {
  return chunk(splitRows, SPLIT_ROWS_PER_STATEMENT).map((part) =>
    db.insert(schema.expenseSplits).values(part),
  );
}

/**
 * The single place that reads and writes the expense ledger. Balances are
 * always derived from these rows, never stored or mutated independently
 * (FR-308), so editing or deleting an expense changes the next balance read
 * with no extra bookkeeping to keep in sync.
 */

/** Every user id a split refers to, whatever the split's shape. */
function participantsOf(split: Split): string[] {
  switch (split.type) {
    case 'equal':
      return split.participants;
    case 'exact':
      return Object.keys(split.amounts);
    case 'percentage':
      return Object.keys(split.percentages);
    case 'shares':
      return Object.keys(split.shares);
  }
}

export async function groupMemberIds(db: Db, groupId: string): Promise<Set<string>> {
  const rows = await db
    .select({ userId: schema.groupMembers.userId })
    .from(schema.groupMembers)
    .where(eq(schema.groupMembers.groupId, groupId));
  return new Set(rows.map((row) => row.userId));
}

/**
 * Nobody outside the group may be named as a payer or a participant
 * (FR-303), and this is checked at write time, not at read time -- a stored
 * expense naming a non-member would corrupt every later balance calculation.
 */
export function assertMembers(memberIds: Set<string>, paidBy: string, split: Split): void {
  const named = [paidBy, ...participantsOf(split)];
  const outsider = named.find((id) => !memberIds.has(id));
  if (outsider) {
    throw new ApiError('NON_MEMBER_PARTICIPANT', 'Every participant must be a member of this group', {
      details: { userId: outsider },
    });
  }
}

/**
 * Resolve a split into integer amounts, translating the library's own
 * complaints into a clean 422 rather than letting them surface as a 500
 * (docs/05-SECURITY.md §5).
 */
export function resolveSplitOrThrow(amount: number, split: Split): Record<string, number> {
  try {
    return resolveSplit(amount, split);
  } catch (error) {
    if (error instanceof DebtSimplifyError) {
      throw new ApiError('VALIDATION_ERROR', error.message, { details: { field: 'split' } });
    }
    throw error;
  }
}

export interface ExpenseWrite {
  groupId: string;
  paidBy: string;
  createdBy: string;
  amount: number;
  currency: string;
  description: string;
  split: Split;
  isSettlement?: boolean;
}

/**
 * Write an expense and its resolved per-participant shares as one batch, so
 * a failure can never leave an expense with a partial or missing split --
 * which would silently change what everyone owes.
 */
export async function recordExpense(db: Db, input: ExpenseWrite) {
  const shares = resolveSplitOrThrow(input.amount, input.split);
  const expenseId = newId();
  const now = Date.now();

  const row = {
    id: expenseId,
    groupId: input.groupId,
    paidBy: input.paidBy,
    createdBy: input.createdBy,
    amount: input.amount,
    currency: input.currency,
    description: input.description,
    splitType: input.split.type,
    isSettlement: input.isSettlement ?? false,
    createdAt: now,
    updatedAt: now,
  };

  const splitRows = Object.entries(shares).map(([userId, amount]) => ({
    id: newId(),
    expenseId,
    userId,
    amount,
  }));

  await db.batch([
    db.insert(schema.expenses).values(row),
    ...splitInserts(db, splitRows),
  ] as unknown as BatchStatements);

  return { ...row, splits: splitRows.map(({ userId, amount }) => ({ userId, amount })) };
}

/** Replace an expense's splits in place, keeping its id and audit history. */
export async function replaceSplits(db: Db, expenseId: string, shares: Record<string, number>) {
  const splitRows = Object.entries(shares).map(([userId, amount]) => ({
    id: newId(),
    expenseId,
    userId,
    amount,
  }));

  await db.batch([
    db.delete(schema.expenseSplits).where(eq(schema.expenseSplits.expenseId, expenseId)),
    ...splitInserts(db, splitRows),
  ] as unknown as BatchStatements);

  return splitRows.map(({ userId, amount }) => ({ userId, amount }));
}

/** The wire shape of an expense. Timestamps go out as ISO strings. */
export function serializeExpense(row: {
  id: string;
  groupId: string;
  paidBy: string;
  createdBy: string;
  amount: number;
  currency: string;
  description: string;
  splitType: string;
  isSettlement: boolean;
  createdAt: number;
  updatedAt: number;
  splits?: Array<{ userId: string; amount: number }>;
}) {
  return {
    id: row.id,
    groupId: row.groupId,
    paidBy: row.paidBy,
    createdBy: row.createdBy,
    amount: row.amount,
    currency: row.currency,
    description: row.description,
    splitType: row.splitType,
    isSettlement: row.isSettlement,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    ...(row.splits ? { splits: row.splits } : {}),
  };
}

export async function expenseSplitsOf(db: Db, expenseId: string) {
  return db
    .select({ userId: schema.expenseSplits.userId, amount: schema.expenseSplits.amount })
    .from(schema.expenseSplits)
    .where(eq(schema.expenseSplits.expenseId, expenseId));
}

/**
 * Current balances for a group, one sheet per currency. Currencies never net
 * against each other (FR-405) -- a USD debt and an IDR debt are separate
 * obligations, so each settles on its own.
 */
export async function balancesByCurrency(db: Db, groupId: string): Promise<Record<string, Balances>> {
  return netBalances(await ledgerRows(db, groupId));
}

/**
 * The raw expense/split rows behind a balance calculation.
 *
 * Kept separate from the netting so the two costs can be measured apart:
 * waiting on D1 does not count against the CPU limit, but netting the rows
 * in memory does, and only one of those is worth optimising.
 */
export async function ledgerRows(db: Db, groupId: string) {
  // One join, not a query per expense: a Worker gets 50 subrequests per
  // request (docs/02-ARCHITECTURE.md §3), so an N+1 read pattern is a hard
  // ceiling here, not merely a slowdown.
  return db
    .select({
      expenseId: schema.expenses.id,
      currency: schema.expenses.currency,
      amount: schema.expenses.amount,
      paidBy: schema.expenses.paidBy,
      splitUserId: schema.expenseSplits.userId,
      splitAmount: schema.expenseSplits.amount,
    })
    .from(schema.expenses)
    .innerJoin(schema.expenseSplits, eq(schema.expenseSplits.expenseId, schema.expenses.id))
    .where(and(eq(schema.expenses.groupId, groupId), isNull(schema.expenses.deletedAt)));
}

/**
 * Net a set of ledger rows into one balance sheet per currency. Pure and
 * synchronous, so this is exactly the CPU the balances endpoint spends.
 *
 * ponytail: O(rows) with a Map per currency, which is fine to roughly ten
 * thousand split rows and then starts eating the request's CPU budget. If a
 * real group ever gets that large, the fix is a stored running balance
 * invalidated on expense write -- not a faster loop.
 */
export function netBalances(
  rows: Awaited<ReturnType<typeof ledgerRows>>,
): Record<string, Balances> {
  // Rebuild one expense per id, then hand the whole set to the library. The
  // stored shares are already resolved, so they go back in as an `exact`
  // split -- the library stays the only thing that knows how to net them
  // (FR-501).
  const perCurrency = new Map<
    string,
    Map<string, { paidBy: string; amount: number; amounts: Record<string, number> }>
  >();

  for (const row of rows) {
    let expensesForCurrency = perCurrency.get(row.currency);
    if (!expensesForCurrency) {
      expensesForCurrency = new Map();
      perCurrency.set(row.currency, expensesForCurrency);
    }
    let expense = expensesForCurrency.get(row.expenseId);
    if (!expense) {
      expense = { paidBy: row.paidBy, amount: row.amount, amounts: {} };
      expensesForCurrency.set(row.expenseId, expense);
    }
    expense.amounts[row.splitUserId] = row.splitAmount;
  }

  const out: Record<string, Balances> = {};
  for (const [currency, expensesForCurrency] of perCurrency) {
    out[currency] = calculateBalances(
      [...expensesForCurrency.values()].map((expense) => ({
        paidBy: expense.paidBy,
        amount: expense.amount,
        split: { type: 'exact' as const, amounts: expense.amounts },
      })),
    );
  }
  return out;
}

export function suggestedTransfers(
  balances: Record<string, Balances>,
): Array<Transfer & { currency: string }> {
  return Object.entries(simplifyDebtsMulti(balances)).flatMap(([currency, transfers]) =>
    transfers.map((transfer) => ({ ...transfer, currency })),
  );
}

/**
 * True when a user owes nothing and is owed nothing in every currency the
 * group uses. Gates leaving or being removed (FR-205/206) so that a
 * departure cannot quietly erase a debt.
 */
export function hasZeroBalance(balances: Record<string, Balances>, userId: string): boolean {
  return Object.values(balances).every((sheet) => (sheet[userId] ?? 0) === 0);
}
