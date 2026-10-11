import { expect, test } from "@playwright/test";

test("opens the seeded shell route at the configured viewport", async ({ page }) => {
  await page.goto("/p/browser-verified-product/new", { waitUntil: "domcontentloaded", timeout: 120_000 });
  await expect(page).toHaveURL(/\/p\/browser-verified-product\/new/);
  await expect(page.locator("body")).not.toBeEmpty();
});
