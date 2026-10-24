import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareCosts } from './compare-costs.mjs';
const now=new Date('2026-10-24T12:00:00Z');
const quote={provider:'example',currency:'USD',market:'US-local',direction:'inbound',source:'https://example.com/quote',observedAt:'2026-10-24',numberMonthlyUsd:1,carrierPerMinuteUsd:.01,mediaPerMinuteUsd:.004,speechPerMinuteUsd:.02,inferencePerMinuteUsd:.01,computePerMinuteUsd:.001,otherMonthlyUsd:2};
const scenario={minutes:200,platformMonthlyUsd:3,quotes:[quote]};
test('includes all supplied costs without claiming software margins',()=>{const r=compareCosts(scenario,now);assert.ok(Math.abs(r.estimates[0].totalMonthlyUsd-15)<1e-9);assert.ok(Math.abs(r.estimates[0].monthlyUsd-12)<1e-9);});
test('requires complete fresh comparable quotes',()=>{for(const change of [{speechPerMinuteUsd:undefined},{observedAt:'2020-01-01'},{carrierPerMinuteUsd:-1},{currency:'EUR'}])assert.throws(()=>compareCosts({...scenario,quotes:[{...quote,...change}]},now));assert.throws(()=>compareCosts({...scenario,quotes:[quote,{...quote,direction:'outbound'}]},now));});
test('rejects invalid usage and reports savings',()=>{assert.throws(()=>compareCosts({...scenario,minutes:Infinity},now));const r=compareCosts({...scenario,quotes:[quote,{...quote,provider:'second',numberMonthlyUsd:0}]},now);assert.equal(r.estimates[1].savingsVsFirstUsd,1);});
