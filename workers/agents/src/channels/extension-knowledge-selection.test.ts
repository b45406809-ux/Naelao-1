import { describe, expect, it } from "vitest";
import { resolveExtensionProjectKnowledge, resolveCurrentExtensionKnowledgeRevision } from "./extension-knowledge-selection.js";

describe("Space-shared extension Project Knowledge selection", () => {
  const declaredPublicationIds = ["course_material", "public_faq"];

  it("defaults Space-shared Project Knowledge access to no publications until an owner configures a selection", () => {
    expect(resolveExtensionProjectKnowledge({ declaredPublicationIds, configured: false, grantedPublicationIds: [] }))
      .toEqual([]);
  });

  it("intersects explicit Project grants with the active signed channel declaration", () => {
    expect(resolveExtensionProjectKnowledge({ declaredPublicationIds, configured: true,
      grantedPublicationIds: ["public_faq", "other_collection"] })).toEqual(["public_faq"]);
    expect(resolveExtensionProjectKnowledge({ declaredPublicationIds, configured: true, grantedPublicationIds: [] })).toEqual([]);
  });

  it("rejects malformed or oversized selection state before handler dispatch", () => {
    expect(resolveExtensionProjectKnowledge({ declaredPublicationIds, configured: "true", grantedPublicationIds: [] })).toBeNull();
    expect(resolveExtensionProjectKnowledge({ declaredPublicationIds, configured: true, grantedPublicationIds: ["../private"] })).toBeNull();
    expect(resolveExtensionProjectKnowledge({ declaredPublicationIds: Array(17).fill("course_material"), configured: false, grantedPublicationIds: [] })).toBeNull();
  });

  it("requires a current exact-revision use grant for a Space-shared channel", () => {
    const common = { scope: "SPACE_SHARED" as const, instanceId: "instance-a", extensionId: "ext_mentor",
      publicationId: "course_material", publications: [{ id: "course_material", revision: 5 }] };
    expect(resolveCurrentExtensionKnowledgeRevision({ ...common,
      grant: { instanceId: "instance-a", extensionId: "ext_mentor", publications: [{ id: "course_material", revision: 5 }] } })).toBe(5);
    expect(resolveCurrentExtensionKnowledgeRevision({ ...common,
      grant: { instanceId: "instance-a", extensionId: "ext_mentor", publications: [{ id: "course_material", revision: 4 }] } })).toBeNull();
    expect(resolveCurrentExtensionKnowledgeRevision({ ...common,
      grant: { instanceId: "instance-a", extensionId: "ext_mentor", publications: [] } })).toBeNull();
    expect(resolveCurrentExtensionKnowledgeRevision({ ...common,
      grant: { instanceId: "instance-b", extensionId: "ext_mentor", publications: [{ id: "course_material", revision: 5 }] } })).toBeNull();
  });

  it("uses only an extant current owner publication for a Project-bound channel", () => {
    expect(resolveCurrentExtensionKnowledgeRevision({ scope: "PROJECT_BOUND", instanceId: "instance-a", extensionId: "ext_mentor",
      publicationId: "course_material", publications: [{ id: "course_material", revision: 2 }] })).toBe(2);
    expect(resolveCurrentExtensionKnowledgeRevision({ scope: "PROJECT_BOUND", instanceId: "instance-a", extensionId: "ext_mentor",
      publicationId: "course_material", publications: [] })).toBeNull();
  });
});
