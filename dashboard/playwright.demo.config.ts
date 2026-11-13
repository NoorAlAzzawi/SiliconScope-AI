import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'demo.spec.ts',
  use: {
    baseURL: 'http://127.0.0.1:5180',
  },
  projects: [
    {
      name: 'chromium-demo',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npx vite --mode demo --port 5180 --host 127.0.0.1 --strictPort',
    port: 5180,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
