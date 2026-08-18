import { defineConfig } from '@playwright/test';

/**
 * TEMPORARY config for validating changes before they deploy.
 *
 * The committed config drives Playwright's own browser builds against the deployed
 * site. That download stalled repeatedly here, so this one uses `channel: 'chrome'`
 * to drive the Google Chrome already installed on the machine, pointed at a local
 * server running the unshipped build.
 *
 * Delete this file once the work is verified. It is not part of the suite.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chrome', use: { channel: 'chrome' } }],
});
