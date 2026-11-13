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
    const instantiate = space.instantiateBlueprint.bind(space);
    let announceEntered!: () => void;
    let releaseInstall!: () => void;
    const entered = new Promise<void>(resolve => { announceEntered = resolve; });
    const installGate = new Promise<void>(resolve => { releaseInstall = resolve; });
    space.instantiateBlueprint = async (blueprint, targetSpaceId) => {
      announceEntered();
      await installGate;
      return instantiate(blueprint, targetSpaceId);
    };
    const install = () => space.fetch(new Request("http://space/blueprints/instantiate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ blueprint: PERSONAL_ASSISTANT_SPACE_TEMPLATE, target_space_id: "fresh-space", activation_key: PERSONAL_ASSISTANT_SPACE_TEMPLATE.id }),
    }));
    const firstInstall = install();
    await entered;
    let competingInstall: Response;
    try {
      competingInstall = await install();
    } finally {
      releaseInstall();
    }
    const firstResult = await firstInstall;
    expect(firstResult.status).toBe(201);
    expect(competingInstall.status).toBe(409);
    expect(await competingInstall.json()).toMatchObject({ error_code: "blueprint_install_in_progress" });
    expect(storage.sql.exec("SELECT COUNT(*) AS total FROM projects WHERE space_id='fresh-space'").toArray()[0]?.total).toBe(1);
    const retry = await install();
    expect(retry.status).toBe(200);
    const installed = await firstResult.json();
    expect(await retry.json()).toMatchObject({ ...installed, alreadyInstalled: true });
  });

  it("validates and persists approved setup values with the idempotent installation claim", async () => {
    const storage = createDOStorage(), space = new SpaceDO({ storage } as never, {} as never);
    await space.fetch(new Request("http://space/container-installations?tenant_id=tenant&space_id=template-test&user_id=owner&project_id="));
    const blueprint = structuredClone(PERSONAL_ASSISTANT_SPACE_TEMPLATE);
    blueprint.setupSchemaVersion = 1;
    blueprint.projects[0]!.id = "assistant";
    blueprint.projects[0]!.setupFields = [
      { id: "greeting", type: "text", label: "Greeting", required: true, minLength: 2, maxLength: 80 },
      { id: "language", type: "select", label: "Language", options: [{ value: "en", label: "English" }, { value: "es", label: "Spanish" }], defaultValue: "en" },
    ];
    const install = (setup_values: unknown) => space.fetch(new Request("http://space/blueprints/instantiate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ blueprint, target_space_id: "setup-space", activation_key: blueprint.id, setup_values }),
    }));

    expect((await install({ assistant: {} })).status).toBe(400);
    expect(storage.sql.exec("SELECT COUNT(*) AS total FROM space_blueprint_installations WHERE space_id='setup-space'").toArray()[0]?.total).toBe(0);
    const first = await install({ assistant: { greeting: "Welcome" } });
    expect(first.status).toBe(201);
    expect(storage.sql.exec("SELECT setup_values_json FROM space_blueprint_installations WHERE space_id='setup-space'").toArray()[0]?.setup_values_json)
      .toBe(JSON.stringify({ assistant: { greeting: "Welcome", language: "en" } }));
    expect(storage.sql.exec("SELECT setup_schema_json,setup_revision FROM space_blueprint_installations WHERE space_id='setup-space'").toArray()[0])
      .toMatchObject({ setup_schema_json: expect.stringContaining("assistant"), setup_revision: 1 });
    expect((await install({ assistant: { greeting: "Changed" } })).status).toBe(409);
    expect((await install({ assistant: { greeting: "Welcome" } })).status).toBe(200);
  });
});
