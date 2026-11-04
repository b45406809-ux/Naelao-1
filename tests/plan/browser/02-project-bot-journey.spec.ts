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
  const projectsResponse = page.waitForResponse(
    (response) => response.request().method() === "GET" &&
      response.url().endsWith("/v1/spaces/space-bot-e2e/projects")
  );
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
  const projects = await (await projectsResponse).json();
  const projectId = projects.data[0].id as string;
  expect(projectId).toMatch(/^[0-9a-f-]{36}$/i);
  await expect(page.getByText("Project Bots", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Internal Project Bot · Project scoped")
  ).toBeVisible();
  await expect(
    page.getByText(
      "Project Bots use the same planner and worker system as the Space Assistant, scoped to one project."
    )
  ).toBeVisible();
  const createButton = page.getByRole("button", {
    name: /^(Talk to Project Bot|New thread)$/,
  });
  await expect(createButton).toBeVisible();

  const createRequest = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().endsWith(`/v1/spaces/space-bot-e2e/threads`)
  );
  const createdThreadResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" &&
      response.url().endsWith("/v1/spaces/space-bot-e2e/threads")
  );
  await createButton.click();
  const request = await createRequest;
  expect(request.postDataJSON()).toMatchObject({
    project_id: projectId,
    title: "Project Bot",
  });
  const createdResponse = await createdThreadResponse;
  expect(createdResponse.ok()).toBeTruthy();
  const createdThread = await createdResponse.json();
  expect(createdThread.project_id).toBe(projectId);
  const persistedResponse = await page.request.get(
    `http://127.0.0.1:8787/v1/spaces/space-bot-e2e/threads/${createdThread.id}`
  );
  expect(persistedResponse.status()).toBe(200);
  expect(await persistedResponse.json()).toMatchObject({ id: createdThread.id, project_id: projectId });
  await expect(page).toHaveURL(new RegExp(`/p/launchpad-e2e/threads/${createdThread.id}$`));
});
