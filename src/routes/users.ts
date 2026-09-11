import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { errors } from '../errors';
import * as schema from '../schema';
import type { AppEnv } from '../types';
import { parseBody, updateMeSchema } from '../validation';

const users = new Hono<AppEnv>();

// Read the row rather than trust the token's claims: a display name changed
// in another session should be visible here immediately, not after the
// current access token expires.
users.get('/me', async (c) => {
  const user = await c
    .get('db')
    .select({
      id: schema.users.id,
      email: schema.users.email,
      displayName: schema.users.displayName,
      createdAt: schema.users.createdAt,
    })
    .from(schema.users)
    .where(eq(schema.users.id, c.get('user').id))
    .get();

  if (!user) throw errors.notFound('User');
  return c.json(user);
});

users.patch('/me', async (c) => {
  const { displayName } = await parseBody(c, updateMeSchema);

  const [updated] = await c
    .get('db')
    .update(schema.users)
    .set({ displayName })
    .where(eq(schema.users.id, c.get('user').id))
    .returning({
      id: schema.users.id,
      email: schema.users.email,
      displayName: schema.users.displayName,
    });

  if (!updated) throw errors.notFound('User');
  return c.json(updated);
});

export default users;
