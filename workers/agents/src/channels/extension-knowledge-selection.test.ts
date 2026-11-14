import { describe, expect, it } from "vitest";
import { resolveExtensionProjectKnowledge } from "./extension-knowledge-selection.js";

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
});
