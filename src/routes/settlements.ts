import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { ApiError, errors } from '../errors';
import { recordExpense } from '../ledger';
import * as schema from '../schema';
import type { AppEnv } from '../types';
import { parse, uuidSchema } from '../validation';

type Settlement = typeof schema.settlements.$inferSelect;

type SettlementEnv = {
  Bindings: AppEnv['Bindings'];
  Variables: AppEnv['Variables'] & { settlement: Settlement };
};

/**
 * Only the receiving party can resolve a settlement (FR-404): a payer saying
 * "I paid you" is a claim, not a fact, and letting them finalize it
 * unilaterally would let anyone write off their own debt.
 */
const loadSettlement = createMiddleware<SettlementEnv>(async (c, next) => {
  const settlementId = parse(uuidSchema, c.req.param('settlementId'));

  const settlement = await c
    .get('db')
    .select()
    .from(schema.settlements)
    .where(eq(schema.settlements.id, settlementId))
    .get();

  // 404 rather than 403 for someone else's settlement, so its existence is
  // not confirmed to a caller with no part in it.
  if (!settlement || settlement.toUserId !== c.get('user').id) {
    throw errors.notFound('Settlement');
  }
  if (settlement.status !== 'pending') {
    throw new ApiError('VALIDATION_ERROR', `This settlement is already ${settlement.status}`);
  }

  c.set('settlement', settlement);
  await next();
});

const settlements = new Hono<SettlementEnv>();

settlements.use('/:settlementId/*', loadSettlement);

settlements.post('/:settlementId/confirm', async (c) => {
  const settlement = c.get('settlement');
  const db = c.get('db');

  /**
   * Confirming records a balancing expense rather than adjusting a stored
   * balance: the payer is credited with the amount and the recipient carries
   * the whole share, which nets both positions down by exactly that amount.
   * `calculateBalances` therefore stays the only thing that decides who owes
   * what (FR-403).
   */
  const expense = await recordExpense(db, {
    groupId: settlement.groupId,
    paidBy: settlement.fromUserId,
    createdBy: c.get('user').id,
    amount: settlement.amount,
    currency: settlement.currency,
    description: 'Settlement payment',
    split: { type: 'exact', amounts: { [settlement.toUserId]: settlement.amount } },
    isSettlement: true,
  });

  const [updated] = await db
    .update(schema.settlements)
    .set({ status: 'confirmed', confirmingExpenseId: expense.id, resolvedAt: Date.now() })
    .where(eq(schema.settlements.id, settlement.id))
    .returning();

  return c.json({ settlement: updated, confirmingExpenseId: expense.id });
});

settlements.post('/:settlementId/decline', async (c) => {
  // Declining touches no expense, so balances are unchanged -- the proposed
  // payment simply never happened.
  const [updated] = await c
    .get('db')
    .update(schema.settlements)
    .set({ status: 'declined', resolvedAt: Date.now() })
    .where(eq(schema.settlements.id, c.get('settlement').id))
    .returning();

  return c.json({ settlement: updated });
});

export default settlements;
