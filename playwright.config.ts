import { defineConfig, devices } from "@playwright/test";

const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const chromiumArgs = [
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  ...(process.env.PLAYWRIGHT_CHROMIUM_ARGS?.split(/\s+/).filter(Boolean) ?? []),
];
const chromiumLaunchOptions =
  chromiumExecutablePath || chromiumArgs.length > 0
    ? {
        ...(chromiumExecutablePath
          ? { executablePath: chromiumExecutablePath }
          : {}),
        ...(chromiumArgs.length > 0 ? { args: chromiumArgs } : {}),
      }
    : undefined;

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 120_000,
  expect: {
    timeout: 20_000,
  },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["html"], ["list"]] : "list",
  use: {
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(chromiumLaunchOptions
          ? { launchOptions: chromiumLaunchOptions }
          : {}),
      },
    },
  ],
});
