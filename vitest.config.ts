import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Vitest's default include glob (`**\/*.{test,spec}.?(c|m)[jt]s?(x)`) collects the
 * Playwright specs under tests/e2e/, which import tests/e2e/helpers.ts — and that
 * module throws at import time when FB_CODE / FB_SECRET are unset. The result was
 * `npm test` exiting 1 having run zero tests, for a reason with no relationship to
 * product behaviour. Pinning include/exclude is what separates the two suites.
 */
export default defineConfig({
  resolve: {
    // Matches tsconfig.json `paths: { "@/*": ["./*"] }` so route handlers, which
    // import via `@/lib/...`, resolve identically under test and under Next.
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**', '.next/**', '.netlify/**'],
    environment: 'node',
    passWithNoTests: false,
    testTimeout: 30_000,
  },
});
