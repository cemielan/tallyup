import { and, eq, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { createMiddleware } from 'hono/factory';
import { verify } from 'hono/jwt';
import { ApiError, errors } from './errors';
import * as schema from './schema';
import type { AppEnv } from './types';

/** Attach a Drizzle handle bound to this request's D1 binding. */
export const withDb = createMiddleware<AppEnv>(async (c, next) => {
  c.set('db', drizzle(c.env.DB, { schema }));
  await next();
});

/**
 * Verify the access token and put the caller on the context.
 *
 * The identity comes from the token's own claims rather than a database read:
 * access tokens live 15 minutes, so that is the longest a stale claim can
 * survive, and skipping the read keeps this middleware off the D1 subrequest
 * budget for every single authenticated call. Handlers that must see current
 * data (`GET /v1/users/me`) read the row themselves.
 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    throw errors.unauthenticated();
  }

  let payload: Record<string, unknown>;
  try {
    payload = await verify(header.slice('Bearer '.length), c.env.JWT_SECRET, 'HS256');
  } catch {
    // Covers a bad signature, a malformed token, and an expired one alike --
    // the client cannot tell which, and does not need to.
    throw errors.unauthenticated();
  }

  const { sub, email, displayName } = payload;
  if (typeof sub !== 'string' || typeof email !== 'string' || typeof displayName !== 'string') {
    throw errors.unauthenticated();
  }

  c.set('user', { id: sub, email, displayName });
  await next();
});

interface RateLimitRule {
  /** Distinguishes endpoint classes so their counters never collide. */
  scope: string;
  limit: number;
  windowSeconds: number;
  /** Per-IP limits protect unauthenticated routes; per-user limits the rest. */
  by: 'ip' | 'user';
}

/** The minimum limits required by docs/05-SECURITY.md §4. */
export const RATE_LIMITS = {
  auth: { scope: 'auth', limit: 5, windowSeconds: 5 * 60, by: 'ip' },
  join: { scope: 'join', limit: 10, windowSeconds: 60 * 60, by: 'ip' },
  api: { scope: 'api', limit: 100, windowSeconds: 60, by: 'user' },
} as const satisfies Record<string, RateLimitRule>;

/**
 * Fixed-window counter held in D1.
 *
 * D1 rather than KV: the free KV write budget is 1,000/day
 * (docs/02-ARCHITECTURE.md §3), which a per-request counter exhausts inside
 * an hour of modest traffic, whereas D1's free write allowance is two orders
 * of magnitude larger. One upsert per request, no read-then-write race.
 *
 * ponytail: fixed window, so a caller can burst up to 2x the limit across a
 * window boundary. Phase 1 explicitly permits a simple window
 * (docs/07-ROADMAP.md); move to a sliding window if that burst matters.
 */
export function rateLimit(rule: RateLimitRule) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const subject =
      rule.by === 'user' ? c.get('user').id : (c.req.header('cf-connecting-ip') ?? 'unknown-ip');

    const now = Date.now();
    const windowMs = rule.windowSeconds * 1000;
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const expiresAt = windowStart + windowMs;
    const db = c.get('db');

    const [row] = await db
      .insert(schema.rateLimits)
      .values({ key: `${rule.scope}:${subject}:${windowStart}`, count: 1, expiresAt })
      .onConflictDoUpdate({
        target: schema.rateLimits.key,
        set: { count: sql`${schema.rateLimits.count} + 1` },
      })
      .returning({ count: schema.rateLimits.count });

    if (row && row.count > rule.limit) {
      const retryAfter = Math.max(1, Math.ceil((expiresAt - now) / 1000));
      throw new ApiError('RATE_LIMITED', 'Too many requests. Try again later.', {
        headers: { 'Retry-After': String(retryAfter) },
      });
    }

    // Sweep expired counters occasionally rather than on a schedule -- the
    // table is a cache, and a cron trigger for it would be a moving part
    // that earns nothing.
    if (Math.random() < 0.01) {
      await db.delete(schema.rateLimits).where(lt(schema.rateLimits.expiresAt, now));
    }

    await next();
  });
}

/**
 * Group membership check, applied as middleware to every group-scoped route
 * rather than copied into each handler -- a missed copy-paste is exactly how
 * IDOR bugs get shipped (docs/05-SECURITY.md §3).
 *
 * A non-member gets 404, not 403, so they cannot tell an existing group they
 * are excluded from apart from one that does not exist.
 */
export const requireMembership = createMiddleware<AppEnv>(async (c, next) => {
  const groupId = c.req.param('groupId');
  if (!groupId) throw errors.notFound('Group');

  const membership = await c
    .get('db')
    .select({ role: schema.groupMembers.role })
    .from(schema.groupMembers)
    .where(
      and(eq(schema.groupMembers.groupId, groupId), eq(schema.groupMembers.userId, c.get('user').id)),
    )
    .get();

  if (!membership) throw errors.notFound('Group');

  c.set('memberRole', membership.role);
  await next();
});

/** Owner-only actions. Always decided server-side from the stored role. */
export const requireOwner = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get('memberRole') !== 'owner') {
    throw errors.forbidden('Only the group owner can perform this action');
  }
  await next();
});
