import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { sign } from 'hono/jwt';
import {
  DEFAULT_PBKDF2_ITERATIONS,
  dummyVerify,
  generateOpaqueToken,
  hashPassword,
  newId,
  sha256Hex,
  verifyPassword,
} from '../crypto';
import { ApiError } from '../errors';
import * as schema from '../schema';
import type { AppEnv, AuthenticatedUser } from '../types';
import { RATE_LIMITS, rateLimit, requireAuth } from '../middleware';
import { loginSchema, parseBody, refreshSchema, registerSchema } from '../validation';

/** Access tokens are short-lived because they are bearer credentials. */
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The benchmarked default, overridable per environment. The override exists
 * so tests can run a trivial count and so a deployment on a plan with a
 * bigger CPU budget can raise it without a code change.
 */
function iterations(env: AppEnv['Bindings']): number {
  const parsed = Number.parseInt(env.PBKDF2_ITERATIONS ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_PBKDF2_ITERATIONS;
}

const publicUser = (user: AuthenticatedUser) => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
});

const auth = new Hono<AppEnv>();

auth.post('/register', rateLimit(RATE_LIMITS.auth), async (c) => {
  const body = await parseBody(c, registerSchema);
  const db = c.get('db');

  const existing = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, body.email))
    .get();
  if (existing) {
    throw new ApiError('EMAIL_TAKEN', 'An account with this email already exists');
  }

  const user = {
    id: newId(),
    email: body.email,
    displayName: body.displayName,
    passwordHash: await hashPassword(body.password, iterations(c.env)),
  };
  await db.insert(schema.users).values(user);

  return c.json({ user: publicUser(user) }, 201);
});

auth.post('/login', rateLimit(RATE_LIMITS.auth), async (c) => {
  const body = await parseBody(c, loginSchema);
  const db = c.get('db');

  const user = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, body.email))
    .get();

  // Identical outcome for "no such user" and "wrong password", including the
  // CPU spent getting there, so neither the message nor the response time
  // reveals whether an email is registered (docs/05-SECURITY.md §2).
  if (!user) {
    await dummyVerify(iterations(c.env));
    throw new ApiError('INVALID_CREDENTIALS', 'Email or password is incorrect');
  }
  if (!(await verifyPassword(body.password, user.passwordHash))) {
    throw new ApiError('INVALID_CREDENTIALS', 'Email or password is incorrect');
  }

  return c.json(await issueSession(c, user));
});

auth.post('/refresh', async (c) => {
  const { refreshToken } = await parseBody(c, refreshSchema);
  const db = c.get('db');
  const tokenHash = await sha256Hex(refreshToken);

  const stored = await db
    .select()
    .from(schema.refreshTokens)
    .where(eq(schema.refreshTokens.tokenHash, tokenHash))
    .get();

  const invalid = new ApiError('INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired');
  if (!stored) throw invalid;

  // A token that was already used or revoked showing up again means either a
  // stolen token or a replay. Either way the whole family is compromised, so
  // every session for that user dies (docs/05-SECURITY.md §2).
  if (stored.revokedAt !== null) {
    await db
      .update(schema.refreshTokens)
      .set({ revokedAt: Date.now() })
      .where(
        and(eq(schema.refreshTokens.userId, stored.userId), isNull(schema.refreshTokens.revokedAt)),
      );
    throw invalid;
  }

  if (stored.expiresAt <= Date.now()) throw invalid;

  const user = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, stored.userId))
    .get();
  if (!user) throw invalid;

  await db
    .update(schema.refreshTokens)
    .set({ revokedAt: Date.now() })
    .where(eq(schema.refreshTokens.id, stored.id));

  return c.json(await issueSession(c, user));
});

auth.post('/logout', requireAuth, rateLimit(RATE_LIMITS.api), async (c) => {
  const { refreshToken } = await parseBody(c, refreshSchema);
  await c
    .get('db')
    .update(schema.refreshTokens)
    .set({ revokedAt: Date.now() })
    .where(
      and(
        eq(schema.refreshTokens.tokenHash, await sha256Hex(refreshToken)),
        eq(schema.refreshTokens.userId, c.get('user').id),
      ),
    );

  // 204 whether or not the token existed: a logout that reports "that token
  // was not yours" is an oracle, and the caller has nothing to do with the
  // answer either way.
  return c.body(null, 204);
});

auth.post('/logout-all', requireAuth, rateLimit(RATE_LIMITS.api), async (c) => {
  await c
    .get('db')
    .update(schema.refreshTokens)
    .set({ revokedAt: Date.now() })
    .where(
      and(
        eq(schema.refreshTokens.userId, c.get('user').id),
        isNull(schema.refreshTokens.revokedAt),
      ),
    );
  return c.body(null, 204);
});

/**
 * Mint a fresh access/refresh pair. The refresh token is returned to the
 * client once and stored only as a SHA-256 hash, so a database leak does not
 * hand over usable sessions.
 */
async function issueSession(
  c: Context<AppEnv>,
  user: { id: string; email: string; displayName: string },
) {
  const now = Math.floor(Date.now() / 1000);
  const accessToken = await sign(
    {
      sub: user.id,
      email: user.email,
      displayName: user.displayName,
      iat: now,
      exp: now + ACCESS_TOKEN_TTL_SECONDS,
    },
    c.env.JWT_SECRET,
    'HS256',
  );

  const refreshToken = generateOpaqueToken();
  await c.get('db').insert(schema.refreshTokens).values({
    id: newId(),
    userId: user.id,
    tokenHash: await sha256Hex(refreshToken),
    expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
  });

  return {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    user: publicUser(user),
  };
}

export default auth;
