import { defineConfig } from '@playwright/test';
import { ensurePlaywrightRuntimeFresh } from './tests/e2e/helpers/runtime';

ensurePlaywrightRuntimeFresh();

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: {
    timeout: 15_000
  },
  workers: 1,
  webServer: {
    command: 'pwsh -NoLogo -NoProfile -Command "pnpm --filter @flrande/bak-test-sites preview"',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 60_000
  }
});


