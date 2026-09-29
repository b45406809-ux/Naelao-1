import { describe,expect,it,vi } from "vitest";
import { selectContainerBackend, type ContainerBackend } from "@naelao/agent-sdk";
import { isPortableWorkspacePath } from "./do/ToolSandboxDO.js";
import { evaluateOrderRisk } from "./do/RiskGuardDO.js";
import { handleExecutiveInbound } from "./channels/executive-channel.js";

describe("Reconciliation B2 invariants",()=>{
 it("selects each canonical Tier-6 backend",()=>{const values:ContainerBackend[]=[selectContainerBackend({browserAvailable:true}),selectContainerBackend({native:true}),selectContainerBackend({gpu:true,localTunnelAuthorized:true})];expect(values).toEqual(["webcontainer","cloudflare_container","local_workstation"]);});
 it("never treats node_modules as portable state",()=>{expect(isPortableWorkspacePath("src/index.ts")).toBe(true);expect(isPortableWorkspacePath("node_modules/pkg/index.js")).toBe(false);expect(isPortableWorkspacePath("app\\node_modules\\pkg")).toBe(false);});
 it("rejects stop loss and drawdown violations synchronously below 70ms",()=>{const start=performance.now();const limits={stopLossBps:500,maxDrawdownBps:1000,peakEquityMinor:100_000};expect(evaluateOrderRisk({id:"a",side:"buy",quantity:1,priceMinor:1_000,currentEquityMinor:100_000,projectedLossMinor:5_001},limits)).toMatchObject({allowed:false,reason:"stop_loss"});expect(evaluateOrderRisk({id:"b",side:"sell",quantity:1,priceMinor:1_000,currentEquityMinor:89_000,projectedLossMinor:1},limits)).toMatchObject({allowed:false,reason:"max_drawdown"});expect(performance.now()-start).toBeLessThan(70);});
 it("atomically fans STOP out to space and order freezes below 500ms",async()=>{const freeze=vi.fn(async()=>{}),abortPendingOrders=vi.fn(async()=>{}),send=vi.fn(async()=>{});const result=await handleExecutiveInbound({spaceId:"s",tenantId:"t",channel:"whatsapp",senderId:"owner",text:" STOP "},{verify:async()=>true,freeze,abortPendingOrders,send,routeToRootAssistant:async()=>{}});expect(result.emergencyStopped).toBe(true);expect(result.freezeMs).toBeLessThan(500);expect(freeze).toHaveBeenCalledOnce();expect(abortPendingOrders).toHaveBeenCalledOnce();});
});
