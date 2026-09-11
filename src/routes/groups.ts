import { and, count, desc, eq, isNull, ne } from 'drizzle-orm';
import { Hono } from 'hono';
import { generateInviteCode, newId } from '../crypto';
import { ApiError, errors } from '../errors';
import {
  assertMembers,
  balancesByCurrency,
  groupMemberIds,
  hasZeroBalance,
  recordExpense,
  serializeExpense,
  suggestedTransfers,
} from '../ledger';
import { RATE_LIMITS, rateLimit, requireMembership, requireOwner } from '../middleware';
import * as schema from '../schema';
import type { AppEnv } from '../types';
import {
  MAX_GROUP_MEMBERS,
  createExpenseSchema,
  createGroupSchema,
  createSettlementSchema,
  joinGroupSchema,
  paginate,
  parse,
  parseBody,
  parsePagination,
  uuidSchema,
} from '../validation';

const groups = new Hono<AppEnv>();

groups.post('/', async (c) => {
  const { name } = await parseBody(c, createGroupSchema);
  const db = c.get('db');
  const group = {
    id: newId(),
    name,
    inviteCode: generateInviteCode(),
    createdBy: c.get('user').id,
  };

  // Creating a group and becoming its owner is one fact, not two -- batch
  // them so a failure cannot leave an ownerless group behind.
  await db.batch([
    db.insert(schema.groups).values(group),
    db
      .insert(schema.groupMembers)
      .values({ groupId: group.id, userId: c.get('user').id, role: 'owner' }),
  ]);

  return c.json({ id: group.id, name: group.name, inviteCode: group.inviteCode, role: 'owner' }, 201);
});

groups.get('/', async (c) => {
  const { page, pageSize } = parsePagination(c);
  const db = c.get('db');
  const userId = c.get('user').id;

  const [total] = await db
    .select({ value: count() })
    .from(schema.groupMembers)
    .where(eq(schema.groupMembers.userId, userId));

  const rows = await db
    .select({
      id: schema.groups.id,
      name: schema.groups.name,
      role: schema.groupMembers.role,
      joinedAt: schema.groupMembers.joinedAt,
      createdAt: schema.groups.createdAt,
    })
    .from(schema.groupMembers)
    .innerJoin(schema.groups, eq(schema.groups.id, schema.groupMembers.groupId))
    .where(eq(schema.groupMembers.userId, userId))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return c.json(paginate(rows, total?.value ?? 0, page, pageSize));
});

groups.post('/join', rateLimit(RATE_LIMITS.join), async (c) => {
  const { inviteCode } = await parseBody(c, joinGroupSchema);
  const db = c.get('db');
  const userId = c.get('user').id;

  const group = await db
    .select({ id: schema.groups.id, name: schema.groups.name })
    .from(schema.groups)
    .where(eq(schema.groups.inviteCode, inviteCode))
    .get();

  if (!group) {
    throw new ApiError('NOT_FOUND', 'Invite code is not valid');
  }

  const existing = await db
    .select({ role: schema.groupMembers.role })
    .from(schema.groupMembers)
    .where(and(eq(schema.groupMembers.groupId, group.id), eq(schema.groupMembers.userId, userId)))
    .get();
  if (existing) {
    throw new ApiError('ALREADY_MEMBER', 'You are already a member of this group');
  }

  const [members] = await db
    .select({ value: count() })
    .from(schema.groupMembers)
    .where(eq(schema.groupMembers.groupId, group.id));
  if ((members?.value ?? 0) >= MAX_GROUP_MEMBERS) {
    throw new ApiError(
      'VALIDATION_ERROR',
      `This group has reached the maximum of ${MAX_GROUP_MEMBERS} members`,
    );
  }

  await db.insert(schema.groupMembers).values({ groupId: group.id, userId, role: 'member' });
  return c.json({ id: group.id, name: group.name, role: 'member' });
});

