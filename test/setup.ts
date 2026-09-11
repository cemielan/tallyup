import { applyD1Migrations, env } from 'cloudflare:test';

// Each test file gets isolated storage, so the schema is applied here rather
// than assumed to exist.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
