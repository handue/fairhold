import { defineConfig, devices } from "@playwright/test";

// Set PLAYWRIGHT_BASE_URL to run the suite against a deployed URL instead of a local server.
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
const isLocal = new URL(baseURL).hostname === "localhost";
const viewport = { width: 1440, height: 900 };

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    viewport,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      // The device preset brings its own 1280x720 viewport, so restate ours after it. The
      // installed Google Chrome (also on GitHub's runners) means no browser download.
      use: { ...devices["Desktop Chrome"], viewport, channel: "chrome" },
    },
  ],
  webServer: isLocal
    ? {
        command: "npm run dev",
        url: `${baseURL}/api/healthz`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      }
    : undefined,
});