/**
 * Every nested group route -- expenses, balances, settlements, members --
 * goes through one membership check rather than a per-handler copy, because
 * the handler someone forgets to guard is how IDOR ships
 * (docs/05-SECURITY.md §3). `/join` and `/` have no `:groupId` segment, so
 * this pattern deliberately cannot match them.
 */
groups.use('/:groupId/*', requireMembership);

groups.get('/:groupId', requireMembership, async (c) => {
  const groupId = c.req.param('groupId');
  const db = c.get('db');

  const group = await db
    .select()
    .from(schema.groups)
    .where(eq(schema.groups.id, groupId))
    .get();
  if (!group) throw errors.notFound('Group');

  const members = await db
    .select({
      id: schema.users.id,
      displayName: schema.users.displayName,
      role: schema.groupMembers.role,
      joinedAt: schema.groupMembers.joinedAt,
    })
    .from(schema.groupMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.groupMembers.userId))
    .where(eq(schema.groupMembers.groupId, groupId));

  return c.json({
    id: group.id,
    name: group.name,
    createdAt: new Date(group.createdAt).toISOString(),
    // The invite code is a join credential, so only an owner sees it.
    ...(c.get('memberRole') === 'owner' ? { inviteCode: group.inviteCode } : {}),
    members,
  });
});

groups.post('/:groupId/invite/rotate', requireOwner, async (c) => {
  const inviteCode = generateInviteCode();
  await c
    .get('db')
    .update(schema.groups)
    .set({ inviteCode })
    .where(eq(schema.groups.id, c.req.param('groupId')));

  return c.json({ inviteCode });
});

/**
 * Removes a member, and doubles as "leave group" when a caller names
 * themself (FR-205/206). Either way the member must be square with everyone
 * first -- letting someone walk away from a debt would make the group's
 * balance sheet stop summing to zero.
 */
groups.delete('/:groupId/members/:userId', async (c) => {
  const groupId = c.req.param('groupId');
  const targetUserId = parse(uuidSchema, c.req.param('userId'));
  const callerId = c.get('user').id;

  if (targetUserId !== callerId && c.get('memberRole') !== 'owner') {
    throw errors.forbidden('Only the group owner can remove another member');
  }

  const db = c.get('db');
  const target = await db
    .select({ role: schema.groupMembers.role })
    .from(schema.groupMembers)
    .where(
      and(eq(schema.groupMembers.groupId, groupId), eq(schema.groupMembers.userId, targetUserId)),
    )
    .get();
  if (!target) throw errors.notFound('Group member');

  if (!hasZeroBalance(await balancesByCurrency(db, groupId), targetUserId)) {
    throw new ApiError(
      'NONZERO_BALANCE',
      'This member still has an outstanding balance in this group',
    );
  }

  // An owner leaving would strand the group with nobody able to rotate the
  // invite code or remove members, so promote the longest-standing remaining
  // member first -- unless another owner is already there.
  if (target.role === 'owner') {
    const others = await db
      .select({ userId: schema.groupMembers.userId, role: schema.groupMembers.role })
      .from(schema.groupMembers)
      .where(
        and(eq(schema.groupMembers.groupId, groupId), ne(schema.groupMembers.userId, targetUserId)),
      )
      .orderBy(schema.groupMembers.joinedAt);

    const successor = others.some((m) => m.role === 'owner') ? undefined : others[0];
    if (successor) {
      await db
        .update(schema.groupMembers)
        .set({ role: 'owner' })
        .where(
          and(
            eq(schema.groupMembers.groupId, groupId),
            eq(schema.groupMembers.userId, successor.userId),
          ),
        );
    }
  }

  await db
    .delete(schema.groupMembers)
    .where(
      and(eq(schema.groupMembers.groupId, groupId), eq(schema.groupMembers.userId, targetUserId)),
    );

  return c.body(null, 204);
});

