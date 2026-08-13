'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  costRank,
  orderBillingThenSpeed,
  orderModelCandidates,
} = require('../routing-strategies');

test('costRank：订阅 < 免费 < 按量', () => {
  assert.ok(costRank({ type: 'paid', source: 'subscription' }) < costRank({ type: 'free' }));
  assert.ok(costRank({ type: 'free' }) < costRank({ type: 'paid', source: 'payg' }));
  assert.ok(costRank({ type: 'paid', source: 'subscription' }) < costRank({ type: 'paid', source: 'payg' }));
});

test('orderBillingThenSpeed：订阅优先，同档比速度', () => {
  const cands = [
    { id: 'volc', type: 'paid', source: 'subscription' },
    { id: 'ds', type: 'paid', source: 'subscription' },
    { id: 'free1', type: 'free' },
    { id: 'payg1', type: 'paid', source: 'payg' },
  ];
  const ordered = orderBillingThenSpeed(cands, {
    speedByProvider: { volc: 60000, ds: 7000, free1: 1000, payg1: 500 },
  });
  assert.deepEqual(ordered.map((p) => p.id), ['ds', 'volc', 'free1', 'payg1']);
});

test('orderModelCandidates(cost)：订阅→免费→按量，同类比 speedMs', () => {
  const cands = [
    { providerId: 'payg', providerTier: 'paid', source: 'payg', model: 'm', speedMs: 100 },
    { providerId: 'sub-slow', providerTier: 'paid', source: 'subscription', model: 'm', speedMs: 50000 },
    { providerId: 'sub-fast', providerTier: 'paid', source: 'subscription', model: 'm', speedMs: 800 },
    { providerId: 'free', providerTier: 'free', source: '', model: 'm', speedMs: 200 },
  ];
  const ordered = orderModelCandidates('cost', cands);
  assert.deepEqual(ordered.map((c) => c.providerId), ['sub-fast', 'sub-slow', 'free', 'payg']);
});

test('orderModelCandidates(auto) 同样计费优先', () => {
  const cands = [
    { providerId: 'payg', providerTier: 'paid', source: 'payg', model: 'm', speedMs: 50 },
    { providerId: 'sub', providerTier: 'paid', source: 'subscription', model: 'm', speedMs: 900 },
  ];
  const ordered = orderModelCandidates('auto', cands);
  assert.equal(ordered[0].providerId, 'sub');
});
