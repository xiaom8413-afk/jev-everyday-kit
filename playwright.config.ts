import { defineConfig } from '@playwright/test';
import { executablePath } from './tests/e2e/browser-path';
export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false, workers: 1, timeout: 40000, retries: 0,
  reporter: 'list', outputDir: 'test-results',
  use: { headless: true, launchOptions: { executablePath: executablePath() }, viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
