export interface TokenConfig {
  symbol: string;
  contract: string;
  decimals: number;
}

export interface ChainConfig {
  chainId: number;
  tokens: TokenConfig[];
  minConfirmations: number;
}

export interface ObservedTransfer {
  chainId: number;
  tokenContract: string;
  amountMinor: bigint;
  confirmations: number;
  reverted: boolean; // tx receipt status = 0
  removed: boolean; // dropped from the canonical chain (reorg)
}

export type ChainClassification =
  | { kind: 'WRONG_ASSET'; reason: 'WRONG_NETWORK' | 'UNSUPPORTED_TOKEN' }
  | { kind: 'STATUS'; status: 'PENDING' | 'CONFIRMING' | 'SUCCESS' | 'FAILED' };

export function classifyTransfer(t: ObservedTransfer, cfg: ChainConfig): ChainClassification {
  if (t.chainId !== cfg.chainId) return { kind: 'WRONG_ASSET', reason: 'WRONG_NETWORK' };
  const known = cfg.tokens.some((k) => k.contract.toLowerCase() === t.tokenContract.toLowerCase());
  if (!known) return { kind: 'WRONG_ASSET', reason: 'UNSUPPORTED_TOKEN' };
  if (t.removed) return { kind: 'STATUS', status: 'PENDING' };
  if (t.reverted) return { kind: 'STATUS', status: 'FAILED' };
  if (t.confirmations >= cfg.minConfirmations) return { kind: 'STATUS', status: 'SUCCESS' };
  return { kind: 'STATUS', status: 'CONFIRMING' };
}

const INT8_MAX = 9_223_372_036_854_775_807n; // Postgres bigint / Prisma BigInt

/**
 * Stablecoin amount due for a naira price at a locked rate.
 *   amountKobo:        order price in kobo
 *   rateKoboPerToken:  kobo per 1 whole token (e.g. N1,500 per USDT = 150_000n)
 * Rounds UP so the seller is never underpaid by rounding.
 * Beware: USDT on BNB Chain has 18 decimals. This guard stops int8 overflow;
 * use NUMERIC(78,0) if you ever support 18-decimal tokens.
 */
export function tokenAmountForNaira(amountKobo: bigint, rateKoboPerToken: bigint, decimals: number): bigint {
  if (amountKobo <= 0n || rateKoboPerToken <= 0n) throw new Error('amount and rate must be positive');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('decimals must be an integer between 0 and 36');
  const scale = 10n ** BigInt(decimals);
  const minor = (amountKobo * scale + rateKoboPerToken - 1n) / rateKoboPerToken;
  if (minor > INT8_MAX) throw new Error('token amount exceeds int8; use NUMERIC storage');
  return minor;
}
