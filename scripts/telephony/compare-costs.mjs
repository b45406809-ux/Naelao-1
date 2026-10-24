/** Offline quote comparison. Never provisions numbers or contacts a carrier. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export function compareCosts(input, now = new Date()) {
  const finite = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (!input || !finite(input.minutes) || !finite(input.platformMonthlyUsd) || !Array.isArray(input.quotes) || !input.quotes.length) throw new Error('invalid_scenario');
  const components = ['numberMonthlyUsd','carrierPerMinuteUsd','mediaPerMinuteUsd','speechPerMinuteUsd','inferencePerMinuteUsd','computePerMinuteUsd','otherMonthlyUsd'];
  const rows = input.quotes.map(q => {
    if (!q || typeof q.provider !== 'string' || !q.provider.trim() || q.currency !== 'USD' || typeof q.market !== 'string' || typeof q.direction !== 'string' || typeof q.source !== 'string' || !/^https:\/\//.test(q.source) || components.some(k => !finite(q[k]))) throw new Error('incomplete_quote');
    const observed = Date.parse(q.observedAt);
    if (!Number.isFinite(observed) || observed > now.getTime() || now.getTime() - observed > 30*86400000) throw new Error('stale_quote');
    const perMinute = q.carrierPerMinuteUsd + q.mediaPerMinuteUsd + q.speechPerMinuteUsd + q.inferencePerMinuteUsd + q.computePerMinuteUsd;
    return { provider:q.provider,market:q.market,direction:q.direction,source:q.source,observedAt:q.observedAt,monthlyUsd:q.numberMonthlyUsd+q.otherMonthlyUsd+input.minutes*perMinute,perMinuteUsd:perMinute };
  });
  if (new Set(rows.map(r => JSON.stringify([r.market,r.direction]))).size !== 1) throw new Error('incomparable_quotes');
  const baseline = rows[0].monthlyUsd;
  return { minutes:input.minutes,platformMonthlyUsd:input.platformMonthlyUsd,estimates:rows.map(r => ({...r,totalMonthlyUsd:r.monthlyUsd+input.platformMonthlyUsd,savingsVsFirstUsd:baseline-r.monthlyUsd})),note:'Estimates only. Include taxes, surcharges and all call legs in supplied rates. Unknown costs must be researched before comparison; zero is an explicit assumption.' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(compareCosts(JSON.parse(readFileSync(process.argv[2], 'utf8'))),null,2)); }
  catch (error) { console.error(error.message); process.exitCode=1; }
}
