/**
 * ElectrumX WebSocket client.
 *
 * Speaks JSON-RPC 2.0 over a single wss connection, with automatic reconnect
 * (exponential backoff + jitter), per-request timeouts, and scripthash
 * subscriptions. Isomorphic: uses the global `WebSocket` in browsers / modern
 * Node, and lazily imports the `ws` package on older Node.
 *
 * High-level helpers return SDK types (photons as BigInt). All scripthash
 * methods also accept a plain address for convenience.
 */

import {
  DEFAULT_ELECTRUM_ENDPOINT,
  DEFAULT_REQUEST_TIMEOUT_MS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
} from "./constants.js";
import { ElectrumError } from "./errors.js";
import { addressToScriptHash, p2pkhScript } from "./script.js";
import type {
  NetworkName,
  ScriptHashBalance,
  Utxo,
} from "./types.js";

/** A minimal structural type for the WebSocket implementations we accept. */
interface MinimalWebSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (ev: any) => void): void;
  readonly readyState: number;
}
type WebSocketCtor = new (url: string) => MinimalWebSocket;

/** Raw `listunspent` entry as returned by ElectrumX. */
interface RawUnspent {
  tx_hash: string;
  tx_pos: number;
  height: number;
  value: number;
  refs?: { ref: string; type: string }[];
}

/** Options for {@link ElectrumClient}. */
export interface ElectrumClientOptions {
  /** Full wss/ws endpoint. Overrides `network`'s default if given. */
  endpoint?: string;
  /** Network whose default endpoint to use when `endpoint` is omitted. */
  network?: NetworkName;
  /** Per-request timeout in ms. Default 15,000. */
  requestTimeoutMs?: number;
  /** Auto-reconnect on close. Default true. */
  reconnect?: boolean;
  /** Inject a WebSocket constructor (tests, custom transports). */
  webSocketCtor?: WebSocketCtor;
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type SubscriptionHandler = (params: unknown[]) => void;

const WS_OPEN = 1;

/**
 * Connect-on-demand ElectrumX client.
 *
 * @example
 * const client = new ElectrumClient({ network: "mainnet" });
 * await client.connect();
 * const bal = await client.getBalance(address);
 */
export class ElectrumClient {
  readonly endpoint: string;
  private readonly requestTimeoutMs: number;
  private readonly autoReconnect: boolean;
  private readonly injectedCtor?: WebSocketCtor;

  private ws?: MinimalWebSocket;
  private ctor?: WebSocketCtor;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly subscriptions = new Map<string, SubscriptionHandler>();
  private connectPromise?: Promise<void>;
  private reconnectAttempts = 0;
  private closedByUser = false;

  constructor(options: ElectrumClientOptions = {}) {
    const network = options.network ?? "mainnet";
    this.endpoint = options.endpoint ?? DEFAULT_ELECTRUM_ENDPOINT[network];
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.autoReconnect = options.reconnect ?? true;
    this.injectedCtor = options.webSocketCtor;
  }

  /** True if the socket is open and ready. */
  get connected(): boolean {
    return this.ws?.readyState === WS_OPEN;
  }

