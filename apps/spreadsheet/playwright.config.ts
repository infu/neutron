import { defineConfig, devices } from "@playwright/test";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const args = process.env.PLAYWRIGHT_CHROMIUM_ARGS?.split(/\s+/).filter(Boolean) ?? [];

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: process.env.CI ? [["html"], ["list"]] : "list",
  use: {
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  projects: [{
    name: "chromium",
    use: {
      ...devices["Desktop Chrome"],
      ...((executablePath || args.length) ? { launchOptions: { ...(executablePath ? { executablePath } : {}), ...(args.length ? { args } : {}) } } : {}),
    },
  }],
});
