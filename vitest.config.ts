import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Tests run inside the real Workers runtime rather than a Node
// approximation, so a missing Workers API or a WebCrypto difference fails
// here instead of in production (docs/02-ARCHITECTURE.md §1).
const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        // Local-only test values. The real secret comes from
        // `wrangler secret put` and never appears in the repo.
        bindings: {
          JWT_SECRET: 'test-only-secret-not-used-anywhere-else-0123456789',
          ENVIRONMENT: 'test',
          CORS_ORIGINS: 'http://localhost:5173',
          // Deliberately low so the suite is not dominated by key
          // derivation; production uses the wrangler.toml value.
          PBKDF2_ITERATIONS: '1000',
          // The real migration files, so the schema under test is the schema
          // that ships -- not a second definition kept in sync by hand.
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/setup.ts'],
    coverage: {
      // Istanbul, not V8: the Workers pool runs tests inside workerd, where
      // V8 coverage is not exposed to the host.
      provider: 'istanbul',
      reporter: ['text-summary', 'html', 'lcov'],
      include: ['src/**/*.ts', 'packages/*/src/**/*.ts'],
      // NFR-501 applies to the service/domain layer, not to thin HTTP glue,
      // so route handlers and the generated OpenAPI document are excluded
      // and the threshold below is measured against real logic.
      exclude: ['src/routes/**', 'src/openapi.ts', 'src/types.ts', 'src/index.ts'],
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
    },
  },
});
