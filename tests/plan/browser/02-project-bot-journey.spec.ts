import { expect, test } from "@playwright/test";

test("opens an internal Project Bot and creates a project-scoped thread", async ({
  page,
}, testInfo) => {
  const endUserId = `owner-e2e-${testInfo.project.name}`;
  await page.request.post("http://127.0.0.1:8787/__reset", {
    data: { user_id: endUserId },
  });
  const beforeCreate = await page.request.get(
    "http://127.0.0.1:8787/v1/spaces/space-bot-e2e/threads/thread-project-bot-e2e"
  );
  expect(beforeCreate.status()).toBe(404);
  await page.addInitScript(
    ({ spaceId, endUserId }) => {
      localStorage.setItem(
        `naelao_product_session:${spaceId}`,
        JSON.stringify({
          end_user_id: endUserId,
          session_token: "test-only-session",
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        })
      );
    },
    { spaceId: "space-bot-e2e", endUserId }
  );

  await page.goto("/p/launchpad-e2e/bots", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Project Bots", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Internal Project Bot · Project scoped")
  ).toBeVisible();
  await expect(
    page.getByText(
      "Project Bots use the same planner and worker system as the Space Assistant, scoped to one project."
    )
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Talk to Project Bot" })
  ).toBeVisible();

  const createRequest = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().endsWith(`/v1/spaces/space-bot-e2e/threads`)
  );
  const persistedThreadResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().endsWith(
        "/v1/spaces/space-bot-e2e/threads/thread-project-bot-e2e"
      )
  );
  await page.getByRole("button", { name: "Talk to Project Bot" }).click();
  const request = await createRequest;
  expect(request.postDataJSON()).toMatchObject({
    project_id: "project-logistics-e2e",
    title: "Project Bot",
  });
  const persistedResponse = await persistedThreadResponse;
  expect(persistedResponse.status()).toBe(200);
  await expect
    .poll(async () => (await persistedResponse.json()).project_id)
    .toBe("project-logistics-e2e");
  await expect(page).toHaveURL(
    /\/p\/launchpad-e2e\/threads\/thread-project-bot-e2e/
  );
});
