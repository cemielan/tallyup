import { and, count, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { newEditToken, newShareId, sha256Hex } from '../crypto';
import { ApiError, errors } from '../errors';
import { RATE_LIMITS, loadShare, rateLimit, requireEditToken } from '../middleware';
import * as schema from '../schema';
import type { AppEnv } from '../types';
import {
  MAX_CLAIMS_PER_SHARE,
  claimIdSchema,
  createClaimSchema,
  createShareSchema,
  parse,
  parseBody,
  updateShareSchema,
} from '../validation';

/** A share lives this long after its last update (docs/01-REQUIREMENTS.md FR-106). */
export const SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const iso = (ms: number) => new Date(ms).toISOString();

const shares = new Hono<AppEnv>();

shares.post('/', rateLimit(RATE_LIMITS.create), async (c) => {
  const body = await parseBody(c, createShareSchema);
  const id = newShareId();
  const editToken = newEditToken();
  const now = Date.now();
  const expiresAt = now + SHARE_TTL_MS;

  await c
    .get('db')
    .insert(schema.shares)
    .values({
      id,
      ciphertext: body.ciphertext,
      iv: body.iv,
      editTokenHash: await sha256Hex(editToken),
      version: 1,
      createdAt: now,
      updatedAt: now,
      expiresAt,
    });

  // The only time the edit token ever leaves the server. Only its hash is kept.
  return c.json({ id, editToken, version: 1, expiresAt: iso(expiresAt) }, 201);
});

shares.use('/:shareId', loadShare);
shares.use('/:shareId/*', loadShare);

shares.get('/:shareId', (c) => {
  const share = c.get('share');
  return c.json({
    id: share.id,
    ciphertext: share.ciphertext,
    iv: share.iv,
    version: share.version,
    updatedAt: iso(share.updatedAt),
    expiresAt: iso(share.expiresAt),
  });
});

shares.put('/:shareId', requireEditToken, async (c) => {
  const body = await parseBody(c, updateShareSchema);
  const share = c.get('share');
  const now = Date.now();

  // Compare-and-swap in one statement: two devices saving at once cannot
  // both win, and neither silently erases the other's change.
  const [updated] = await c
    .get('db')
    .update(schema.shares)
    .set({
      ciphertext: body.ciphertext,
      iv: body.iv,
      version: sql`${schema.shares.version} + 1`,
      updatedAt: now,
      expiresAt: now + SHARE_TTL_MS,
    })
    .where(and(eq(schema.shares.id, share.id), eq(schema.shares.version, body.version)))
    .returning({ version: schema.shares.version, expiresAt: schema.shares.expiresAt });

  if (!updated) {
    throw new ApiError('VERSION_CONFLICT', 'This event was changed elsewhere. Reload it first.', {
      details: { currentVersion: share.version },
    });
  }

  return c.json({ version: updated.version, expiresAt: iso(updated.expiresAt) });
});

shares.delete('/:shareId', requireEditToken, async (c) => {
  const db = c.get('db');
  const id = c.get('share').id;

  // Claims first: they reference the share.
  await db.batch([
    db.delete(schema.shareClaims).where(eq(schema.shareClaims.shareId, id)),
    db.delete(schema.shares).where(eq(schema.shares.id, id)),
  ]);

  return c.body(null, 204);
});

shares.get('/:shareId/claims', async (c) => {
  const rows = await c
    .get('db')
    .select({
      id: schema.shareClaims.id,
      ciphertext: schema.shareClaims.ciphertext,
      iv: schema.shareClaims.iv,
      createdAt: schema.shareClaims.createdAt,
    })
    .from(schema.shareClaims)
    .where(eq(schema.shareClaims.shareId, c.get('share').id))
    .orderBy(schema.shareClaims.createdAt);

  // Bounded by MAX_CLAIMS_PER_SHARE, so no pagination is needed.
  return c.json({ claims: rows.map((row) => ({ ...row, createdAt: iso(row.createdAt) })) });
});

shares.post('/:shareId/claims', rateLimit(RATE_LIMITS.claim), async (c) => {
  const body = await parseBody(c, createClaimSchema);
  const db = c.get('db');
  const shareId = c.get('share').id;

  const [pending] = await db
    .select({ value: count() })
    .from(schema.shareClaims)
    .where(eq(schema.shareClaims.shareId, shareId));

  if ((pending?.value ?? 0) >= MAX_CLAIMS_PER_SHARE) {
    throw new ApiError('CLAIM_LIMIT', 'This event has too many unanswered payment claims');
  }

  const id = newShareId();
  const createdAt = Date.now();
  await db
    .insert(schema.shareClaims)
    .values({ id, shareId, ciphertext: body.ciphertext, iv: body.iv, createdAt });

  return c.json({ id, createdAt: iso(createdAt) }, 201);
});

shares.delete('/:shareId/claims/:claimId', requireEditToken, async (c) => {
  const claimId = parse(claimIdSchema, c.req.param('claimId'));
  const [deleted] = await c
    .get('db')
    .delete(schema.shareClaims)
    .where(
      and(eq(schema.shareClaims.id, claimId), eq(schema.shareClaims.shareId, c.get('share').id)),
    )
    .returning({ id: schema.shareClaims.id });

  if (!deleted) throw errors.notFound('Claim');
  return c.body(null, 204);
});

export default shares;
