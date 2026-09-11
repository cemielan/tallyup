import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Timestamps are unix milliseconds (integers), money is minor currency units
// (integers) -- never floats. See docs/03-DATA-MODEL.md.
const createdAt = () =>
  integer('created_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`);

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('users_email_unique').on(t.email)],
);

export const refreshTokens = sqliteTable(
  'refresh_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    // A SHA-256 hash of the opaque token, never the token itself (SECURITY §2).
    tokenHash: text('token_hash').notNull(),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('refresh_tokens_user_id_idx').on(t.userId),
    index('refresh_tokens_token_hash_idx').on(t.tokenHash),
  ],
);

export const groups = sqliteTable(
  'groups',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    inviteCode: text('invite_code').notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('groups_invite_code_unique').on(t.inviteCode)],
);

export const groupMembers = sqliteTable(
  'group_members',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role', { enum: ['owner', 'member'] }).notNull(),
    joinedAt: integer('joined_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    // The composite PK does not serve a user_id-only lookup ("list my
    // groups", FR-203), so it needs its own index.
    index('group_members_user_id_idx').on(t.userId),
  ],
);

export const expenses = sqliteTable(
  'expenses',
  {
    id: text('id').primaryKey(),
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id),
    paidBy: text('paid_by')
      .notNull()
      .references(() => users.id),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    amount: integer('amount').notNull(),
    currency: text('currency').notNull(),
    description: text('description').notNull(),
    splitType: text('split_type', {
      enum: ['equal', 'exact', 'percentage', 'shares'],
    }).notNull(),
    isSettlement: integer('is_settlement', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: integer('updated_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    // Soft delete: expenses are financial records, so deleting one hides it
    // from balance computation but keeps the audit trail.
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    index('expenses_group_id_idx').on(t.groupId),
    index('expenses_group_id_created_at_idx').on(t.groupId, t.createdAt),
  ],
);

export const expenseSplits = sqliteTable(
  'expense_splits',
  {
    id: text('id').primaryKey(),
    expenseId: text('expense_id')
      .notNull()
      .references(() => expenses.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    // The share resolved at write time, so a later change in the library's
    // rounding behavior cannot retroactively alter historical expenses.
    amount: integer('amount').notNull(),
  },
  (t) => [index('expense_splits_expense_id_idx').on(t.expenseId)],
);

export const settlements = sqliteTable(
  'settlements',
  {
    id: text('id').primaryKey(),
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id),
    fromUserId: text('from_user_id')
      .notNull()
      .references(() => users.id),
    toUserId: text('to_user_id')
      .notNull()
      .references(() => users.id),
    amount: integer('amount').notNull(),
    currency: text('currency').notNull(),
    status: text('status', { enum: ['pending', 'confirmed', 'declined'] }).notNull(),
    confirmingExpenseId: text('confirming_expense_id').references(() => expenses.id),
    createdAt: createdAt(),
    resolvedAt: integer('resolved_at'),
  },
  (t) => [index('settlements_group_id_status_idx').on(t.groupId, t.status)],
);

/**
 * Rate-limit counters. Kept in D1 rather than KV: the free KV write budget
 * is 1,000/day, which a per-request counter blows almost immediately, while
 * D1 allows a single upsert per request comfortably within its own free
 * limits. See docs/02-ARCHITECTURE.md §3.
 */
export const rateLimits = sqliteTable('rate_limits', {
  // `${scope}:${subject}:${windowStart}` -- the window start is part of the
  // key, so expired windows never need reading and can be swept lazily.
  key: text('key').primaryKey(),
  count: integer('count').notNull(),
  expiresAt: integer('expires_at').notNull(),
});
