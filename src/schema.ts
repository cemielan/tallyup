import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Timestamps are unix milliseconds. The server never sees plaintext event
// data: every payload column holds AES-GCM ciphertext produced in the
// browser, keyed by a secret that lives only in the share link's fragment
// (docs/05-SECURITY.md §2).

export const shares = sqliteTable(
  'shares',
  {
    // 128 random bits, base64url. Not a secret on its own -- without the key
    // from the link fragment it unlocks nothing -- but unguessable anyway.
    id: text('id').primaryKey(),
    ciphertext: text('ciphertext').notNull(),
    iv: text('iv').notNull(),
    // SHA-256 of the edit token, never the token itself.
    editTokenHash: text('edit_token_hash').notNull(),
    // Optimistic concurrency: an update names the version it replaces.
    version: integer('version').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    // Moved forward on every update; the daily sweep deletes what has lapsed.
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [index('shares_expires_at_idx').on(t.expiresAt)],
);

/**
 * "I paid" claims written by viewers. Encrypted with the same key as the
 * share, so the server cannot tell who claims to have paid whom. The host
 * confirms a claim by writing it into the event document, then deletes it.
 */
export const shareClaims = sqliteTable(
  'share_claims',
  {
    id: text('id').primaryKey(),
    shareId: text('share_id')
      .notNull()
      .references(() => shares.id),
    ciphertext: text('ciphertext').notNull(),
    iv: text('iv').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('share_claims_share_id_idx').on(t.shareId)],
);

/**
 * Rate-limit counters. Kept in D1 rather than KV: the free KV write budget
 * is 1,000/day, which a per-request counter blows almost immediately, while
 * D1 allows a single upsert per request comfortably within its own free
 * limits. See docs/02-ARCHITECTURE.md §3.
 */
export const rateLimits = sqliteTable('rate_limits', {
  // `${scope}:${subject}:${windowStart}` -- the window start is part of the
  // key, so expired windows never need reading and can be swept in bulk.
  key: text('key').primaryKey(),
  count: integer('count').notNull(),
  expiresAt: integer('expires_at').notNull(),
});
