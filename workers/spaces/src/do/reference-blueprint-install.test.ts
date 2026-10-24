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
    const results = await Promise.all(
      templates.map((blueprint, index) =>
        space.fetch(
          new Request("http://space/blueprints/instantiate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              blueprint,
              target_space_id: `fresh-space-${index}`,
            }),
          })
        )
      )
    );
    expect(results.map((result) => result.status)).toEqual([201, 201, 201]);
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
  });
});
