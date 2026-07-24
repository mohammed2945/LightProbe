import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4174",
    channel: "chrome",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "HOSTNAME=127.0.0.1 PORT=4174 npm run start",
    url: "http://127.0.0.1:4174/docs/quickstart",
    reuseExistingServer: true,
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
    {
      name: "mobile",
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium",
        channel: "chrome",
      },
    },
  ],
});
