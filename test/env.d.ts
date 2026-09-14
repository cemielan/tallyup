import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import type { Bindings } from '../src/types';

/**
 * `cloudflare:test` types its `env` as `Cloudflare.Env`, so the test
 * bindings are declared by extending that namespace. `Bindings` stays the
 * single definition of what the Worker needs; only the test-only migration
 * list is added here.
 */
declare global {
  namespace Cloudflare {
    interface Env extends Bindings {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
