import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { errors } from '../errors';
import {
  assertMembers,
  expenseSplitsOf,
  groupMemberIds,
  replaceSplits,
  resolveSplitOrThrow,
  serializeExpense,
} from '../ledger';
import * as schema from '../schema';
import type { AppEnv } from '../types';
import { parse, parseBody, updateExpenseSchema, uuidSchema } from '../validation';

type Expense = typeof schema.expenses.$inferSelect;

/** The base app environment plus the expense this request is about. */
type ExpenseEnv = {
  Bindings: AppEnv['Bindings'];
  Variables: AppEnv['Variables'] & { expense: Expense };
};

/**
 * These routes are addressed by expense id, not group id, so the membership
 * check cannot come from the URL -- it has to resolve the expense's group
 * first. One middleware does both lookups, so no handler below can reach an
 * expense in a group the caller does not belong to
 * (docs/05-SECURITY.md §3).
 *
 * A caller who is not a member gets the same 404 as one asking for an
 * expense that never existed.
 */
const loadExpense = createMiddleware<ExpenseEnv>(async (c, next) => {
  const expenseId = parse(uuidSchema, c.req.param('expenseId'));
  const db = c.get('db');

  const expense = await db
    .select()
    .from(schema.expenses)
    .where(and(eq(schema.expenses.id, expenseId), isNull(schema.expenses.deletedAt)))
    .get();
  if (!expense) throw errors.notFound('Expense');

  const membership = await db
    .select({ role: schema.groupMembers.role })
    .from(schema.groupMembers)
    .where(
      and(
        eq(schema.groupMembers.groupId, expense.groupId),
        eq(schema.groupMembers.userId, c.get('user').id),
      ),
    )
    .get();
  if (!membership) throw errors.notFound('Expense');

  c.set('memberRole', membership.role);
  c.set('expense', expense);
  await next();
});

const expenses = new Hono<ExpenseEnv>();

expenses.use('/:expenseId', loadExpense);

expenses.get('/:expenseId', async (c) => {
  const expense = c.get('expense');
  const splits = await expenseSplitsOf(c.get('db'), expense.id);
  return c.json(serializeExpense({ ...expense, splits }));
});

/** Only whoever created the expense, or the group owner, may change it. */
function assertCanModify(c: Context<ExpenseEnv>): void {
  if (c.get('expense').createdBy !== c.get('user').id && c.get('memberRole') !== 'owner') {
    throw errors.forbidden('Only the expense creator or the group owner can change this expense');
  }
}

expenses.patch('/:expenseId', async (c) => {
  assertCanModify(c);
  const existing = c.get('expense');
  const body = await parseBody(c, updateExpenseSchema);
  const db = c.get('db');

  const amount = body.amount ?? existing.amount;
  const split = body.split;

  if (body.paidBy || split) {
    assertMembers(
      await groupMemberIds(db, existing.groupId),
      body.paidBy ?? existing.paidBy,
      // With no new split, only the payer needs re-checking.
      split ?? { type: 'equal', participants: [] },
    );
  }

  // Changing the amount without restating the split would leave stored
  // shares that no longer add up to the total, so the shares are rebuilt
  // from whichever split definition applies.
  let splits = await expenseSplitsOf(db, existing.id);
  if (split) {
    splits = await replaceSplits(db, existing.id, resolveSplitOrThrow(amount, split));
  } else if (body.amount !== undefined && body.amount !== existing.amount) {
    const previous = Object.fromEntries(splits.map((s) => [s.userId, s.amount]));
    splits = await replaceSplits(
      db,
      existing.id,
      resolveSplitOrThrow(amount, { type: 'shares', shares: previous }),
    );
  }

  const [updated] = await db
    .update(schema.expenses)
    .set({
      amount,
      currency: body.currency ?? existing.currency,
      description: body.description ?? existing.description,
      paidBy: body.paidBy ?? existing.paidBy,
      splitType: split ? split.type : existing.splitType,
      updatedAt: Date.now(),
    })
    .where(eq(schema.expenses.id, existing.id))
    .returning();

  if (!updated) throw errors.notFound('Expense');
  return c.json(serializeExpense({ ...updated, splits }));
});

/**
 * Soft delete. Expenses are financial records, so the row stays for audit
 * history and is only excluded from balance calculations
 * (docs/03-DATA-MODEL.md).
 */
expenses.delete('/:expenseId', async (c) => {
  assertCanModify(c);
  const expense = c.get('expense');
  const now = Date.now();

  await c
    .get('db')
    .update(schema.expenses)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(schema.expenses.id, expense.id));

  return c.body(null, 204);
});

export default expenses;
