import { createHash } from 'node:crypto';
import type { Rpc } from '../../src/chain/rpc';
import { TRANSFER_TOPIC } from '../../src/chain/evm-watcher';

export interface FakeLog { address: string; from: string; to: string; amount: bigint; txHash: string; nft?: boolean }
interface Block { number: number; hash: string; timestamp: number; logs: FakeLog[] }
const hex = (n: number) => `0x${n.toString(16)}`;
const pad = (a: string) => `0x${a.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;

/** An in-process EVM JSON-RPC node: mines blocks, reorganises, and can fail on demand. */
export class FakeChain implements Rpc {
  chainId = 31337;
  failNext = 0;
  blocks: Block[];
  private nonce = 0;
  constructor(private nowSec: () => number) { this.blocks = [this.mk(0, [])]; }
  private mk(number: number, logs: FakeLog[]): Block {
    return { number, hash: `0x${createHash('sha256').update(`${number}:${this.nonce++}`).digest('hex')}`, timestamp: this.nowSec(), logs };
  }
  get head() { return this.blocks.length - 1; }
  mine(logs: FakeLog[] = []) { this.blocks.push(this.mk(this.blocks.length, logs)); return this.head; }
  /** Drop the last `depth` blocks and mine replacements (new hashes). `replacement[i]` = logs for the i-th new block. */
  reorg(depth: number, replacement: FakeLog[][] = []) {
    this.blocks.length -= depth;
    const start = this.blocks.length;
    for (let i = 0; i < depth; i++) this.blocks.push(this.mk(start + i, replacement[i] ?? []));
  }
  async call<T>(method: string, params: unknown[]): Promise<T> {
    if (this.failNext > 0) { this.failNext--; throw new Error('simulated RPC outage'); }
    switch (method) {
      case 'eth_chainId': return hex(this.chainId) as T;
      case 'eth_blockNumber': return hex(this.head) as T;
      case 'eth_getBlockByNumber': {
        const b = this.blocks[Number(BigInt(params[0] as string))];
        return (b ? { hash: b.hash, number: hex(b.number), timestamp: hex(b.timestamp) } : null) as T;
      }
      case 'eth_getLogs': {
        const f = params[0] as { fromBlock: string; toBlock: string; topics: (string | string[] | null)[] };
        const lo = Number(BigInt(f.fromBlock)); const hi = Number(BigInt(f.toBlock));
        const toTopics = (f.topics[2] ?? []) as string[];
        const out: unknown[] = [];
        for (const b of this.blocks.slice(lo, hi + 1)) {
          b.logs.forEach((l, i) => {
            if (f.topics[0] !== TRANSFER_TOPIC || !toTopics.map((x) => x.toLowerCase()).includes(pad(l.to))) return;
            out.push({
              address: l.address, topics: l.nft ? [TRANSFER_TOPIC, pad(l.from), pad(l.to), hex(7)] : [TRANSFER_TOPIC, pad(l.from), pad(l.to)],
              data: l.nft ? '0x' : `0x${l.amount.toString(16).padStart(64, '0')}`,
              transactionHash: l.txHash, logIndex: hex(i), blockNumber: hex(b.number), blockHash: b.hash, removed: false,
            });
          });
        }
        return out as T;
      }
      default: throw new Error(`unsupported method ${method}`);
    }
  }
}
