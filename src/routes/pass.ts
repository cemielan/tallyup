import { Hono } from 'hono';
import { signPass } from '../crypto';
import { ApiError } from '../errors';
import { RATE_LIMITS, rateLimit } from '../middleware';
import type { AppEnv } from '../types';
import { parseBody, passRequestSchema } from '../validation';

/** A pass lasts a day: one invisible check per device per day is enough friction for bots. */
export const PASS_TTL_MS = 24 * 60 * 60 * 1000;

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const pass = new Hono<AppEnv>();

/**
 * Exchange a Turnstile token for a client pass (docs/05-SECURITY.md §3).
 * The token is single-use and expires in five minutes; the pass it buys is
 * reusable for a day and costs no database write to check.
 */
pass.post('/', rateLimit(RATE_LIMITS.pass), async (c) => {
  const { token } = await parseBody(c, passRequestSchema);
  const ip = c.req.header('cf-connecting-ip');

  let outcome: { success?: boolean; 'error-codes'?: string[] };
  try {
    const response = await fetch(SITEVERIFY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: c.env.TURNSTILE_SECRET, response: token, ...(ip ? { remoteip: ip } : {}) }),
    });
    outcome = await response.json();
  } catch {
    // Fail closed: without a verdict there is no pass.
    outcome = { success: false, 'error-codes': ['siteverify-unreachable'] };
  }

  if (outcome.success !== true) {
    console.warn(JSON.stringify({ event: 'challenge_failed', codes: outcome['error-codes'] ?? [] }));
    throw new ApiError('CHALLENGE_FAILED', 'The browser check did not pass. Reload and try again.');
  }

  const expiresAt = Date.now() + PASS_TTL_MS;
  return c.json({ pass: await signPass(c.env.PASS_SECRET, expiresAt), expiresAt: new Date(expiresAt).toISOString() });
});

export default pass;