groups.post('/:groupId/expenses', async (c) => {
  const groupId = c.req.param('groupId');
  const body = await parseBody(c, createExpenseSchema);
  const db = c.get('db');

  assertMembers(await groupMemberIds(db, groupId), body.paidBy, body.split);

  const expense = await recordExpense(db, {
    groupId,
    paidBy: body.paidBy,
    createdBy: c.get('user').id,
    amount: body.amount,
    currency: body.currency,
    description: body.description,
    split: body.split,
  });

  return c.json(serializeExpense(expense), 201);
});

groups.get('/:groupId/expenses', async (c) => {
  const groupId = c.req.param('groupId');
  const { page, pageSize } = parsePagination(c);
  const db = c.get('db');

  const notDeleted = and(eq(schema.expenses.groupId, groupId), isNull(schema.expenses.deletedAt));

  const [total] = await db.select({ value: count() }).from(schema.expenses).where(notDeleted);

  // Newest first, served straight off the (group_id, created_at) index so
  // there is no sort at read time (NFR-204).
  const rows = await db
    .select()
    .from(schema.expenses)
    .where(notDeleted)
    .orderBy(desc(schema.expenses.createdAt), desc(schema.expenses.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return c.json(paginate(rows.map(serializeExpense), total?.value ?? 0, page, pageSize));
});

groups.get('/:groupId/balances', async (c) => {
  const db = c.get('db');
  const sheets = await balancesByCurrency(db, c.req.param('groupId'));
  const names = await memberNames(db, c.req.param('groupId'));

  // One entry per (user, currency) pair holding a non-zero balance. A
  // settled-up member simply does not appear.
  const balances = Object.entries(sheets).flatMap(([currency, sheet]) =>
    Object.entries(sheet)
      .filter(([, amount]) => amount !== 0)
      .map(([userId, amount]) => ({
        userId,
        displayName: names.get(userId) ?? null,
        amount,
        currency,
      })),
  );

  return c.json({ balances });
});

groups.get('/:groupId/settlements/suggested', async (c) => {
  const db = c.get('db');
  const groupId = c.req.param('groupId');
  const suggested = suggestedTransfers(await balancesByCurrency(db, groupId));

  // Computed fresh from current balances every time -- this is not a stored
  // resource, so it has no id and cannot be fetched by one.
  return c.json({ suggested });
});

groups.post('/:groupId/settlements', async (c) => {
  const groupId = c.req.param('groupId');
  const body = await parseBody(c, createSettlementSchema);
  const db = c.get('db');
  const fromUserId = c.get('user').id;

  if (body.toUserId === fromUserId) {
    throw errors.validation('You cannot settle up with yourself');
  }
  if (!(await groupMemberIds(db, groupId)).has(body.toUserId)) {
    throw new ApiError('NON_MEMBER_PARTICIPANT', 'That user is not a member of this group');
  }

  const settlement = {
    id: newId(),
    groupId,
    fromUserId,
    toUserId: body.toUserId,
    amount: body.amount,
    currency: body.currency,
    status: 'pending' as const,
  };
  await db.insert(schema.settlements).values(settlement);

  // Pending, not confirmed: only the person being paid can say the money
  // arrived (FR-404), so proposing a settlement changes no balance yet.
  return c.json(settlement, 201);
});

groups.get('/:groupId/settlements', async (c) => {
  const { page, pageSize } = parsePagination(c);
  const db = c.get('db');
  const groupId = c.req.param('groupId');

  const [total] = await db
    .select({ value: count() })
    .from(schema.settlements)
    .where(eq(schema.settlements.groupId, groupId));

  const rows = await db
    .select()
    .from(schema.settlements)
    .where(eq(schema.settlements.groupId, groupId))
    .orderBy(desc(schema.settlements.createdAt), desc(schema.settlements.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return c.json(paginate(rows, total?.value ?? 0, page, pageSize));
});

async function memberNames(
  db: AppEnv['Variables']['db'],
  groupId: string,
): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: schema.users.id, displayName: schema.users.displayName })
    .from(schema.groupMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.groupMembers.userId))
    .where(eq(schema.groupMembers.groupId, groupId));
  return new Map(rows.map((row) => [row.id, row.displayName]));
}

export default groups;
