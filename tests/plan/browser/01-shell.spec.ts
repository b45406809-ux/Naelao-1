import { expect, test } from "@playwright/test";

test("loads the authenticated seeded Shell instead of a fallback 404", async ({
  page,
}) => {
  await page.addInitScript(
    ({ spaceId }) => {
      localStorage.setItem(
        `naelao_product_session:${spaceId}`,
        JSON.stringify({
          end_user_id: "owner-e2e",
          session_token: "test-only-session",
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        })
      );
    },
    { spaceId: "space-bot-e2e" }
  );

  await page.goto("/p/launchpad-e2e/bots", {
    waitUntil: "domcontentloaded",
    timeout: 120_000,
  });
  await expect(page).toHaveURL(/\/p\/launchpad-e2e\/bots/);
  await expect(page.getByText("Project Bots", { exact: true })).toBeVisible();
  await expect(
    page.locator("#main").getByText("Logistics Project", { exact: true })
  ).toBeVisible();
});
