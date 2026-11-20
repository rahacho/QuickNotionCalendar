import { defineConfig, devices } from '@playwright/test';

/**
 * E2E suite (SPEC §8): the app in LOCAL mode (no Firebase: IndexedDB + BroadcastChannel), time fixed to
 * Thu 2026-11-19 10:00 local by each test (see e2e/fixtures.ts), every test in a fresh browser context
 * (clean IndexedDB/localStorage). Two projects: desktop Chromium and an iPhone 13 (WebKit, touch).
 */
/** Override with PW_PORT=xxxx to run several suites side by side (each starts its own Vite). */
const PORT = Number(process.env.PW_PORT) || 5173;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 7_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
    },
    {
      name: 'iphone-webkit',
      use: { ...devices['iPhone 13'] },
    },
  ],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    // Force LOCAL mode even when a .env with Firebase keys exists (process env wins over .env files).
    env: {
      VITE_FIREBASE_API_KEY: '',
      VITE_FIREBASE_PROJECT_ID: '',
      VITE_VAPID_PUBLIC_KEY: '',
    },
  },
});
