import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server';

const app = createApp({ port: 0 });
let base = '';
const ready = app.start().then((p) => { base = `http://127.0.0.1:${p}`; });
after(async () => { await app.stop(); });

const KEY = { authorization: `Bearer ${app.apiKey}` };
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  await ready;
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json: any = {}; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: r.status, json, text };
}
const state = async () => (await call('GET', '/demo/state')).json;
const newOrder = (ref: string, extra: object = {}, idem = `idem-${ref}`) =>
  call('POST', '/v1/orders', { merchantReference: ref, amountKobo: '5000000', ...extra }, { ...KEY, 'idempotency-key': idem });

test('listens on loopback only', async () => {
  await ready;
  assert.equal(app.host, '127.0.0.1');
});

test('auth: no key and wrong key are 401', async () => {
  assert.equal((await call('GET', '/v1/orders')).status, 401);
  assert.equal((await call('GET', '/v1/orders', undefined, { authorization: 'Bearer nope' })).status, 401);
});

test('POST requires an Idempotency-Key', async () => {
  const r = await call('POST', '/v1/orders', { merchantReference: 'NOKEY', amountKobo: '100' }, KEY);
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
});

test('idempotency: replay is identical; same key + different body is 409', async () => {
  const a = await newOrder('IDEM-1', {}, 'k-replay');
  const b = await newOrder('IDEM-1', {}, 'k-replay');
  assert.equal(a.status, 201);
  assert.equal(b.text, a.text);
  const c = await call('POST', '/v1/orders', { merchantReference: 'IDEM-1', amountKobo: '999' }, { ...KEY, 'idempotency-key': 'k-replay' });
  assert.equal(c.status, 409);
});

test('concurrent identical requests create exactly one order', async () => {
  const rs = await Promise.all(Array.from({ length: 8 }, () => newOrder('RACE-1', {}, 'k-race')));
  assert.ok(rs.every((r) => r.status === 201 || r.status === 409), rs.map((r) => r.status).join());
  const ids = new Set(rs.filter((r) => r.status === 201).map((r) => r.json.id));
  assert.equal(ids.size, 1);
  const list = (await call('GET', '/v1/orders', undefined, KEY)).json.data as { merchantReference: string }[];
  assert.equal(list.filter((o) => o.merchantReference === 'RACE-1').length, 1);
});

test('money precision: unsafe JSON numbers, decimals and negatives are rejected', async () => {
  for (const [i, amount] of [9007199254740993, 12.5, -1, 0, '12.5', '1e3', 'abc'].entries()) {
    const r = await call('POST', '/v1/orders', { merchantReference: `BAD-${i}`, amountKobo: amount }, { ...KEY, 'idempotency-key': `bad-${i}` });
    assert.equal(r.status, 400, `amount ${String(amount)} should be rejected, got ${r.status}`);
  }
  const huge = await newOrder('HUGE', { amountKobo: '99999999999999999999', acceptStablecoin: true });
  assert.equal(huge.status, 400);
});

test('public API exposes no internal fields', async () => {
  const o = await newOrder('LEAK-1', { acceptStablecoin: true });
  const list = await call('GET', '/v1/orders', undefined, KEY);
  for (const text of [o.text, list.text]) {
    for (const k of ['tenantId', 'version', 'lastSequenceBySource', 'lastAuthoritativeAt', 'statusChangedAt', 'verdictUpdatedAt']) {
      assert.ok(!text.includes(`"${k}"`), `leaked internal field ${k}`);
    }
  }
  assert.equal(o.json.verdict.code, 'AWAITING_PAYMENT');
});

test('clock: invalid, negative and absurd ticks are rejected and never corrupt the clock', async () => {
  for (const minutes of ['abc', -5, 99999, null]) assert.equal((await call('POST', '/sim/tick', { minutes })).status, 400);
  const s = await state();
  assert.ok(!Number.isNaN(Date.parse(s.now)));
});

test('simulator refuses actions on the wrong rail', async () => {
  await call('POST', '/sim/seed', {});
  const s = await state();
  const bank = s.orders.flatMap((o: any) => o.attempts).find((a: any) => a.rail === 'BANK');
  const chain = s.orders.flatMap((o: any) => o.attempts).find((a: any) => a.rail === 'CHAIN');
  assert.equal((await call('POST', `/sim/chain/${bank.attemptId}/seen`, {})).status, 400);
  assert.equal((await call('POST', `/sim/bank/${chain.attemptId}/success`, {})).status, 400);
});

test('wrong token first, then the correct payment, still ends SAFE_TO_SHIP', async () => {
  const id = (await call('POST', '/sim/seed', {})).json.orders[2] as string;
  const att = (await call('POST', `/sim/orders/${id}/attempt`, { rail: 'CHAIN' })).json.attemptId as string;
  const wrong = await call('POST', `/sim/chain/${att}/wrong`, {});
  assert.equal(wrong.json.verdict, 'WRONG_ASSET');
  await call('POST', `/sim/chain/${att}/seen`, {});
  let last: any; for (let i = 0; i < 3; i++) last = await call('POST', `/sim/chain/${att}/confirm`, {});
  assert.equal(last.json.verdict.verdict, 'SAFE_TO_SHIP');
});

test('full loop: bank success -> outbox -> signed webhook -> verified at the seller inbox, payload has no tenancy data', async () => {
  const id = (await call('POST', '/sim/seed', {})).json.orders[0] as string;
  const s0 = await state();
  const att = s0.orders.find((o: any) => o.order.id === id).attempts[0].attemptId as string;
  assert.equal((await call('POST', `/sim/bank/${att}/success`, {})).json.verdict.verdict, 'SAFE_TO_SHIP');
  await app.background(); await app.background();
  const s = await state();
  const hit = s.inbox.find((i: any) => i.eventType === 'payment.verdict_changed' && i.data.verdict === 'SAFE_TO_SHIP');
  assert.ok(hit, 'seller should have received the verdict change');
  assert.equal(hit.verified, true);
  assert.ok(!JSON.stringify(hit.data).includes('tenantId'));
  assert.ok(s.deliveries.every((d: any) => d.status === 'DELIVERED'));
});
