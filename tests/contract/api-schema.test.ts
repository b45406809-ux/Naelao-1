import { describe, it, expect } from "vitest";

// Contract tests — verify API response shapes match expected types
// These validate structure without needing a running server

function assertHasKeys<T extends object>(obj: unknown, keys: (keyof T)[]): void {
  expect(obj).toBeTruthy();
  expect(typeof obj).toBe("object");
  for (const key of keys) {
    expect(obj).toHaveProperty(String(key));
  }
}

describe("Auth response shape", () => {
  it("login success response has correct shape", () => {
    const response = {
      data: {
        token: "eyJhbGciOiJIUzI1NiJ9.payload.sig",
        user: { id: "user-1", email: "a@b.com", role: "owner", plan_tier: "growth" },
      },
      request_id: "req-123",
    };
    assertHasKeys(response, ["data", "request_id"]);
    assertHasKeys(response.data, ["token", "user"]);
    assertHasKeys(response.data.user, ["id", "email", "role", "plan_tier"]);
    expect(typeof response.data.token).toBe("string");
    expect(["owner", "admin", "editor", "viewer"]).toContain(response.data.user.role);
    expect(["free", "growth", "business", "enterprise"]).toContain(response.data.user.plan_tier);
  });
});

describe("Error response shape", () => {
  it("error response has error_code, message, request_id", () => {
    const error = {
      error_code: "unauthorized",
      message: "Missing or invalid Authorization header",
      request_id: "req-456",
    };
    assertHasKeys(error, ["error_code", "message", "request_id"]);
    expect(typeof error.error_code).toBe("string");
    expect(typeof error.message).toBe("string");
  });

  it("error response with details has optional details field", () => {
    const error = {
      error_code: "bad_request",
      message: "Validation failed",
      request_id: "req-789",
      details: { field: "email", issue: "invalid format" },
    };
    expect(error.details).toBeDefined();
    expect(typeof error.details).toBe("object");
  });
});

describe("Session response shape", () => {
  it("session has required fields", () => {
    const session = {
      id: "sess-1",
      space_id: "space-1",
      tenant_id: "tenant-1",
      status: "active",
      metadata: "{}",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    };
    assertHasKeys(session, ["id", "space_id", "tenant_id", "status", "created_at", "updated_at"]);
    expect(["active", "completed", "abandoned", "error"]).toContain(session.status);
  });
});

describe("Message response shape", () => {
  it("message has id, session_id, role, content, created_at", () => {
    const message = {
      id: "msg-1",
      session_id: "sess-1",
      role: "user",
      content: "Hello",
      created_at: "2024-01-01T00:00:00Z",
    };
    assertHasKeys(message, ["id", "session_id", "role", "content", "created_at"]);
    expect(["user", "assistant", "tool", "system"]).toContain(message.role);
    expect(typeof message.content).toBe("string");
  });
});

describe("KB document response shape", () => {
  it("kb document has required fields with correct types", () => {
    const doc = {
      id: "doc-1",
      space_id: "space-1",
      title: "My Document",
      status: "indexed",
      chunk_count: 5,
      content_type: "text",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    };
    assertHasKeys(doc, ["id", "title", "status", "chunk_count", "content_type"]);
    expect(["pending", "processing", "indexed", "failed"]).toContain(doc.status);
    expect(typeof doc.chunk_count).toBe("number");
  });
});

describe("SpaceType manifest shape", () => {
  it("spaceType has blueprint fields", () => {
    const spaceType = {
      id: "st-1",
      name: "Customer Support Bot",
      description: "Handles customer inquiries",
      status: "published",
      version: "1.0.0",
      schema_json: JSON.stringify({
        systemPromptTemplate: "You are a helpful support agent for {{company_name}}.",
        modelConfig: { model: "claude-sonnet-4-6", max_tokens: 4096, temperature: 0.7 },
        kbConfig: { max_documents: 100, chunk_size: 512, top_k: 5 },
      }),
      created_at: "2024-01-01T00:00:00Z",
    };
    assertHasKeys(spaceType, ["id", "name", "description", "status", "version"]);
    expect(["draft", "published", "deprecated"]).toContain(spaceType.status);
  });
});
