import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type * as schema from './schema';

/** Bindings and configuration available to the Worker. */
export interface Bindings {
  DB: D1Database;
  /** Secret. Set via `wrangler secret put JWT_SECRET` / `.dev.vars`. */
  JWT_SECRET: string;
  ENVIRONMENT: string;
  /** Comma-separated allow-list of CORS origins. */
  CORS_ORIGINS: string;
  /** Stringified integer; parsed once per request in the handler that needs it. */
  PBKDF2_ITERATIONS: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
}

/** Values middleware puts on the context for handlers downstream. */
export interface Variables {
  db: DrizzleD1Database<typeof schema>;
  user: AuthenticatedUser;
  /** Set by `requireMembership`; the caller's role in the group being accessed. */
  memberRole: 'owner' | 'member';
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
