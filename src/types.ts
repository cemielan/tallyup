import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type * as schema from './schema';

/** Bindings and configuration available to the Worker. No secrets: the server holds none. */
export interface Bindings {
  DB: D1Database;
  ENVIRONMENT: string;
}

export type Share = typeof schema.shares.$inferSelect;

/** Values middleware puts on the context for handlers downstream. */
export interface Variables {
  db: DrizzleD1Database<typeof schema>;
  /** Set by `loadShare`; the live (unexpired) share named in the path. */
  share: Share;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
