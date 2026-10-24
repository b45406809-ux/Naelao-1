import {
  FOUNDRY_SPACE_TEMPLATE,
  PERSONAL_ASSISTANT_SPACE_TEMPLATE,
  SOFTWARE_DEVELOPMENT_SPACE_TEMPLATE,
} from "@naelao/agent-sdk";
import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { SpaceDO } from "./SpaceDO.js";

describe("reference Space Templates on fresh Space scopes", () => {
  it("instantiates Foundry, Personal Assistant and Software Development without sharing project state", async () => {
    const storage = createDOStorage(),
      space = new SpaceDO({ storage } as never, {} as never);
    const initialized = await space.fetch(
      new Request(
        "http://space/container-installations?tenant_id=tenant&space_id=template-test&user_id=owner&project_id="
      )
    );
    expect(initialized.ok).toBe(true);
    const templates = [
      FOUNDRY_SPACE_TEMPLATE,
      PERSONAL_ASSISTANT_SPACE_TEMPLATE,
      SOFTWARE_DEVELOPMENT_SPACE_TEMPLATE,
    ];
    const install = (blueprint: (typeof templates)[number], spaceIndex: number) => space.fetch(
      new Request("http://space/blueprints/instantiate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ blueprint, target_space_id: `fresh-space-${spaceIndex}`, activation_key: blueprint.id }),
      })
    );
    const results = await Promise.all(
      templates.map((blueprint, index) =>
        install(blueprint, index)
      )
    );
    expect(results.map((result) => result.status)).toEqual([201, 201, 201]);
    const retries = await Promise.all(templates.map((blueprint, index) => install(blueprint, index)));
    expect(retries.map(result => result.status)).toEqual([200, 200, 200]);
    const projects = storage.sql
      .exec(
        "SELECT id,space_id,name,kind,template_mode FROM projects WHERE space_id IN ('fresh-space-0','fresh-space-1','fresh-space-2') ORDER BY space_id"
      )
      .toArray();
    expect(projects).toHaveLength(3);
    expect(projects.map((row) => row.kind)).toEqual([
      "TerminalFirst",
      "DualPane",
      "TerminalFirst",
    ]);
    expect(new Set(projects.map((row) => row.id)).size).toBe(3);
    expect(new Set(projects.map((row) => row.space_id)).size).toBe(3);
    const tasks = storage.sql
      .exec(
        "SELECT space_id,COUNT(*) AS total FROM tasks WHERE space_id IN ('fresh-space-0','fresh-space-1','fresh-space-2') GROUP BY space_id ORDER BY space_id"
      )
      .toArray();
    expect(tasks).toHaveLength(3);
    expect(tasks.every((row) => Number(row.total) > 0)).toBe(true);
    const files = storage.sql
      .exec(
        "SELECT project_id,path,content FROM workspace_files ORDER BY project_id,path"
      )
      .toArray();
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(
      files.some((row) => String(row.content).includes("Template Studio"))
    ).toBe(true);
    expect(
      files.some((row) => String(row.content).includes("Personal workspace"))
    ).toBe(true);
    expect(
      files.some((row) =>
        String(row.content).includes("Development acceptance")
      )
    ).toBe(true);
    expect(
      storage.sql
        .exec(
          "SELECT COUNT(*) AS total FROM extension_instances WHERE space_id IN ('fresh-space-0','fresh-space-1','fresh-space-2')"
        )
        .toArray()[0]?.total
    ).toBe(0);
    const changed = structuredClone(PERSONAL_ASSISTANT_SPACE_TEMPLATE);
    changed.projects[0]!.systemPrompt += " Changed artifact";
    expect((await install(changed, 1)).status).toBe(409);
    expect(storage.sql.exec("SELECT COUNT(*) AS total FROM projects WHERE space_id='fresh-space-1'").toArray()[0]?.total).toBe(1);
  });

  it("allows only one concurrent activation claim for a target Space and blueprint", async () => {
    const storage = createDOStorage(), space = new SpaceDO({ storage } as never, {} as never);
    await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=template-test&user_id=owner&project_id="));
    const install = () => space.fetch(new Request("http://space/blueprints/instantiate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ blueprint: PERSONAL_ASSISTANT_SPACE_TEMPLATE, target_space_id: "fresh-space", activation_key: PERSONAL_ASSISTANT_SPACE_TEMPLATE.id }),
    }));
    const results = await Promise.all([install(), install()]);
    expect(results.map(result => result.status).sort()).toEqual([201, 409]);
    expect(storage.sql.exec("SELECT COUNT(*) AS total FROM projects WHERE space_id='fresh-space'").toArray()[0]?.total).toBe(1);
  });
});
