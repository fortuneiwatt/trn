import { classifyTransfer } from '../domain/chain';
import type { ChainConfig } from '../domain/chain';
import type { TrnService } from '../app/service';
import type { Rpc } from './rpc';

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const hex = (n: number) => `0x${n.toString(16)}`;
const num = (h: string) => Number(BigInt(h));
const topicFor = (addr: string) => `0x${addr.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;

interface RpcBlock { hash: string; timestamp: string }
interface RpcLog { address: string; topics: string[]; data: string; transactionHash: string; logIndex: string; blockNumber: string; blockHash: string; removed?: boolean }
interface Tracked {
  key: string; tenantId: string; attemptId: string; contract: string; amountMinor: bigint;
  blockNumber: number; blockHash: string; blockTimestamp: Date; lastSent: string | null; goneSince: number | null;
}
export interface WatcherOptions {
  rpc: Rpc; svc: TrnService; chain: ChainConfig;
  startBlock?: number; // first block to scan on a cold start (default: head - 1000)
  overlapBlocks?: number; // re-scan this many recent blocks each tick, to catch re-inclusion after a reorg
  maxRange?: number; // blocks per eth_getLogs call
  dropAfterBlocks?: number; // a transfer absent this long after a reorg is treated as failed
  onError?: (e: unknown) => void;
}

/**
 * Reads ERC-20 Transfer logs addressed to our deposit addresses and feeds the SAME ingestEvent()
 * path the simulator uses. It owns no payment logic: statuses come from classifyTransfer() and the
 * state machine decides what is legal. It never signs or sends anything (read-only).
 *
 * State here is in memory. After a restart it rescans from `startBlock` / head-1000 and re-finds
 * unresolved transfers (ingest is idempotent). Persisting it in chain_transfers/chain_cursors is the
 * Prisma step.
 */
export class EvmWatcher {
  private tracked = new Map<string, Tracked>();
  private ignored = new Set<string>();
  private boundAttempts = new Set<string>();
  private scannedTo: number | null = null;
  private o: Required<Omit<WatcherOptions, 'rpc' | 'svc' | 'chain' | 'startBlock' | 'onError'>> & WatcherOptions;

  constructor(opts: WatcherOptions) {
    this.o = { overlapBlocks: 12, maxRange: 2000, dropAfterBlocks: 64, ...opts };
  }

  /** Refuse to run against a node on the wrong network. This is the first WRONG_NETWORK defence. */
  async init(): Promise<void> {
    const id = num(await this.o.rpc.call<string>('eth_chainId', []));
    if (id !== this.o.chain.chainId) throw new Error(`RPC node is on chain ${id}, expected ${this.o.chain.chainId}`);
  }

  async tick(): Promise<void> {
    const { rpc, svc } = this.o;
    const head = num(await rpc.call<string>('eth_blockNumber', []));
    const deposits = await svc.listWatchedDeposits();
    const byAddr = new Map(deposits.map((d) => [d.depositAddress.toLowerCase(), d]));

    if (byAddr.size > 0) {
      const cold = this.o.startBlock ?? Math.max(0, head - 1000);
      const from = this.scannedTo === null ? cold : Math.max(0, this.scannedTo - this.o.overlapBlocks + 1);
      const topics = [TRANSFER_TOPIC, null, [...byAddr.keys()].map(topicFor)]; // any token, to our addresses
      for (let lo = from; lo <= head; lo += this.o.maxRange) {
        const hi = Math.min(head, lo + this.o.maxRange - 1);
        const logs = await rpc.call<RpcLog[]>('eth_getLogs', [{ fromBlock: hex(lo), toBlock: hex(hi), topics }]);
        for (const log of logs) await this.safely(() => this.onLog(log, byAddr));
      }
      this.scannedTo = head;
    }
    for (const t of [...this.tracked.values()]) await this.safely(() => this.refresh(t, head));
  }

  private async onLog(log: RpcLog, byAddr: Map<string, { tenantId: string; orderId: string; attemptId: string; depositAddress: string }>) {
    if (log.removed || log.topics.length !== 3 || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) return; // not an ERC-20 transfer
    const dep = byAddr.get(`0x${(log.topics[2] as string).slice(26).toLowerCase()}`);
    if (!dep) return;
    const key = `${log.transactionHash}:${num(log.logIndex)}`.toLowerCase();
    if (this.ignored.has(key)) return;
    const blockNumber = num(log.blockNumber);
    const block = await this.o.rpc.call<RpcBlock | null>('eth_getBlockByNumber', [hex(blockNumber), false]);
    if (!block || block.hash.toLowerCase() !== log.blockHash.toLowerCase()) return; // reorged mid-read: next tick re-reads it

    const existing = this.tracked.get(key);
    if (existing) { // same transfer, re-included in a different block after a reorg
      existing.blockNumber = blockNumber; existing.blockHash = log.blockHash; existing.blockTimestamp = new Date(num(block.timestamp) * 1000);
      return;
    }
    const contract = log.address.toLowerCase();
    if (!this.o.chain.tokens.some((t) => t.contract.toLowerCase() === contract)) {
      await this.o.svc.markAssetMismatch(dep.tenantId, dep.attemptId, 'UNSUPPORTED_TOKEN', key);
      this.ignored.add(key);
      return;
    }
    // The deposit attempt carries the FIRST transfer. Any further transfer is its own attempt,
    // so a second payment is visible (and flagged) instead of being swallowed.
    let attemptId = dep.attemptId;
    if (this.boundAttempts.has(attemptId)) attemptId = await this.o.svc.createAttempt(dep.tenantId, dep.orderId, 'CHAIN');
    this.boundAttempts.add(attemptId);
    this.tracked.set(key, { key, tenantId: dep.tenantId, attemptId, contract, amountMinor: BigInt(log.data), blockNumber, blockHash: log.blockHash,
      blockTimestamp: new Date(num(block.timestamp) * 1000), lastSent: null, goneSince: null });
  }

  private async refresh(t: Tracked, head: number) {
    const block = await this.o.rpc.call<RpcBlock | null>('eth_getBlockByNumber', [hex(t.blockNumber), false]);
    const removed = !block || block.hash.toLowerCase() !== t.blockHash.toLowerCase();
    const confirmations = removed ? 0 : Math.max(0, head - t.blockNumber + 1);
    const c = classifyTransfer({ chainId: this.o.chain.chainId, tokenContract: t.contract, amountMinor: t.amountMinor, confirmations, reverted: false, removed }, this.o.chain);
    if (c.kind !== 'STATUS') return;
    let status: string = c.status;
    if (removed) {
      t.goneSince ??= head;
      if (head - t.goneSince >= this.o.dropAfterBlocks) status = 'FAILED'; // never came back: the transfer is gone
    } else t.goneSince = null;
    if (status === t.lastSent) { if (status === 'SUCCESS' || status === 'FAILED') this.tracked.delete(t.key); return; }
    await this.o.svc.ingestEvent(t.tenantId, t.attemptId, {
      source: 'CHAIN_OBSERVER', toStatus: status as 'PENDING' | 'CONFIRMING' | 'SUCCESS' | 'FAILED',
      ...(status === 'SUCCESS' ? { amountMinor: t.amountMinor, paidAt: t.blockTimestamp } : {}),
    });
    t.lastSent = status;
    if (status === 'SUCCESS' || status === 'FAILED') this.tracked.delete(t.key);
  }

  /** One bad transfer must never stop the watcher from processing the others. */
  private async safely(fn: () => Promise<void>) {
    try { await fn(); } catch (e) { if (this.o.onError) this.o.onError(e); else throw e; }
  }
}
