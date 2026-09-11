import { defineConfig } from 'drizzle-kit';

// Used only to generate migration SQL from src/schema.ts. Migrations are
// applied by `wrangler d1 migrations apply`, which is what knows how to
// reach the D1 binding -- drizzle-kit never talks to the database here.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './migrations',
});
