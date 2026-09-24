import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './browser', testMatch: '**/*.spec.ts', fullyParallel: true, retries: 0, reporter: 'list',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', ...devices['Desktop Chrome'] },
  webServer: { command: 'npx vite --config vite.config.ts', url: 'http://127.0.0.1:4181', reuseExistingServer: !process.env.CI, timeout: 30_000 },
});
