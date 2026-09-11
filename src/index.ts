import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { ApiError } from './errors';
import { RATE_LIMITS, rateLimit, requireAuth, withDb } from './middleware';
import { docsPage, openApiDocument } from './openapi';
import authRoutes from './routes/auth';
import expenseRoutes from './routes/expenses';
import groupRoutes from './routes/groups';
import settlementRoutes from './routes/settlements';
import userRoutes from './routes/users';
import type { AppEnv } from './types';

const app = new Hono<AppEnv>();

app.use('*', secureHeaders());

/**
 * An explicit origin allow-list, never `*`: these routes carry bearer
 * tokens, so any origin being allowed to read their responses would let a
 * hostile page act as the user (docs/05-SECURITY.md §6).
 */
app.use('*', async (c, next) => {
  const allowed = c.env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return cors({
    origin: (origin) => (allowed.includes(origin) ? origin : null),
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    maxAge: 86400,
    credentials: false,
  })(c, next);
});

/**
 * 64 KiB is far more than any endpoint here needs -- the largest legitimate
 * body is an expense with fifty participants -- and it stops a large upload
 * from spending CPU on parsing before validation can reject it.
 */
app.use('*', bodyLimit({ maxSize: 64 * 1024 }));

app.use('*', withDb);

app.get('/health', (c) => c.json({ status: 'ok', environment: c.env.ENVIRONMENT }));

app.get('/v1/openapi.json', (c) => c.json(openApiDocument(new URL('/v1', c.req.url).toString())));
app.get('/docs', (c) => c.html(docsPage('/v1/openapi.json')));

// Auth routes manage their own protection: register/login/refresh are public
// by necessity and rate-limited per IP instead.
app.route('/v1/auth', authRoutes);

// Everything else requires a valid access token, and is rate-limited per
// user rather than per IP so that one noisy network cannot lock out
// everyone behind it.
for (const prefix of ['/v1/users', '/v1/groups', '/v1/expenses', '/v1/settlements']) {
  app.use(prefix, requireAuth, rateLimit(RATE_LIMITS.api));
  app.use(`${prefix}/*`, requireAuth, rateLimit(RATE_LIMITS.api));
}

app.route('/v1/users', userRoutes);
app.route('/v1/groups', groupRoutes);
app.route('/v1/expenses', expenseRoutes);
app.route('/v1/settlements', settlementRoutes);

app.notFound((c) =>
  c.json({ error: { code: 'NOT_FOUND', message: 'No such endpoint' } }, 404),
);

/**
 * One error envelope for every failure (NFR-302). Anything that is not a
 * deliberate `ApiError` is a bug, so it is logged server-side and reported
 * to the client as a bare 500 -- a stack trace or a database message in a
 * response body is free reconnaissance.
 */
app.onError((error, c) => {
  if (error instanceof ApiError) {
    return c.json(error.toResponseBody(), error.status, error.headers);
  }

  console.error('Unhandled error', {
    path: c.req.path,
    method: c.req.method,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });

  return c.json(
    { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side' } },
    500,
  );
});

export default app;
