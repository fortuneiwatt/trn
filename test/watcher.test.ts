import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { MemoryStore } from '../src/app/memory-store';
import { TrnService } from '../src/app/service';
import { EvmWatcher } from '../src/chain/evm-watcher';
import { HttpRpc } from '../src/chain/rpc';
import type { ChainConfig } from '../src/domain/chain';
import { FakeChain } from './helpers/fake-chain';
import type { FakeLog } from './helpers/fake-chain';

const MIN = 60_000;
const USDT = `0x${'11'.repeat(20)}`, OTHER = `0x${'22'.repeat(20)}`, DEP = `0x${'aa'.repeat(20)}`, DEP2 = `0x${'cc'.repeat(20)}`, PAYER = `0x${'bb'.repeat(20)}`;
const TOKEN = { symbol: 'USDT', rateKoboPerToken: 150_000n, decimals: 6 }; // N50,000 -> 33_333_334
const FULL = 33_333_334n;

function rig() {
  let t = new Date('2026-11-08T09:00:00Z').getTime();
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const svc = new TrnService(new MemoryStore(), clock, { orderTtlMs: 60 * MIN, rateLockGraceMs: MIN, bankMaxWaitMs: 30 * MIN });
  const chain = new FakeChain(() => Math.floor(clock.now().getTime() / 1000));
  const cfg: ChainConfig = { chainId: 31337, minConfirmations: 3, tokens: [{ symbol: 'USDT', contract: USDT, decimals: 6 }] };
  const watcher = new EvmWatcher({ rpc: chain, svc, chain: cfg, startBlock: 0, overlapBlocks: 4, dropAfterBlocks: 10 });
  return { clock, svc, chain, watcher };
}
async function order(svc: TrnService, dep = DEP, ref = 'O1') {
  const oid = await svc.createOrder('t1', { merchantReference: ref, amountKobo: 5_000_000n, token: TOKEN });
  const aid = await svc.createAttempt('t1', oid, 'CHAIN', { depositAddress: dep });
  return { oid, aid };
}
const view = (svc: TrnService, oid: string) => svc.getOrderView('t1', oid);
const code = async (svc: TrnService, oid: string) => (await view(svc, oid)).verdict.verdict;
const pay = (o: Partial<FakeLog> & { txHash: string }): FakeLog => ({ address: USDT, from: PAYER, to: DEP, amount: FULL, ...o });
const blocks = async (r: ReturnType<typeof rig>, n: number) => { for (let i = 0; i < n; i++) { r.chain.mine(); await r.watcher.tick(); } };

test('refuses to run against a node on the wrong network', async () => {
  const r = rig(); r.chain.chainId = 1;
  await assert.rejects(r.watcher.init(), /expected 31337/);
});

test('transfer -> CONFIRMING -> SAFE_TO_SHIP after 3 confirmations, paidAt is the BLOCK time', async () => {
  const r = rig(); const { oid } = await order(r.svc);
  r.chain.mine([pay({ txHash: '0xt1' })]); await r.watcher.tick();
  assert.equal(await code(r.svc, oid), 'CONFIRMING');
  await blocks(r, 1); assert.equal(await code(r.svc, oid), 'CONFIRMING');
  await blocks(r, 1); assert.equal(await code(r.svc, oid), 'SAFE_TO_SHIP');
  const a = (await view(r.svc, oid)).attempts[0]!;
  assert.equal(a.receivedAmountMinor, FULL);
  assert.equal(a.paidAt?.getTime(), (r.chain.blocks[1] as { timestamp: number }).timestamp * 1000);
});

test('re-running ticks never duplicates events', async () => {
  const r = rig(); const { oid } = await order(r.svc);
  r.chain.mine([pay({ txHash: '0xt1' })]); await blocks(r, 2);
  const n = (await view(r.svc, oid)).timeline.length;
  for (let i = 0; i < 5; i++) await r.watcher.tick();
  assert.equal((await view(r.svc, oid)).timeline.length, n);
});

test('underpayment -> PARTIAL_PAYMENT', async () => {
  const r = rig(); const { oid } = await order(r.svc);
  r.chain.mine([pay({ txHash: '0xt1', amount: 10_000_000n })]); await r.watcher.tick(); await blocks(r, 2);
  assert.equal(await code(r.svc, oid), 'PARTIAL_PAYMENT');
});

test('wrong token: flagged once, and a later correct payment still wins', async () => {
  const r = rig(); const { oid } = await order(r.svc);
  r.chain.mine([pay({ txHash: '0xbad', address: OTHER })]);
  for (let i = 0; i < 4; i++) await r.watcher.tick();
  assert.equal(await code(r.svc, oid), 'WRONG_ASSET');
  assert.equal((await view(r.svc, oid)).attempts.filter((a) => a.assetMismatch).length, 1);
  r.chain.mine([pay({ txHash: '0xgood' })]); await r.watcher.tick(); await blocks(r, 2);
  assert.equal(await code(r.svc, oid), 'SAFE_TO_SHIP');
});

