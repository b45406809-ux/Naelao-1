import { describe, expect, it } from "vitest";
import { SpaceDO } from "./SpaceDO.js";

function fixture() {
  const sessions = new Map<
    string,
    {
      id: string;
      space_id: string;
      tenant_id: string;
      end_user_id: string | null;
      metadata: string;
      created_at: string;
      updated_at: string;
    }
  >();
  const sql = {
    exec(query: string, ...args: unknown[]) {
      if (query.includes("FROM sessions WHERE id = ?")) {
        const row = sessions.get(String(args[0]));
        return { toArray: () => (row ? [row] : []) };
      }
      if (query.includes("INSERT INTO sessions")) {
        const [
          id,
          space_id,
          tenant_id,
          end_user_id,
          metadata,
          created_at,
          updated_at,
        ] = args.map(String);
        sessions.set(id, {
          id,
          space_id,
          tenant_id,
          end_user_id,
          metadata,
          created_at,
          updated_at,
        });
      }
      return { toArray: () => [], rowsWritten: 1 };
    },
  };
  const object = new SpaceDO(
    {
      storage: {
        sql,
        transactionSync: (fn: () => unknown) => fn(),
        setAlarm: async () => undefined,
      },
    } as never,
    {} as never
  );
  return { object, sessions };
}

async function create(
  object: SpaceDO,
  tenantId: string,
  spaceId = "space-a",
  endUserId = "slack:user-1"
) {
  return object.fetch(
    new Request("https://space/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "queue-delivery-1",
        tenant_id: tenantId,
        space_id: spaceId,
        end_user_id: endUserId,
      }),
    })
  );
}

describe("session create idempotency", () => {
  it("returns the existing owned session on queue redelivery and rejects cross-tenant ID claims", async () => {
    const { object, sessions } = fixture();
    const first = await create(object, "tenant-a");
    expect(first.status).toBe(201);
    expect(sessions.size).toBe(1);

    const retry = await create(object, "tenant-a");
    expect(retry.status).toBe(200);
    expect(sessions.size).toBe(1);

    expect(
      (await create(object, "tenant-a", "space-a", "slack:other-user")).status
    ).toBe(409);
    const collision = await create(object, "tenant-b");
    expect(collision.status).toBe(409);
    expect(sessions.size).toBe(1);
  });

  it("rejects invalid caller-supplied IDs before writing", async () => {
    const { object, sessions } = fixture();
    const response = await object.fetch(
      new Request("https://space/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "../foreign",
          tenant_id: "tenant-a",
          space_id: "space-a",
        }),
      })
    );
    expect(response.status).toBe(400);
    expect(sessions.size).toBe(0);
  });
});
