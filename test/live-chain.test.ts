import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server'; // env is read inside createApp(), so a static import is safe
import { FakeChain } from './helpers/fake-chain';

const USDT = `0x${'11'.repeat(20)}`, DEP = `0x${'aa'.repeat(20)}`, PAYER = `0x${'bb'.repeat(20)}`;
const chain = new FakeChain(() => Math.floor(Date.now() / 1000));
const node = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', async () => {
    const { id, method, params } = JSON.parse(b);
    try { res.end(JSON.stringify({ jsonrpc: '2.0', id, result: await chain.call(method, params) })); }
    catch (e) { res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: String(e) } })); }
  });
});
after(() => { node.close(); });

async function until<T>(fn: () => Promise<T | false>, ms = 12_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 200)); }
}

test('server in live mode: real HTTP RPC, deposit pool, watcher timer -> SAFE_TO_SHIP', async () => {
  await new Promise<void>((ok) => node.listen(0, '127.0.0.1', ok));
  process.env.CHAIN_RPC_URL = `http://127.0.0.1:${(node.address() as AddressInfo).port}`;
  process.env.CHAIN_ID = '31337'; process.env.CHAIN_TOKEN_CONTRACT = USDT; process.env.CHAIN_DEPOSIT_POOL = DEP; process.env.CHAIN_MIN_CONFIRMATIONS = '3';
  const app = createApp({ port: 0 });
  const port = await app.start();
  try {
    const base = `http://127.0.0.1:${port}`;
    const H = { authorization: `Bearer ${app.apiKey}`, 'content-type': 'application/json' };
    const post = (p: string, body: object, k: string) => fetch(base + p, { method: 'POST', headers: { ...H, 'idempotency-key': k }, body: JSON.stringify(body) });
    const order = await (await post('/v1/orders', { merchantReference: 'LIVE-1', amountKobo: '5000000', acceptStablecoin: true }, 'o1')).json() as any;
    const att = await post(`/v1/orders/${order.id}/attempts`, { rail: 'CHAIN' }, 'a1');
    assert.equal(att.status, 201);
    const got = await (await fetch(`${base}/v1/orders/${order.id}`, { headers: H })).json() as any;
    assert.equal(got.attempts[0].depositAddress, DEP); // handed out from the real pool
    assert.equal((await post(`/v1/orders/${order.id}/attempts`, { rail: 'CHAIN' }, 'a2')).status, 503); // pool exhausted, never reused

    chain.mine([{ address: USDT, from: PAYER, to: DEP, amount: BigInt(order.stablecoin.amountMinor), txHash: '0xlive' }]);
    const code = async () => ((await (await fetch(`${base}/v1/orders/${order.id}`, { headers: H })).json()) as any).verdict.code as string;
    await until(async () => (await code()) === 'CONFIRMING');
    chain.mine(); chain.mine();
    await until(async () => (await code()) === 'SAFE_TO_SHIP');
  } finally { await app.stop(); }
});

test('server refuses to start live mode against a node on the wrong network', async () => {
  chain.chainId = 1;
  const app = createApp({ port: 0 });
  await assert.rejects(app.start(), /expected 31337/);
  await app.stop().catch(() => undefined);
});
