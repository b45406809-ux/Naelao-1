interface Env {
  NAELAO_SPACE_DO: DurableObjectNamespace;
  NAELAO_WALLET_DO: DurableObjectNamespace;
  NAELAO_CONFIG_KV: KVNamespace;
  NAELAO_CIRCUIT_KV: KVNamespace;
  NAELAO_ANALYTICS: AnalyticsEngineDataset;
  LEMON_SQUEEZY_VARIANT_CREDITS: string;
}

function spaceDOStub(env: Env, spaceId: string) {
  return env.NAELAO_SPACE_DO.get(env.NAELAO_SPACE_DO.idFromName('space:' + spaceId));
}

export async function grantCredits(
  spaceId: string,
  credits: number,
  reason: string,
  billingEventId: string,
  env: Env
): Promise<void> {
  const stub = spaceDOStub(env, spaceId);

  const checkResp = await stub.fetch(new Request('http://space/billing/event-check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId: billingEventId }),
  }));
  const checkData = await checkResp.json<{ processed: boolean }>();
  if (checkData.processed) return;

  await stub.fetch(new Request('http://space/billing/event-mark', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId: billingEventId }),
  }));

  await stub.fetch(new Request('http://space/credits/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: credits, reason, billingEventId }),
  }));
}

export async function creditsForVariant(
  variantOrPriceId: string,
  _amountCents: number,
  env: Env
): Promise<number> {
  let creditMap: Record<string, number> = {};
  try {
    creditMap = JSON.parse(env.LEMON_SQUEEZY_VARIANT_CREDITS) as Record<string, number>;
  } catch {
    return 0;
  }

  const credits = creditMap[variantOrPriceId];
  if (credits === undefined || credits === 0) {
    env.NAELAO_ANALYTICS.writeDataPoint({
      blobs: ['billing_variant_not_found', variantOrPriceId],
      doubles: [],
    });
    return 0;
  }
  return credits;
}

export async function revokeCredits(
  spaceId: string,
  credits: number,
  reason: string,
  env: Env
): Promise<void> {
  const stub = spaceDOStub(env, spaceId);
  await stub.fetch(new Request('http://space/credits/deduct', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: credits, reason }),
  }));
}
