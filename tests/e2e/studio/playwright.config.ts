import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'studio.spec.ts',
  fullyParallel: false,
  timeout: 60_000,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4179' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'cd ../../.. && npx vite build --config apps/studio/vite.config.ts && npm run preview --workspace @dungeon-scrivener/studio -- --port 4179 --strictPort',
    url: 'http://127.0.0.1:4179',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
