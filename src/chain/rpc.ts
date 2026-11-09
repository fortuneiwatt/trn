/** Minimal JSON-RPC client surface. The watcher depends on this interface, never on a vendor SDK. */
export interface Rpc {
  call<T = unknown>(method: string, params: unknown[]): Promise<T>;
}

/** Zero-dependency HTTP JSON-RPC client with a timeout. Works with anvil, Sepolia, or any EVM node. */
export class HttpRpc implements Rpc {
  private id = 0;
  constructor(private url: string, private timeoutMs = 10_000) {}
  async call<T = unknown>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const j = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (j.error) throw new Error(`RPC ${method} failed: ${j.error.message}`);
    return j.result as T;
  }
}