test('an NFT (ERC-721) transfer to the deposit address is ignored', async () => {
  const r = rig(); const { oid } = await order(r.svc);
  r.chain.mine([pay({ txHash: '0xnft', nft: true })]); await blocks(r, 3);
  assert.equal(await code(r.svc, oid), 'AWAITING_PAYMENT');
});

test('reorg drops the transfer (WAIT), re-inclusion restores it, then it settles', async () => {
  const r = rig(); const { oid } = await order(r.svc);
  const tx = pay({ txHash: '0xre' });
  r.chain.mine([tx]); await r.watcher.tick();
  assert.equal(await code(r.svc, oid), 'CONFIRMING');
  r.chain.reorg(1, [[]]); await r.watcher.tick();
  assert.equal(await code(r.svc, oid), 'WAIT'); // gone from the canonical chain: never count it
  r.chain.mine([tx]); await r.watcher.tick();
  assert.equal(await code(r.svc, oid), 'CONFIRMING');
  await blocks(r, 2);
  assert.equal(await code(r.svc, oid), 'SAFE_TO_SHIP');
});

test('a transfer that never returns after a reorg is failed, and the customer can pay again', async () => {
  const r = rig(); const { oid } = await order(r.svc);
  r.chain.mine([pay({ txHash: '0xgone' })]); await r.watcher.tick();
  r.chain.reorg(1, [[]]); await r.watcher.tick();
  await blocks(r, 10);
  assert.equal(await code(r.svc, oid), 'SAFE_TO_RETRY');
  r.chain.mine([pay({ txHash: '0xretry' })]); await r.watcher.tick(); await blocks(r, 2);
  assert.equal(await code(r.svc, oid), 'SAFE_TO_SHIP');
});

test('two transfers to one deposit address are two attempts, and the double payment is flagged', async () => {
  const r = rig(); const { oid } = await order(r.svc);
  r.chain.mine([pay({ txHash: '0xa' }), pay({ txHash: '0xb' })]); await r.watcher.tick(); await blocks(r, 2);
  const v = await view(r.svc, oid);
  assert.equal(v.attempts.filter((a) => a.rail === 'CHAIN').length, 2);
  assert.equal(v.verdict.verdict, 'SAFE_TO_SHIP');
  assert.ok(v.verdict.flags.includes('POSSIBLE_DUPLICATE_PAYMENT'));
});

test('payment mined after the quote expired -> PAID_LATE_RATE_CHANGED (block time decides)', async () => {
  const r = rig(); const { oid } = await order(r.svc);
  r.clock.advance(90 * MIN);
  r.chain.mine([pay({ txHash: '0xlate' })]); await r.watcher.tick(); await blocks(r, 2);
  const v = await view(r.svc, oid);
  assert.equal(v.verdict.verdict, 'PAID_LATE_RATE_CHANGED');
  assert.equal(v.verdict.canFulfil, false);
});

test('payment to one order never affects another', async () => {
  const r = rig();
  const a = await order(r.svc, DEP, 'A'); const b = await order(r.svc, DEP2, 'B');
  r.chain.mine([pay({ txHash: '0xonlyA' })]); await r.watcher.tick(); await blocks(r, 2);
  assert.equal(await code(r.svc, a.oid), 'SAFE_TO_SHIP');
  assert.equal(await code(r.svc, b.oid), 'AWAITING_PAYMENT');
});

test('an RPC outage fails the tick cleanly; the next tick recovers with no duplicate events', async () => {
  const r = rig(); const { oid } = await order(r.svc);
  r.chain.mine([pay({ txHash: '0xo' })]); await r.watcher.tick();
  r.chain.failNext = 1; await assert.rejects(r.watcher.tick(), /outage/);
  const n = (await view(r.svc, oid)).timeline.length;
  await blocks(r, 2);
  assert.equal(await code(r.svc, oid), 'SAFE_TO_SHIP');
  assert.equal((await view(r.svc, oid)).timeline.length, n + 1); // exactly one new event: SUCCESS
});

test('HttpRpc: result, JSON-RPC error and HTTP error are all handled', async () => {
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      const { id, method } = JSON.parse(body);
      if (method === 'boom') { res.writeHead(500); return res.end('nope'); }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(method === 'bad' ? { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } } : { jsonrpc: '2.0', id, result: '0x7a69' }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const rpc = new HttpRpc(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 2000);
  try {
    assert.equal(await rpc.call('eth_chainId', []), '0x7a69');
    await assert.rejects(rpc.call('bad', []), /method not found/);
    await assert.rejects(rpc.call('boom', []), /HTTP 500/);
  } finally { server.close(); }
});
