/**
 * Ref-safe UTXO selection.
 *
 * THE invariant of this module (and the whole reason it exists): RXD funding is
 * NEVER gathered by a pure value heuristic. A UTXO that carries a token ref
 * (FT/NFT/dMint) looks like ordinary value to a naive selector, but spending it
 * as discretionary funding silently and irreversibly BURNS the token. So every
 * candidate is screened two ways — indexer-reported `refs`, and a local script
 * scan (isTokenBearing) — before it can fund a transaction.
 *
 * Mirrors Photonic-Wallet's `selectRxdFunding` / `fundTx` behaviour.
 */

import { isTokenBearing } from "./script.js";
import { InsufficientFundsError, TokenBurnGuardError } from "./errors.js";
import type { FundingSelection, Utxo } from "./types.js";

/** Rough byte sizes for fee estimation (P2PKH). */
const TX_OVERHEAD_BYTES = 10n; // version + locktime + in/out counts
const P2PKH_INPUT_BYTES = 148n; // prevout(36) + seq(4) + scriptSig(~107) + len
const P2PKH_OUTPUT_BYTES = 34n; // value(8) + script(25) + len

/**
 * Extra bytes added when *reserving* funding, so the selected inputs always
 * cover what the builder actually pays. The builder sets the real fee from the
 * measured signed size (+ headroom); token output scripts are also larger than
 * the P2PKH assumption above. This margin only widens input selection — the
 * surplus returns as change, so it costs the user nothing.
 */
const SELECTION_HEADROOM_BYTES = 160n;

/** Options for {@link selectRxdFunding}. */
export interface SelectRxdFundingOptions {
  /**
   * Number of non-funding outputs the final tx will already have (e.g. the
   * recipient/token output). Used for fee estimation. Default 1.
   */
  baseOutputCount?: number;
  /**
   * Bytes contributed by inputs the caller has already committed (e.g. a token
   * input being spent deliberately). Added to the fee estimate. Default 0.
   */
  extraInputBytes?: bigint;
  /** Whether a change output will be added (affects fee estimate). Default true. */
  withChange?: boolean;
}

/**
 * Is this UTXO safe to spend as plain RXD funding? It must carry no indexer
 * refs and no OP_PUSHINPUTREF opcodes in its script.
 */
export function isFundingSafe(utxo: Utxo): boolean {
  if (utxo.refs && utxo.refs.length > 0) return false;
  if (isTokenBearing(utxo.script)) return false;
  return true;
}

/**
 * Filter a UTXO set down to token-free funding candidates.
 * Use this any time you need "spendable RXD" rather than "all my UTXOs".
 */
export function filterFundingCandidates(utxos: Utxo[]): Utxo[] {
  return utxos.filter(isFundingSafe);
}

/**
 * Strict guard: throw {@link TokenBurnGuardError} on the first token-bearing
 * UTXO. Use this when you have *already* segregated funding and want to assert
 * the invariant loudly (e.g. before signing a hand-built transaction).
 * {@link selectRxdFunding} does not need this — it excludes token UTXOs itself.
 */
export function assertFundingSafe(utxos: Utxo[]): void {
  for (const u of utxos) {
    if (!isFundingSafe(u)) throw new TokenBurnGuardError(u.txid, u.vout);
  }
}

/** Estimate the fee (photons) for a tx with the given input/output counts. */
export function estimateFee(
  inputCount: number,
  outputCount: number,
  feeRate: bigint,
  extraInputBytes = 0n,
): bigint {
  const bytes =
    TX_OVERHEAD_BYTES +
    P2PKH_INPUT_BYTES * BigInt(inputCount) +
    P2PKH_OUTPUT_BYTES * BigInt(outputCount) +
    extraInputBytes;
  return bytes * feeRate;
}

/**
 * Select RXD funding inputs to cover `target` photons plus fees, **excluding
 * every token-bearing UTXO** (the ref-safe guarantee). You can hand this the
 * raw output of `listUnspent` — token UTXOs are dropped, never spent. Greedy:
 * largest token-free UTXOs first, accumulating until target + fee is met. The
 * fee grows with each input added.
 *
 * @throws {InsufficientFundsError} if token-free UTXOs cannot cover the target.
 */
export function selectRxdFunding(
  utxos: Utxo[],
  target: bigint,
  feeRate: bigint,
  options: SelectRxdFundingOptions = {},
): FundingSelection {
  const baseOutputCount = options.baseOutputCount ?? 1;
  const extraInputBytes = options.extraInputBytes ?? 0n;
  const withChange = options.withChange ?? true;

  // Drop token-bearing UTXOs up front — spending one as funding burns it.
  // Largest first — fewest inputs, lowest fee for typical funding.
  const candidates = filterFundingCandidates(utxos).sort((a, b) =>
    a.value < b.value ? 1 : a.value > b.value ? -1 : 0,
  );

  const reserveBytes = extraInputBytes + SELECTION_HEADROOM_BYTES;
  const selected: Utxo[] = [];
  let total = 0n;
  for (const u of candidates) {
    selected.push(u);
    total += u.value;
    const outputs = baseOutputCount + (withChange ? 1 : 0);
    const fee = estimateFee(selected.length, outputs, feeRate, reserveBytes);
    if (total >= target + fee) {
      return { inputs: selected, fee, total, change: total - target - fee };
    }
  }

  const available = candidates.reduce((s, u) => s + u.value, 0n);
  const finalFee = estimateFee(
    Math.max(selected.length, 1),
    baseOutputCount + (withChange ? 1 : 0),
    feeRate,
    reserveBytes,
  );
  throw new InsufficientFundsError(target + finalFee, available);
}

/** Sum the photon value of a UTXO list. */
export function sumValue(utxos: Utxo[]): bigint {
  return utxos.reduce((s, u) => s + u.value, 0n);
}
