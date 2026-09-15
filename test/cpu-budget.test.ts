import { describe, expect, it } from 'vitest';
import { DEFAULT_PBKDF2_ITERATIONS, hashPassword, verifyPassword } from '../src/crypto';

/**
 * The CPU-budget tests that docs/05-SECURITY.md §2 and NFR-202 require.
 *
 * These run inside the real Workers runtime, so the numbers come from the
 * same engine production uses rather than from a Node approximation. They
 * are not microbenchmarks chasing a precise figure -- they are regression
 * guards: if someone raises the iteration count, this suite fails instead of
 * production returning Error 1102 on every login.
 *
 * The budget below is the documented Workers Free plan per-request CPU
 * limit, verified against Cloudflare's limits page. It is Cloudflare's to
 * change, so re-verify rather than trusting this constant (Project Brief,
 * ground rule 5).
 */
const CPU_BUDGET_MS = 10;

/**
 * Password hashing gets a deliberately generous share of the budget: it is
 * the single most expensive thing any request does, and a login does nothing
 * else of consequence. The rest covers request parsing, the JWT signature,
 * and serialising a couple of D1 queries.
 */
const HASH_BUDGET_MS = 7;

/**
 * The runtime's clock has roughly 1ms granularity, so timing one sub-10ms
 * operation rounds to a whole number and hides the shape of the curve.
 * Timing a batch and dividing recovers the resolution.
 */
async function timeOf(action: () => Promise<unknown>, batch = 8): Promise<number> {
  const started = performance.now();
  for (let i = 0; i < batch; i += 1) await action();
  return (performance.now() - started) / batch;
}

/** Median of several runs, so one scheduling hiccup cannot fail the suite. */
async function medianMs(action: () => Promise<unknown>, runs = 9): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) samples.push(await timeOf(action));
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

describe('password hashing CPU cost', () => {
  it('reports the cost curve across iteration counts', { timeout: 120_000 }, async () => {
    const counts = [DEFAULT_PBKDF2_ITERATIONS, 10_000, 50_000, 100_000];
    const measured: Array<[number, number]> = [];

    for (const iterations of counts) {
      measured.push([
        iterations,
        await medianMs(() => hashPassword('a-long-enough-passphrase-42', iterations), 5),
      ]);
    }

    // Printed so the constant in src/crypto.ts can be re-derived on any
    // machine rather than taken on faith from a comment.
    console.log(
      '\nPBKDF2-SHA256 median cost (Workers runtime):\n' +
        measured
          .map(([n, ms]) => `  ${String(n).padStart(7)} iterations  ${ms.toFixed(2)} ms`)
          .join('\n') +
        `\n  budget: ${HASH_BUDGET_MS} ms of a ${CPU_BUDGET_MS} ms request\n`,
    );

    // Cost must rise with work, or the measurement is measuring nothing.
    expect(measured.at(-1)![1]).toBeGreaterThan(measured[0][1]);
  });

  // Deliberately tests the shipped constant rather than `env.PBKDF2_ITERATIONS`:
  // the test environment overrides that to a trivial value, so asserting
  // against the override would pass however expensive production became.
  it('ships an iteration count that fits the budget', { timeout: 120_000 }, async () => {
    const elapsed = await medianMs(() =>
      hashPassword('a-long-enough-passphrase-42', DEFAULT_PBKDF2_ITERATIONS),
    );
    console.log(
      `\nShipped default ${DEFAULT_PBKDF2_ITERATIONS} iterations: ${elapsed.toFixed(2)} ms median\n`,
    );

    expect(
      elapsed,
      `Hashing at the shipped ${DEFAULT_PBKDF2_ITERATIONS} iterations costs ${elapsed.toFixed(2)}ms, ` +
        `over the ${HASH_BUDGET_MS}ms budget, which means Error 1102 on every login. Lower ` +
        'DEFAULT_PBKDF2_ITERATIONS in src/crypto.ts, or raise the budget deliberately after ' +
        're-checking the platform CPU limit.',
    ).toBeLessThan(HASH_BUDGET_MS);
  });

  it(
    'verifies at the cost it hashes, so a login is no cheaper to attack than to use',
    { timeout: 120_000 },
    async () => {
      const stored = await hashPassword('a-long-enough-passphrase-42', DEFAULT_PBKDF2_ITERATIONS);
      const verifying = await medianMs(() => verifyPassword('a-long-enough-passphrase-42', stored));
      expect(verifying).toBeLessThan(HASH_BUDGET_MS);
    },
  );

  it('rejects a wrong password, a malformed hash, and a tampered one', async () => {
    const stored = await hashPassword('a-long-enough-passphrase-42', 1_000);

    expect(await verifyPassword('a-long-enough-passphrase-42', stored)).toBe(true);
    expect(await verifyPassword('a-different-passphrase-99', stored)).toBe(false);
    expect(await verifyPassword('a-long-enough-passphrase-42', 'garbage')).toBe(false);
    expect(await verifyPassword('a-long-enough-passphrase-42', `${stored.slice(0, -4)}AAAA`)).toBe(
      false,
    );
  });

  it('verifies an old hash at its own recorded iteration count', async () => {
    // Raising the shipped count must not lock out anyone who registered
    // under the old one, which is why the count is stored per hash.
    const legacy = await hashPassword('a-long-enough-passphrase-42', 1_200);
    expect(legacy.startsWith('pbkdf2-sha256$1200$')).toBe(true);
    expect(await verifyPassword('a-long-enough-passphrase-42', legacy)).toBe(true);
  });
});
