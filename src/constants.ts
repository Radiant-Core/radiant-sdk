/**
 * Network constants, default endpoints, and protocol parameters.
 *
 * Sources of truth (verified against the Radiant ecosystem, 2026-06):
 * - Min-relay fee: 10,000 photons/byte on every network since the V2 upgrade
 *   (activation height differs per chain). Pin these; do not "tune" them.
 * - HD coin type: SLIP-0044 512 (Radiant), default since radiantjs v3.0.0.
 * - Public ElectrumX is reachable on :443 only (Caddy TLS terminates to the
 *   indexer). 50010-50012 are firewalled off the public host.
 * - WAVE/Glyph REST lives behind https://radiantcore.org/api.
 */

import type { NetworkName } from "./types.js";

/** Base unit of Radiant. 1 RXD = 100,000,000 photons. */
export const PHOTONS_PER_RXD = 100_000_000n;

/** SLIP-0044 registered coin type for Radiant. */
export const RADIANT_COIN_TYPE = 512;

/**
 * Min-relay fee rate in photons per byte, keyed by network.
 *
 * 10,000 on EVERY network since the V2 upgrade. V2 raised the protocol floor
 * from 1,000 to 10,000 on all four chains — it just activates at a different
 * height each (mainnet 410,000, testnet 1,000, regtest 200), and only after a
 * further 5,000-block grace period.
 *
 * Test networks are NOT exempt. They were listed at 1,000 here on the
 * assumption the raise was mainnet-only; past activation+grace those chains
 * reject a 1,000 transaction with "min relay fee not met (code 66)".
 *
 * Nor can a node opt out: radiantd's `GetEffectiveMinRelayFee` returns
 * `max(-minrelaytxfee, floor)`, so the flag can only raise the floor.
 */
export const MIN_RELAY_FEE_RATE: Record<NetworkName, bigint> = {
  mainnet: 10_000n,
  testnet: 10_000n,
  regtest: 10_000n,
};

/**
 * Upper sanity bound for {@link MIN_RELAY_FEE_RATE}, in photons/byte — 2x the
 * network floor. Derived, so the two can never drift apart.
 *
 * This is NOT a policy limit; it's the reference `buildTx`'s fee guard measures
 * against. It exists to catch unit confusion (paying sats/kB where photons/byte
 * is meant is a 1,000x error) and over-funded change-less transactions, both of
 * which otherwise hand the whole difference to miners with no error at all.
 */
export const MAX_REASONABLE_FEE_RATE: Record<NetworkName, bigint> = {
  mainnet: MIN_RELAY_FEE_RATE.mainnet * 2n,
  testnet: MIN_RELAY_FEE_RATE.testnet * 2n,
  regtest: MIN_RELAY_FEE_RATE.regtest * 2n,
};

/**
 * Dust limit in photons. Outputs below this are non-standard. Token-carrying
 * outputs typically ride at exactly the dust value.
 */
export const DUST_LIMIT = 1_000n;

/** Default value (photons) assigned to a Glyph commit/reveal carrier output. */
export const TOKEN_OUTPUT_VALUE = 1n;

/** Default public ElectrumX WebSocket endpoints, keyed by network. */
export const DEFAULT_ELECTRUM_ENDPOINT: Record<NetworkName, string> = {
  mainnet: "wss://electrumx.radiantcore.org:443",
  // Adjust to your own infra; no canonical public testnet/regtest endpoint.
  testnet: "wss://electrumx.radiantcore.org:443",
  regtest: "ws://localhost:50011",
};

/** Default RXinDexer REST base used for WAVE name resolution. */
export const DEFAULT_REST_BASE = "https://radiantcore.org/api";

/** Glyph protocol magic bytes ("gly") that prefix every payload envelope. */
export const GLYPH_MAGIC_BYTES = Uint8Array.from([0x67, 0x6c, 0x79]);

/** Glyph protocol identifiers (the `p` field of a payload). */
export const GLYPH_PROTOCOL = {
  FT: 1,
  NFT: 2,
  MUTABLE: 5,
  CONTAINER: 7,
  ENCRYPTED: 8,
  WAVE: 11,
} as const;

/**
 * OP_PUSHINPUTREF family opcode range (0xd0-0xd8). The presence of any of these
 * in opcode position is what makes a UTXO "token-bearing" — see isTokenBearing.
 */
export const INPUT_REF_OP_MIN = 0xd0;
export const INPUT_REF_OP_MAX = 0xd8;

/** WebSocket reconnect backoff bounds (milliseconds). */
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

/** Default per-request timeout for ElectrumX JSON-RPC calls (milliseconds). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
