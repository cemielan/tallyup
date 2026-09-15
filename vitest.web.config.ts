import { defineConfig } from 'vitest/config';

/**
 * The web client's pure logic runs under plain Node, not the Workers pool:
 * it is browser code, and the parts worth testing automatically (money
 * conversion and share allocation) touch no DOM.
 *
 * Rendering is deliberately not covered here. Asserting on a simulated DOM
 * would mostly test the simulation; the views are exercised by driving the
 * real app in a browser instead, which is recorded as a known gap in
 * docs/07-ROADMAP.md rather than papered over.
 */
export default defineConfig({
  test: {
    name: 'web',
    environment: 'node',
    include: ['test/web/**/*.test.ts'],
  },
});
