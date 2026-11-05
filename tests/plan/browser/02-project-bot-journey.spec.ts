import { expect, test } from "@playwright/test";

test("opens an internal Project Bot and creates a project-scoped thread", async ({
  page,
}, testInfo) => {
  const signup = await page.request.post("http://127.0.0.1:8788/v1/spaces/space-bot-e2e/end-users/signup", {
    data: { email: `project-bot-${testInfo.project.name}-${crypto.randomUUID()}@example.test`, password: "browser-test-password", display_name: "Project Bot Test Member" },
  });
  expect(signup.status()).toBe(201);
  const session = await signup.json() as { end_user_id: string; session_token: string; expires_at: string };
  expect(session.end_user_id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(session.session_token).toMatch(/^nps_/);
  const sessionHeaders = {
    authorization: `Bearer ${session.session_token}`,
    "x-naelao-end-user-id": session.end_user_id,
  };
  const rootDenied = await page.request.get(
    "http://127.0.0.1:8788/v1/spaces/space-bot-e2e/projects",
    { headers: sessionHeaders },
  );
  expect(rootDenied.status()).toBe(403);
  await page.addInitScript(
    ({ spaceId, session }) => {
      localStorage.setItem(
        `naelao_product_session:${spaceId}`,
        JSON.stringify(session)
      );
    },
    { spaceId: "space-bot-e2e", session }
  );

  await page.goto("/p/launchpad-e2e/bots", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/p\/launchpad-e2e\/spaces$/);
  await page.getByRole("button", { name: "New Space" }).click();
  await page.getByPlaceholder("What is this Space for?").fill("Browser Project Bot Workspace");
  const createSpaceResponsePromise = page.waitForResponse(response =>
    response.request().method() === "POST" && response.url().endsWith("/v1/spaces/space-bot-e2e/spaces"));
  await page.getByRole("button", { name: "Create Space" }).click();
  const createSpaceResponse = await createSpaceResponsePromise;
  expect(createSpaceResponse.status()).toBe(201);
  const childSpace = await createSpaceResponse.json() as { id: string; name: string; status: string };
  expect(childSpace.id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(childSpace.status).toBe("active");
  await page.waitForURL(/\/p\/launchpad-e2e\/new$/);
  await expect(page).toHaveURL(/\/p\/launchpad-e2e\/new$/);

  const memberships = await page.request.get(`http://127.0.0.1:8788/v1/spaces/${childSpace.id}/memberships`, { headers: sessionHeaders });
  expect(memberships.status()).toBe(200);
  expect(await memberships.json()).toMatchObject({ data: [{ end_user_id: session.end_user_id, role: "owner" }] });
  const platformRoster = await page.request.post("http://127.0.0.1:8788/__test/browser/platform-roster-check", {
    data: { endUserId: session.end_user_id },
  });
  expect(await platformRoster.json()).toMatchObject({ is_platform_collaborator: false });

  await page.goto("/p/launchpad-e2e/projects/all");
  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByRole("textbox", { name: "Project name" }).fill("Logistics Project");
  const createProjectResponsePromise = page.waitForResponse(response =>
    response.request().method() === "POST" && response.url().endsWith(`/v1/spaces/${childSpace.id}/projects`));
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const createProjectResponse = await createProjectResponsePromise;
  expect(createProjectResponse.ok()).toBeTruthy();
  const createdProject = await createProjectResponse.json() as { id: string; name: string };
  const projectId = createdProject.id;
  expect(projectId).toMatch(/^[0-9a-f-]{36}$/i);

  await page.goto("/p/launchpad-e2e/bots");
  const projectsResponse = page.waitForResponse(response =>
    response.request().method() === "GET" && response.url().endsWith(`/v1/spaces/${childSpace.id}/projects`));
  await expect(page.getByText("Project Bots", { exact: true })).toBeVisible();
  const projects = await (await projectsResponse).json() as { data: Array<{ id: string }> };
  expect(projects.data.map(item => item.id)).toContain(projectId);
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
      request.url().endsWith(`/v1/spaces/${childSpace.id}/threads`)
  );
  const createdThreadResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" &&
      response.url().endsWith(`/v1/spaces/${childSpace.id}/threads`)
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
    `http://127.0.0.1:8788/v1/spaces/${childSpace.id}/threads/${createdThread.id}`,
    { headers: sessionHeaders },
  );
  expect(persistedResponse.status()).toBe(200);
  expect(await persistedResponse.json()).toMatchObject({ id: createdThread.id, project_id: projectId });
  await expect(page).toHaveURL(new RegExp(`/p/launchpad-e2e/threads/${createdThread.id}$`));
});
