import * as React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectMainRestartRecipesEditor } from "./ProjectMainRestartRecipesEditor";

describe("ProjectMainRestartRecipesEditor", () => {
  it("discloses that restart recipes are inert while runtime execution is unsupported", () => {
    const html = renderToStaticMarkup(<ProjectMainRestartRecipesEditor spaceId="space-a" projectId="project-a"
      session={{ sessionToken: "cookie", endUserId: "owner-a" }} />);
    expect(html).toContain("Recipes are inert");
    expect(html).toContain("cannot execute them or verify service health");
    expect(html).toContain("do not enter secrets, environment values, or credentials");
  });
});
