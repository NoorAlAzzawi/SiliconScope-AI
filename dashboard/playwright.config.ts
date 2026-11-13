import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'smoke.spec.ts',
  use: {
    baseURL: 'http://127.0.0.1:5178',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npx vite --port 5178 --host 127.0.0.1 --strictPort',
    port: 5178,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
