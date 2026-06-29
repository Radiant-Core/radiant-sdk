/** Shared public types for the Radiant SDK. */

/** Supported Radiant networks. */
export type NetworkName = "mainnet" | "testnet" | "regtest";

/**
 * A reference carried by a token output. Reported by ElectrumX `listunspent`
 * in display form ("txid:vout"). Any UTXO that carries refs is token-bearing
 * and must NEVER be used as discretionary RXD funding.
 */
export interface UtxoRef {
  /** Display-order ref, "txid:vout". */
  ref: string;
  /** Indexer-classified type, e.g. "nft" | "ft" | "dmint". */
  type: string;
}

/**
 * A spendable output. `value` is in photons (BigInt). `script` is the output
 * scriptPubKey as hex — required for ref-safety analysis and signing.
 */
export interface Utxo {
  /** Transaction id in display (big-endian) order. */
  txid: string;
  /** Output index. */
  vout: number;
  /** Value in photons. */
  value: bigint;
  /** Output scriptPubKey, hex. */
  script: string;
  /** Confirmation height; 0 (or undefined) means unconfirmed/mempool. */
  height?: number;
  /** Token refs attached to this output, if any (from the indexer). */
  refs?: UtxoRef[];
}

/** A transaction output to be created. `value` is in photons. */
export interface TxOutput {
  /** Output scriptPubKey, hex. */
  script: string;
  /** Value in photons. */
  value: bigint;
}

/** Result of a ref-safe funding selection. */
export interface FundingSelection {
  /** Chosen funding inputs (all guaranteed token-free). */
  inputs: Utxo[];
  /** Estimated fee in photons for the resulting transaction. */
  fee: bigint;
  /** Sum of selected input values, photons. */
  total: bigint;
  /** Change left over after target + fee, photons (>= 0). */
  change: bigint;
}

/** ElectrumX scripthash balance reply. */
export interface ScriptHashBalance {
  /** Confirmed balance in photons. */
  confirmed: bigint;
  /** Unconfirmed (mempool) delta in photons; may be negative. */
  unconfirmed: bigint;
}

/** Resolved WAVE name record. */
export interface WaveResolution {
  /** Normalised bare label that was resolved. */
  name: string;
  /** Whether the name is registered. */
  registered: boolean;
  /** Resolution target address, if the name resolves to one. */
  address?: string;
  /** Packed ref of the canonical registration, if any. */
  ref?: string;
  /** Owner scripthash hex, if known. */
  owner?: string;
  /** Expiry (unix seconds) from the zone record, if set. */
  expires?: number;
  /** Raw zone records (free-form). */
  records?: Record<string, unknown>;
  /** The unparsed indexer payload, for advanced callers. */
  raw: unknown;
}
