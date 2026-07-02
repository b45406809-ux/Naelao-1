import { describe, it, expect, vi, beforeEach } from "vitest";
import { signJwt, verifyJwt } from "@naelao/auth";

const TEST_SECRET = "integration-test-secret";

// ── Mock D1 ──────────────────────────────────────────────────────────────────
function makeD1Mock(userData: Record<string, unknown> | null) {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(userData),
        run: vi.fn().mockResolvedValue({ success: true }),
        all: vi.fn().mockResolvedValue({ results: [] }),
      }),
    }),
    batch: vi.fn().mockResolvedValue([]),
  };
}

async function simulateLogin(
  email: string,
  password: string,
  db: ReturnType<typeof makeD1Mock>,
  jwtSecret: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const enc = new TextEncoder();
  const hashBuf = await crypto.subtle.digest("SHA-256", enc.encode(password));
  const passwordHash = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const user = await db.prepare("").bind("").first<{
    id: string; email: string; password_hash: string;
    status: string; org_id: string; role: string; plan_tier: string;
  }>();

  if (!user) return { status: 401, body: { error_code: "unauthorized", message: "Invalid email or password" } };
  if (user.status !== "active") return { status: 401, body: { error_code: "unauthorized", message: "Account is not active" } };
  if (user.password_hash !== passwordHash) return { status: 401, body: { error_code: "unauthorized", message: "Invalid email or password" } };

  const token = await signJwt(
    { sub: user.id, tid: user.org_id, email: user.email, role: user.role as "owner", scopes: ["api:access"] },
    jwtSecret,
    86400
  );
  return { status: 200, body: { data: { token, user: { id: user.id, email: user.email, role: user.role, plan_tier: user.plan_tier } } } };
}

describe("Auth flow (mocked D1)", () => {
  const validUser = {
    id: "user-1",
    email: "test@example.com",
    password_hash: "", // will be set in beforeEach
    status: "active",
    org_id: "org-1",
    role: "owner",
    plan_tier: "growth",
  };

  beforeEach(async () => {
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest("SHA-256", enc.encode("Password123!"));
    validUser.password_hash = Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  });

  it("returns token and user data on valid login", async () => {
    const db = makeD1Mock(validUser);
    const result = await simulateLogin("test@example.com", "Password123!", db, TEST_SECRET);
    expect(result.status).toBe(200);
    expect(result.body.data).toBeDefined();
    const data = result.body.data as Record<string, unknown>;
    expect(typeof data.token).toBe("string");
    expect((data.user as Record<string, unknown>).email).toBe("test@example.com");
  });

  it("returns 401 for wrong password", async () => {
    const db = makeD1Mock(validUser);
    const result = await simulateLogin("test@example.com", "WrongPassword!", db, TEST_SECRET);
    expect(result.status).toBe(401);
  });

  it("returns 401 for unknown user", async () => {
    const db = makeD1Mock(null);
    const result = await simulateLogin("unknown@example.com", "Password123!", db, TEST_SECRET);
    expect(result.status).toBe(401);
  });

  it("returns 401 for inactive user", async () => {
    const inactiveUser = { ...validUser, status: "suspended" };
    const db = makeD1Mock(inactiveUser);
    const result = await simulateLogin("test@example.com", "Password123!", db, TEST_SECRET);
    expect(result.status).toBe(401);
  });
});

describe("Token verify (using real JWT logic)", () => {
  it("verifies a freshly issued token", async () => {
    const token = await signJwt(
      { sub: "user-1", tid: "org-1", email: "a@b.com", role: "owner", scopes: ["api:access"] },
      TEST_SECRET
    );
    const claims = await verifyJwt(token, TEST_SECRET);
    expect(claims.sub).toBe("user-1");
    expect(claims.role).toBe("owner");
  });

  it("rejects expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt(
      { sub: "u", tid: "t", email: "a@b.com", role: "viewer", scopes: [], iat: now - 7200, exp: now - 3600 },
      TEST_SECRET
    );
    await expect(verifyJwt(token, TEST_SECRET)).rejects.toMatchObject({ code: "token_expired" });
  });
});
