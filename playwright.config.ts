import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3124",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run forgeagent -- start --foreground --port 3124 --data-dir .forge-e2e-ui",
    url: "http://127.0.0.1:3124/health",
    timeout: 60_000,
    reuseExistingServer: false,
  },
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "chromium-narrow",
      use: { ...devices["Desktop Chrome"], viewport: { width: 900, height: 760 } },
    },
  ],
});
