import { and, eq, gt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { createMiddleware } from 'hono/factory';
import { sha256Hex, verifyPass } from './crypto';
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
  /** Count per client address, or per verified client pass (`requirePass` must run first). */
  by: 'address' | 'pass';
}

/**
 * The limits from docs/05-SECURITY.md §3, all per hour.
 *
 * Creates and claims are counted per **client pass**: a browser that passed
 * a Turnstile check. That way a campus network or a mobile carrier sharing
 * one address does not make strangers share one limit. Each also has a
 * looser per-address backstop, so one address cannot mint passes and burn
 * the budget at scale.
 *
 * Only writes are limited. Each check is itself a D1 write, and D1 Free
 * allows 100,000 rows written per day across the whole app
 * (docs/02-ARCHITECTURE.md §3). Limiting reads would spend that budget on
 * the most common request, and would not save the Worker request budget
 * anyway, because a 429 still counts as a request.
 */
const HOUR = 60 * 60;
export const RATE_LIMITS = {
  pass: { scope: 'pass', limit: 300, windowSeconds: HOUR, by: 'address' },
  create: { scope: 'create', limit: 30, windowSeconds: HOUR, by: 'pass' },
  createBackstop: { scope: 'create-ip', limit: 120, windowSeconds: HOUR, by: 'address' },
  claim: { scope: 'claim', limit: 20, windowSeconds: HOUR, by: 'pass' },
  claimBackstop: { scope: 'claim-ip', limit: 120, windowSeconds: HOUR, by: 'address' },
  write: { scope: 'write', limit: 120, windowSeconds: HOUR, by: 'address' },
} as const satisfies Record<string, RateLimitRule>;

/**
 * The rate-limit subject for a request. IPv4 addresses count individually.
 * IPv6 is keyed by its /64 prefix, because one host routinely owns a whole
 * /64 and could otherwise rotate through 2^64 fresh addresses to reset its
 * limit.
 */
export function clientKey(ip: string | undefined): string {
  if (!ip) return 'unknown';
  if (!ip.includes(':')) return ip;
  // IPv4-mapped IPv6 (::ffff:203.0.113.7) is really an IPv4 client.
  if (ip.includes('.')) return ip.slice(ip.lastIndexOf(':') + 1);
  const [head = '', tail = ''] = ip.toLowerCase().split('::');
  const front = head ? head.split(':') : [];
  const back = tail ? tail.split(':') : [];
  const groups = [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill('0'), ...back];
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

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
    const subject = rule.by === 'pass' ? c.get('passId') : clientKey(c.req.header('cf-connecting-ip'));
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
      // Logged without the subject: an address is personal data, and the
      // scope alone says which limit real traffic is hitting.
      console.warn(JSON.stringify({ event: 'rate_limited', scope: rule.scope }));
      const retryAfter = Math.max(1, Math.ceil((expiresAt - now) / 1000));
      throw new ApiError('RATE_LIMITED', 'Too many requests. Try again later.', {
        headers: { 'Retry-After': String(retryAfter) },
      });
    }

    await next();
  });
}

/**
 * A valid client pass in `X-Tallyup-Pass`, issued by POST /v1/pass after a
 * Turnstile check. Guards the two anonymous writes: creating a share and
 * adding a claim.
 */
export const requirePass = createMiddleware<AppEnv>(async (c, next) => {
  const pass = c.req.header('X-Tallyup-Pass');
  const passId = pass ? await verifyPass(c.env.PASS_SECRET, pass) : undefined;
  if (!passId) throw new ApiError('PASS_REQUIRED', 'Verify this browser first (POST /v1/pass)');
  c.set('passId', passId);
  await next();
});

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
