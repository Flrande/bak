import { defineConfig } from '@playwright/test';
import { ensurePlaywrightRuntimeFresh } from './tests/e2e/helpers/runtime';

ensurePlaywrightRuntimeFresh();

const testSitePort = Number(process.env.BAK_TEST_SITE_PORT ?? '4173');
const resolvedTestSitePort = Number.isFinite(testSitePort) && testSitePort > 0 ? Math.floor(testSitePort) : 4173;
const testSiteOrigin = process.env.BAK_TEST_SITE_ORIGIN ?? `http://127.0.0.1:${resolvedTestSitePort}`;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: {
    timeout: 15_000
  },
  workers: 1,
  webServer: {
    command: `pwsh -NoLogo -NoProfile -Command "pnpm --filter @flrande/bak-test-sites exec vite preview --host 127.0.0.1 --port ${resolvedTestSitePort}"`,
    url: testSiteOrigin,
    reuseExistingServer: false,
    timeout: 60_000
  }
});


