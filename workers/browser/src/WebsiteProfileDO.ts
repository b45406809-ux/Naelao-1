import { DurableObject } from "cloudflare:workers";
import {
  openProfile,
  sealProfile,
  profileOwner,
  leaseOwner,
  type WebsiteState,
} from "./website-profile.js";
import type { BrowserEnv } from "./BrowserSessionDO.js";
import type { BrowserRuntimeScope } from "@naelao/agent-sdk";
/** Internal only. Profile plaintext is returned exclusively to the browser host, never the model. */
export class WebsiteProfileDO extends DurableObject<BrowserEnv> {
  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
  override async fetch(request: Request): Promise<Response> {
    const { scope, state } = await request.json<{
      scope: BrowserRuntimeScope;
      state?: WebsiteState;
    }>();
    const operation = new URL(request.url).pathname;
    return this.ctx.blockConcurrencyWhile(async () => {
      if (operation === "/revoke") {
        const activeScope =
          await this.ctx.storage.get<BrowserRuntimeScope>("activeScope");
        await this.ctx.storage.deleteAll();
        await this.ctx.storage.put("revoked", true);
        return Response.json({ ok: true, activeScope });
      }
      if (await this.ctx.storage.get("revoked"))
        return Response.json(
          { error_code: "browser_connection_revoked" },
          { status: 403 }
        );
      const owner = profileOwner(scope),
        holder = leaseOwner(scope);
      const lease = await this.ctx.storage.get<{
        owner: string;
        until: number;
      }>("lease");
      if (operation === "/release" && lease?.owner !== holder)
        return Response.json({ ok: true });
      if (lease && lease.until > Date.now() && lease.owner !== holder)
        return Response.json(
          { error_code: "browser_connection_busy" },
          { status: 409 }
        );
      if (operation === "/release") {
        if (lease?.owner === holder) await this.ctx.storage.delete("lease");
        return Response.json({ ok: true });
      }
      if (operation !== "/load" && operation !== "/save")
        return new Response(null, { status: 404 });
      await this.ctx.storage.put("activeScope", scope);
      await this.ctx.storage.put("lease", {
        owner: holder,
        until: Math.min(scope.expiresAt, Date.now() + 120_000),
      });
      if (operation === "/save" && state) {
        await this.ctx.storage.put(
          "sealed",
          await sealProfile(this.env.PLATFORM_SECRET, owner, state)
        );
        await this.ctx.storage.setAlarm(Date.now() + 30 * 86400_000);
      }
      const sealed =
        await this.ctx.storage.get<Awaited<ReturnType<typeof sealProfile>>>(
          "sealed"
        );
      return Response.json({
        state:
          operation === "/load" && sealed
            ? await openProfile(this.env.PLATFORM_SECRET, owner, sealed)
            : null,
      });
    });
  }
}
