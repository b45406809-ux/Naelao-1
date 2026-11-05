import { expect, test } from "@playwright/test";

test("signs in to the Product and opens the end-user Space picker", async ({ page }, testInfo) => {
  const email = `shell-${testInfo.project.name}-${crypto.randomUUID()}@example.test`;
  const password = "browser-test-password";
  const signup = await page.request.post("http://127.0.0.1:8788/v1/spaces/space-bot-e2e/end-users/signup", {
    data: { email, password, display_name: "Shell Test User" },
  });
  expect(signup.status()).toBe(201);

  await page.goto("/p/launchpad-e2e/login", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Sign in to continue")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled({ timeout: 30_000 });
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/p\/launchpad-e2e\/spaces$/);
  await expect(page.getByRole("button", { name: "New Space" })).toBeVisible();
});
