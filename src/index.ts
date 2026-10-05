import { drizzle } from 'drizzle-orm/d1';
import { inArray, lt } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { ApiError } from './errors';
import { RATE_LIMITS, rateLimit, withDb } from './middleware';
import { docsPage, openApiDocument } from './openapi';
import shareRoutes from './routes/shares';
import * as schema from './schema';
import type { AppEnv, Bindings } from './types';

const app = new Hono<AppEnv>();

app.use('*', secureHeaders());

/**
 * Any origin may call the API (FR-401). That is safe here because nothing
 * about a request is ambient: there are no cookies, and the only credential
 * -- an edit token -- has to be attached explicitly by code that already
 * holds it. Another site's page gains nothing it could not get with curl
 * (docs/05-SECURITY.md §5).
 */
app.use(
  '/v1/*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    maxAge: 86400,
  }),
);

/**
 * 64 KiB comfortably fits the largest legal body (a share at its ciphertext
 * cap) and stops a large upload from spending CPU on parsing before
 * validation can reject it.
 */
app.use(
  '*',
  bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) =>
      c.json(new ApiError('PAYLOAD_TOO_LARGE', 'Request body is too large').toResponseBody(), 413),
  }),
);

app.use('*', withDb);

app.get('/health', (c) => c.json({ status: 'ok', environment: c.env.ENVIRONMENT }));
app.get('/v1/openapi.json', (c) => c.json(openApiDocument(new URL('/v1', c.req.url).toString())));
app.get('/docs', (c) => c.html(docsPage('/v1/openapi.json')));

// Updates and deletes only. Reads are not limited (see RATE_LIMITS), and the
// two POSTs carry their own, stricter limits; stacking this one on them would
// spend a second D1 write per create or claim for no extra protection.
const writeLimit = rateLimit(RATE_LIMITS.write);
app.on(['PUT', 'DELETE'], '/v1/shares/*', writeLimit);
app.route('/v1/shares', shareRoutes);

app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'No such endpoint' } }, 404));

/**
 * One error envelope for every failure. Anything that is not a deliberate
 * `ApiError` is a bug, so it is logged server-side and reported to the
 * client as a bare 500 -- a stack trace or a database message in a response
 * body is free reconnaissance.
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

/**
 * Delete lapsed shares, their claims, and expired rate-limit windows. Run
 * daily by the cron trigger in wrangler.toml; reads already treat an expired
 * share as missing, so the sweep only reclaims storage.
 */
export async function sweepExpired(db: D1Database, now = Date.now()) {
  const orm = drizzle(db, { schema });
  const expired = orm
    .select({ id: schema.shares.id })
    .from(schema.shares)
    .where(lt(schema.shares.expiresAt, now));

  await orm.batch([
    orm.delete(schema.shareClaims).where(inArray(schema.shareClaims.shareId, expired)),
    orm.delete(schema.shares).where(lt(schema.shares.expiresAt, now)),
    orm.delete(schema.rateLimits).where(lt(schema.rateLimits.expiresAt, now)),
  ]);
}

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Bindings) {
    await sweepExpired(env.DB);
  },
} satisfies ExportedHandler<Bindings>;
