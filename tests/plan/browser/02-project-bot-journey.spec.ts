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
  const userSpace = await createSpaceResponse.json() as { id: string; name: string; status: string };
  expect(userSpace.id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(userSpace.status).toBe("active");
  await page.waitForURL(/\/p\/launchpad-e2e\/new$/);
  await expect(page).toHaveURL(/\/p\/launchpad-e2e\/new$/);

  const memberships = await page.request.get(`http://127.0.0.1:8788/v1/spaces/${userSpace.id}/memberships`, { headers: sessionHeaders });
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
    response.request().method() === "POST" && response.url().endsWith(`/v1/spaces/${userSpace.id}/projects`));
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const createProjectResponse = await createProjectResponsePromise;
  expect(createProjectResponse.ok()).toBeTruthy();
  const createdProject = await createProjectResponse.json() as { id: string; name: string };
  const projectId = createdProject.id;
  expect(projectId).toMatch(/^[0-9a-f-]{36}$/i);

  // The local no-queue runtime initializes the Space hierarchy on the first authorized create.
  const createSubspace = await page.request.post(`http://127.0.0.1:8788/v1/spaces/${userSpace.id}/sub-spaces`, {
    headers: sessionHeaders, data: { name: "Research", space_type: "untrusted-type" },
  });
  expect(createSubspace.status()).toBe(201);
  const subspace = await createSubspace.json() as { id: string; parent_id: string; space_type: string };
  expect(subspace).toMatchObject({ parent_id: userSpace.id, space_type: "launchpad" });
  const linkSubspace = await page.request.post(`http://127.0.0.1:8788/v1/spaces/${userSpace.id}/projects/${projectId}/sub-spaces`, {
    headers: sessionHeaders, data: { subspace_id: subspace.id },
  });
  expect(linkSubspace.ok()).toBeTruthy();
  const subspaces = await page.request.get(`http://127.0.0.1:8788/v1/spaces/${userSpace.id}/projects/${projectId}/sub-spaces`, { headers: sessionHeaders });
  expect(subspaces.status()).toBe(200);
  expect(await subspaces.json()).toMatchObject({ data: expect.arrayContaining([expect.objectContaining({ id: subspace.id })]) });

  const outsiderSignup = await page.request.post("http://127.0.0.1:8788/v1/spaces/space-bot-e2e/end-users/signup", {
    data: { email: `outsider-${testInfo.project.name}-${crypto.randomUUID()}@example.test`, password: "browser-test-password" },
  });
  expect(outsiderSignup.status()).toBe(201);
  const outsider = await outsiderSignup.json() as { end_user_id: string; session_token: string };
  const outsiderRequest = await page.request.get(`http://127.0.0.1:8788/v1/spaces/${userSpace.id}/sub-spaces`, {
    headers: { authorization: `Bearer ${outsider.session_token}`, "x-naelao-end-user-id": outsider.end_user_id },
  });
  expect(outsiderRequest.status()).toBe(403);
  const suspension = await page.request.post("http://127.0.0.1:8788/__test/browser/suspend-product-user", {
    data: { endUserId: outsider.end_user_id },
  });
  expect(await suspension.json()).toEqual({ suspended: true });
  const suspendedSession = await page.request.get("http://127.0.0.1:8788/v1/spaces/space-bot-e2e/my-spaces", {
    headers: { authorization: `Bearer ${outsider.session_token}`, "x-naelao-end-user-id": outsider.end_user_id },
  });
  expect(suspendedSession.status()).toBe(401);

  const projectsResponse = page.waitForResponse(response =>
    response.request().method() === "GET" && new URL(response.url()).pathname.endsWith(`/v1/spaces/${userSpace.id}/projects`) &&
    new URL(response.url()).searchParams.get("include_subspaces") === "1");
  await page.goto("/p/launchpad-e2e/bots");
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
      request.url().endsWith(`/v1/spaces/${userSpace.id}/threads`)
  );
  const createdThreadResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" &&
      response.url().endsWith(`/v1/spaces/${userSpace.id}/threads`)
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
    `http://127.0.0.1:8788/v1/spaces/${userSpace.id}/threads/${createdThread.id}`,
    { headers: sessionHeaders },
  );
  expect(persistedResponse.status()).toBe(200);
  expect(await persistedResponse.json()).toMatchObject({ id: createdThread.id, project_id: projectId });
  await expect(page).toHaveURL(new RegExp(`/p/launchpad-e2e/threads/${createdThread.id}$`));

  const revoke = await page.request.post("http://127.0.0.1:8788/__test/browser/suspend-space-member", {
    data: { spaceId: userSpace.id, endUserId: session.end_user_id },
  });
  expect(await revoke.json()).toEqual({ suspended: true });
  const afterRevocation = await page.request.get("http://127.0.0.1:8788/v1/spaces/space-bot-e2e/my-spaces", { headers: sessionHeaders });
  expect(await afterRevocation.json()).toMatchObject({ data: [] });
  const deniedAfterRevocation = await page.request.get(`http://127.0.0.1:8788/v1/spaces/${userSpace.id}/projects`, { headers: sessionHeaders });
  expect(deniedAfterRevocation.status()).toBe(403);
});
