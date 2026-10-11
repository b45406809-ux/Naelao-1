import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./plan/browser",
  testMatch: "**/*.spec.ts",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "line",
  use: {
    baseURL: process.env.NAELAO_SHELL_URL ?? "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    launchOptions: {
      executablePath: process.env.NAELAO_BROWSER_EXECUTABLE ?? (process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : undefined),
    },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-338", use: { ...devices["Desktop Chrome"], viewport: { width: 338, height: 646 }, isMobile: false } },
    { name: "mobile-740", use: { ...devices["Desktop Chrome"], viewport: { width: 740, height: 646 }, isMobile: false } },
  ],
});
