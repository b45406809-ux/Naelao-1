import { describe, expect, it } from "vitest";
import { previewExtensionResourceRequirements } from "./extension-resource-preview";

describe("extension resource manifest preview", () => {
  it("projects exact supported resource declarations and limits", () => {
    expect(previewExtensionResourceRequirements([{ id: "catalog.v1", kind: "structured_data", apiVersion: "1.0", scope: "project",
      binding: { gadgetId: "catalog_data", tables: ["products"] }, operations: [{ id: "read", meteringUnit: "request" }],
      limits: { requestsPerMinute: 20, maxConcurrent: 2, maxBytesPerOperation: 1024 } }])).toEqual({ invalid: false, requirements: [{
      id: "catalog.v1", kind: "structured_data", scope: "project", operations: [{ id: "read", meteringUnit: "request" }],
      limits: { requestsPerMinute: 20, maxConcurrent: 2, maxBytesPerOperation: 1024 }, targets: ["catalog_data · tables: products"],
    }] });
  });

  it("covers jobs-only packages and rejects malformed declarations rather than hiding them", () => {
    expect(previewExtensionResourceRequirements([{ id: "worker_jobs", apiVersion: "1.0", kind: "jobs", scope: "project",
      binding: { workflowIds: ["index_docs"] }, operations: [{ id: "enqueue", meteringUnit: "job" }],
      limits: { requestsPerMinute: 10, maxConcurrent: 1, maxBytesPerOperation: 4096 } }]).requirements[0]?.targets)
      .toEqual(["workflows: index_docs"]);
    expect(previewExtensionResourceRequirements([{ id: "bad", kind: "jobs", apiVersion: "1.0", scope: "project", operations: [], limits: {} }]))
      .toEqual({ requirements: [], invalid: true });
  });

  it("shows only explicitly bound Project Knowledge publications", () => {
    expect(previewExtensionResourceRequirements([{ id: "knowledge_search", kind: "knowledge", apiVersion: "1.0", scope: "project",
      binding: { publicationIds: ["owner_docs"] }, operations: [{ id: "search", meteringUnit: "request" }],
      limits: { requestsPerMinute: 10, maxConcurrent: 1, maxBytesPerOperation: 4096 } }])).toEqual({ invalid: false, requirements: [{
      id: "knowledge_search", kind: "knowledge", scope: "project", operations: [{ id: "search", meteringUnit: "request" }],
      limits: { requestsPerMinute: 10, maxConcurrent: 1, maxBytesPerOperation: 4096 }, targets: ["published Knowledge: owner_docs"],
    }] });
    expect(previewExtensionResourceRequirements([{ id: "knowledge_search", kind: "knowledge", apiVersion: "1.0", scope: "space",
      binding: { publicationIds: ["owner_docs"] }, operations: [{ id: "search", meteringUnit: "request" }],
      limits: { requestsPerMinute: 10, maxConcurrent: 1, maxBytesPerOperation: 4096 } }])).toMatchObject({ invalid: true, requirements: [] });
  });

  it("shows supported Space object scope and bounds without inventing a price", () => {
    expect(previewExtensionResourceRequirements([{ id: "files.v1", kind: "objects", apiVersion: "1.0", scope: "space",
      operations: [{ id: "put", meteringUnit: "byte" }], limits: { requestsPerMinute: 1000, maxConcurrent: 64, maxBytesPerOperation: 1024 } }]))
      .toMatchObject({ invalid: false, requirements: [{ id: "files.v1", kind: "objects", scope: "space", operations: [{ meteringUnit: "byte" }] }] });
    expect(previewExtensionResourceRequirements([{ id: "files", kind: "objects", apiVersion: "1.0", scope: "space",
      operations: [{ id: "put", meteringUnit: "usd" }], limits: { requestsPerMinute: 1, maxConcurrent: 1, maxBytesPerOperation: 1 } }]))
      .toEqual({ requirements: [], invalid: true });
  });
});
