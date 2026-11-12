import { describe, expect, it } from "vitest";
import { recordProviderCostReceipts, summarizeProviderCostReceipts, type ProviderCostReceiptInput } from "./provider-cost-receipts.js";

class FakeDb {
  readonly rows=new Map<string,Record<string,unknown>>();
  prepare(sql:string){
    let values:unknown[]=[];
    const statement={
      bind:(...next:unknown[])=>{values=next;return statement;},
      run:async()=>{
        if(!sql.includes("INSERT OR IGNORE INTO sandbox_provider_cost_receipts"))return{success:true,meta:{changes:1}};
        const row={id:values[0],tenant_id:values[1],provider:values[2],statement_ref_hash:values[3],receipt_ref_hash:values[4],account_ref_hash:values[5],
          allocation_ref_hash:values[6],usage_kind:values[7],period_start:values[8],period_end:values[9],quantity_micros:values[10],provider_cost_micros:values[11],
          currency:values[12],evidence_sha256:values[13],provenance:"operator_imported",imported_by:values[14],imported_at:values[15]};
        if(this.rows.has(String(row.id)))return{success:true,meta:{changes:0}};
        this.rows.set(String(row.id),row);return{success:true,meta:{changes:1}};
      },
      first:async()=>this.rows.get(String(values[0]))??null,
      all:async()=>{
        const rows=[...this.rows.values()].filter(row=>row.tenant_id===values[0]&&row.provider===values[1]&&row.currency===values[2]
          &&String(row.period_start)>=String(values[3])&&String(row.period_end)<=String(values[4]));
        return{results:[...new Set(rows.map(row=>row.usage_kind))].map(kind=>{const group=rows.filter(row=>row.usage_kind===kind);return{usage_kind:kind,
          receipt_count:group.length,quantity_micros:group.reduce((sum,row)=>sum+Number(row.quantity_micros),0),
          provider_cost_micros:group.reduce((sum,row)=>sum+Number(row.provider_cost_micros),0),statement_count:new Set(group.map(row=>row.statement_ref_hash)).size};})};
      },
    };
    return statement;
  }
  async batch(statements:Array<{run:()=>Promise<unknown>} >){return Promise.all(statements.map(statement=>statement.run()));}
}

const receipt:ProviderCostReceiptInput={provider:"agent37",statementRef:"statement-nov",receiptRef:"receipt-1",accountRef:"provider-account-sensitive",
  allocationRef:"allocation-private",usageKind:"compute",periodStart:"2026-11-01T00:00:00.000Z",periodEnd:"2026-12-01T00:00:00.000Z",
  quantityMicros:3_600_000_000,providerCostMicros:225_000,currency:"USD",evidenceSha256:"a".repeat(64)};

describe("sandbox provider cost receipts",()=>{
  it("stores hashed references separately from credits and reports operator-imported provenance",async()=>{
    const db=new FakeDb();
    const first=await recordProviderCostReceipts(db as never,{tenantId:"tenant-a",actorId:"operator-a",receipts:[receipt]});
    const replay=await recordProviderCostReceipts(db as never,{tenantId:"tenant-a",actorId:"operator-a",receipts:[receipt]});
    expect(first).toEqual({inserted:1,replayed:0,provenance:"operator_imported"});
    expect(replay).toEqual({inserted:0,replayed:1,provenance:"operator_imported"});
    const row=[...db.rows.values()][0]!;
    expect(JSON.stringify(row)).not.toContain("provider-account-sensitive");
    expect(JSON.stringify(row)).not.toContain("allocation-private");
    expect(await summarizeProviderCostReceipts(db as never,{tenantId:"tenant-a",provider:"agent37",periodStart:receipt.periodStart,periodEnd:receipt.periodEnd,currency:"USD"}))
      .toMatchObject({provenance:"operator_imported",usage:[{kind:"compute",receiptCount:1,providerCostMicros:225_000}]});
  });

  it("rejects changes under an already imported statement receipt identity",async()=>{
    const db=new FakeDb();await recordProviderCostReceipts(db as never,{tenantId:"tenant-a",actorId:"operator-a",receipts:[receipt]});
    await expect(recordProviderCostReceipts(db as never,{tenantId:"tenant-a",actorId:"operator-a",receipts:[{...receipt,providerCostMicros:230_000}]}))
      .rejects.toThrow("provider_cost_receipt_conflict");
  });
});
