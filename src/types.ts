import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type * as schema from './schema';

/**
 * Bindings and configuration available to the Worker. The two secrets guard
 * against abuse only; neither can read user data (docs/05-SECURITY.md §7).
 */
export interface Bindings {
  DB: D1Database;
  ENVIRONMENT: string;
  /**
   * Stop creating shares once the database reaches this size, in MB. It sits
   * below the plan's hard cap (500 MB on D1 Free), so existing events can
   * still be updated, claimed and swept when new ones are refused.
   */
  DB_SOFT_LIMIT_MB: string;
  /** Secret. Cloudflare Turnstile secret key for this site. */
  TURNSTILE_SECRET: string;
  /** Secret. Signs client passes; at least 32 random bytes. */
  PASS_SECRET: string;
}

export type Share = typeof schema.shares.$inferSelect;

/** Values middleware puts on the context for handlers downstream. */
export interface Variables {
  db: DrizzleD1Database<typeof schema>;
  /** Set by `loadShare`; the live (unexpired) share named in the path. */
  share: Share;
  /** Set by `requirePass`; the id of the verified client pass. */
  passId: string;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