  /** Open the connection (idempotent). Resolves once the socket is ready. */
  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;
    this.closedByUser = false;
    this.connectPromise = this.openSocket();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = undefined;
    }
  }

  private async resolveCtor(): Promise<WebSocketCtor> {
    if (this.ctor) return this.ctor;
    if (this.injectedCtor) return (this.ctor = this.injectedCtor);
    const g = globalThis as { WebSocket?: WebSocketCtor };
    if (typeof g.WebSocket !== "undefined") {
      return (this.ctor = g.WebSocket);
    }
    // Node without a global WebSocket: fall back to the `ws` package.
    try {
      const mod: any = await import("ws");
      return (this.ctor = (mod.default ?? mod) as WebSocketCtor);
    } catch {
      throw new ElectrumError(
        "No WebSocket implementation available. On Node <22, install the optional `ws` dependency.",
      );
    }
  }

  private async openSocket(): Promise<void> {
    const Ctor = await this.resolveCtor();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new Ctor(this.endpoint);
      this.ws = ws;
      ws.addEventListener("open", () => {
        this.reconnectAttempts = 0;
        settled = true;
        resolve();
      });
      ws.addEventListener("message", (ev: { data: unknown }) =>
        this.onMessage(ev.data),
      );
      ws.addEventListener("error", (ev: unknown) => {
        if (!settled) {
          settled = true;
          reject(new ElectrumError(`WebSocket error connecting to ${this.endpoint}`));
        }
      });
      ws.addEventListener("close", () => this.onClose());
    });
  }

  private onMessage(data: unknown): void {
    let msg: any;
    try {
      msg = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      return; // ignore non-JSON frames
    }
    const handle = (m: any) => {
      if (m && typeof m.id === "number") {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error) {
          const e = m.error;
          p.reject(new ElectrumError(e?.message ?? String(e), e?.code));
        } else {
          p.resolve(m.result);
        }
      } else if (m && typeof m.method === "string") {
        // Subscription notification: dispatch to the matching handler.
        const handler = this.subscriptions.get(m.method);
        if (handler) handler(Array.isArray(m.params) ? m.params : []);
      }
    };
    if (Array.isArray(msg)) msg.forEach(handle);
    else handle(msg);
  }

  private onClose(): void {
    // Fail all in-flight requests; they can be retried after reconnect.
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new ElectrumError("Connection closed"));
    }
    this.pending.clear();
    this.ws = undefined;
    if (this.closedByUser || !this.autoReconnect) return;
    const delay = this.nextReconnectDelay();
    setTimeout(() => {
      this.connect().catch(() => {
        /* next close will schedule another attempt */
      });
    }, delay);
  }

  /** Exponential backoff with full jitter, capped at RECONNECT_MAX_MS. */
  private nextReconnectDelay(): number {
    const capped = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempts,
    );
    this.reconnectAttempts++;
    return capped / 2 + Math.random() * (capped / 2);
  }

  /** Send a JSON-RPC request and await its result. */
  async request<T = unknown>(method: string, ...params: unknown[]): Promise<T> {
    if (!this.connected) await this.connect();
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ElectrumError(`Request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      try {
        this.ws!.send(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new ElectrumError(`Failed to send ${method}: ${String(err)}`));
      }
    });
  }

  // ---- Server info ----------------------------------------------------------

  /** Negotiate protocol version. */
  async serverVersion(
    client = "@radiant-core/sdk",
    protocol: [string, string] | string = ["1.4", "1.4.3"],
  ): Promise<unknown> {
    return this.request("server.version", client, protocol);
  }

  // ---- Scripthash queries ---------------------------------------------------

  private toScriptHash(addressOrScriptHash: string): string {
    // A 64-hex string is already a scripthash; otherwise treat it as an address.
    return /^[0-9a-fA-F]{64}$/.test(addressOrScriptHash)
      ? addressOrScriptHash.toLowerCase()
      : addressToScriptHash(addressOrScriptHash);
  }

  /** Confirmed + unconfirmed balance (photons) for an address or scripthash. */
  async getBalance(addressOrScriptHash: string): Promise<ScriptHashBalance> {
    const sh = this.toScriptHash(addressOrScriptHash);
    const r = await this.request<{ confirmed: number; unconfirmed: number }>(
      "blockchain.scripthash.get_balance",
      sh,
    );
    return {
      confirmed: BigInt(r.confirmed ?? 0),
      unconfirmed: BigInt(r.unconfirmed ?? 0),
    };
  }

  /**
   * Unspent outputs for an address or scripthash, as SDK {@link Utxo}s.
   *
   * NOTE: ElectrumX `listunspent` does not return the output script. When you
   * pass a plain address we fill `script` with that address's P2PKH script
   * (correct for ordinary wallet UTXOs). When you pass a raw scripthash we
   * cannot reconstruct the script, so `script` is left empty — provide the
   * address form if you intend to fund/sign from the result.
   */
  async listUnspent(addressOrScriptHash: string): Promise<Utxo[]> {
    const isAddress = !/^[0-9a-fA-F]{64}$/.test(addressOrScriptHash);
    const sh = this.toScriptHash(addressOrScriptHash);
    const rows = await this.request<RawUnspent[]>(
      "blockchain.scripthash.listunspent",
      sh,
    );
    const script = isAddress ? p2pkhScript(addressOrScriptHash) : "";
    return rows.map((r) => ({
      txid: r.tx_hash,
      vout: r.tx_pos,
      value: BigInt(r.value),
      height: r.height,
      script,
      refs: r.refs,
    }));
  }

  /** Raw transaction history for an address or scripthash. */
  async getHistory(addressOrScriptHash: string): Promise<unknown[]> {
    const sh = this.toScriptHash(addressOrScriptHash);
    return this.request("blockchain.scripthash.get_history", sh);
  }

  /** Fetch a raw transaction (hex, or verbose object when verbose=true). */
  async getTransaction(txid: string, verbose = false): Promise<unknown> {
    return this.request("blockchain.transaction.get", txid, verbose);
  }

  /**
   * Subscribe to an address/scripthash; `onUpdate` fires with the new status
   * hash whenever the set of outputs changes. Returns the current status.
   */
  async subscribe(
    addressOrScriptHash: string,
    onUpdate: (status: string | null) => void,
  ): Promise<string | null> {
    const sh = this.toScriptHash(addressOrScriptHash);
    this.subscriptions.set("blockchain.scripthash.subscribe", (params) => {
      // params = [scripthash, status]
      if (params[0] === sh) onUpdate((params[1] as string) ?? null);
    });
    return this.request("blockchain.scripthash.subscribe", sh);
  }

  /** Stop receiving updates for a scripthash/address. */
  async unsubscribe(addressOrScriptHash: string): Promise<unknown> {
    const sh = this.toScriptHash(addressOrScriptHash);
    this.subscriptions.delete("blockchain.scripthash.subscribe");
    return this.request("blockchain.scripthash.unsubscribe", sh);
  }

  // ---- Broadcast ------------------------------------------------------------

  /**
   * Broadcast a raw transaction (hex). Returns the txid. Treats the node's
   * "transaction already in blockchain" as success (returns the computed txid
   * is the caller's job; here we surface the node's reply).
   */
  async broadcastTx(rawHex: string): Promise<string> {
    try {
      return await this.request<string>(
        "blockchain.transaction.broadcast",
        rawHex,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("transactionalreadyinblockchain")) {
        return "";
      }
      throw err;
    }
  }

  // ---- Lifecycle ------------------------------------------------------------

  /** Close the connection and stop reconnecting. */
  close(): void {
    this.closedByUser = true;
    this.subscriptions.clear();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = undefined;
  }
}
