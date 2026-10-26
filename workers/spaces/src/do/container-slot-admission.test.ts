import { expect, it } from "vitest";
import { SpaceDO } from "./SpaceDO.js";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";

it("enforces the host slot limit during concurrent installs and fails closed without a limit", async () => {
  const storage = createDOStorage();
  const space = new SpaceDO({ storage } as never, {} as never);
  await space.fetch(new Request("http://space/projects/project/container-slots"));
  storage.sql.exec("INSERT INTO projects(id,space_id,name,status) VALUES('project','space','Project','active')");
  const install = (limit?: number) => space.fetch(new Request("http://space/projects/project/container-slots", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ image_id: "approved-image", ...(limit === undefined ? {} : { max_slots: limit }) }),
  }));
  expect((await install()).status).toBe(400);
  const responses = await Promise.all(Array.from({ length: 32 }, () => install(2)));
  expect(responses.filter(response => response.status === 201)).toHaveLength(2);
  expect(responses.filter(response => response.status === 409)).toHaveLength(30);
  const list = await space.fetch(new Request("http://space/projects/project/container-slots"));
  expect(await list.json()).toMatchObject({ count: 2 });
});
