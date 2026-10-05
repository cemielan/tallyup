import { and, eq, gt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { createMiddleware } from 'hono/factory';
import { sha256Hex } from './crypto';
import { ApiError, errors } from './errors';
import * as schema from './schema';
import type { AppEnv } from './types';
import { parse, shareIdSchema } from './validation';

/** Attach a Drizzle handle bound to this request's D1 binding. */
export const withDb = createMiddleware<AppEnv>(async (c, next) => {
  c.set('db', drizzle(c.env.DB, { schema }));
  await next();
});

interface RateLimitRule {
  /** Distinguishes endpoint classes so their counters never collide. */
  scope: string;
  limit: number;
  windowSeconds: number;
}

/**
 * The limits from docs/05-SECURITY.md §3. There are no accounts, so every
 * limit is per IP. Creation and claims are the anonymous writes worth
 * throttling hard; `api` is the general ceiling on everything else.
 */
export const RATE_LIMITS = {
  api: { scope: 'api', limit: 120, windowSeconds: 60 },
  create: { scope: 'create', limit: 30, windowSeconds: 60 * 60 },
  claim: { scope: 'claim', limit: 20, windowSeconds: 60 * 60 },
} as const satisfies Record<string, RateLimitRule>;

/**
 * Fixed-window counter held in D1.
 *
 * D1 rather than KV: the free KV write budget is 1,000/day
 * (docs/02-ARCHITECTURE.md §3), which a per-request counter exhausts inside
 * an hour of modest traffic. One upsert per request, no read-then-write race.
 * Expired windows are deleted by the daily sweep (`sweepExpired`).
 *
 * ponytail: fixed window, so a caller can burst up to 2x the limit across a
 * window boundary. Move to a sliding window if that burst matters.
 */
export function rateLimit(rule: RateLimitRule) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const subject = c.req.header('cf-connecting-ip') ?? 'unknown-ip';
    const now = Date.now();
    const windowMs = rule.windowSeconds * 1000;
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const expiresAt = windowStart + windowMs;

    const [row] = await c
      .get('db')
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

    await next();
  });
}

/**
 * Load the share named in the path, treating an expired one exactly like a
 * missing one: the daily sweep may not have run yet, but a lapsed share is
 * gone as far as any caller is concerned.
 */
export const loadShare = createMiddleware<AppEnv>(async (c, next) => {
  const id = parse(shareIdSchema, c.req.param('shareId'));
  const share = await c
    .get('db')
    .select()
    .from(schema.shares)
    .where(and(eq(schema.shares.id, id), gt(schema.shares.expiresAt, Date.now())))
    .get();

  if (!share) throw errors.notFound('Share');
  c.set('share', share);
  await next();
});

/**
 * The edit token is the only write credential in the system. It arrives as
 * a bearer token and is compared by hash, so a database leak does not hand
 * out edit rights. Must run after `loadShare`.
 *
 * A plain string comparison is fine here: both sides are SHA-256 digests of
 * a 256-bit random value, so timing reveals nothing an attacker can steer.
 */
export const requireEditToken = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) throw errors.unauthenticated();

  const hash = await sha256Hex(header.slice('Bearer '.length));
  if (hash !== c.get('share').editTokenHash) throw errors.forbidden();
  await next();
});
