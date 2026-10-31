import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const repoRoot = path.resolve(
  process.cwd().endsWith(`${path.sep}tests`) ? ".." : process.cwd()
);

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
      executablePath:
        process.env.NAELAO_BROWSER_EXECUTABLE ??
        (process.platform === "win32"
          ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
          : undefined),
    },
  },
  webServer: [
    {
      command: "node tests/plan/support/assistant-journey-api.mjs",
      cwd: repoRoot,
      url: "http://127.0.0.1:8787/__health",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command:
        "NEXT_PUBLIC_API_URL=http://127.0.0.1:8787 ./node_modules/.bin/next dev -p 3100",
      cwd: path.join(repoRoot, "apps", "shell"),
      url: "http://127.0.0.1:3100",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile-338",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 338, height: 646 },
        isMobile: false,
      },
    },
    {
      name: "mobile-740",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 740, height: 646 },
        isMobile: false,
      },
    },
  ],
});
