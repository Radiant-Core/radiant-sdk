/**
 * Script-level primitives: scripthash computation (ElectrumX convention),
 * token-bearing detection, zero-ref normalisation, and ref packing.
 *
 * These mirror the proven Photonic-Wallet implementations. They are pure and
 * dependency-light (only radiantjs for hashing / address->script).
 */

import { Script, sha256 } from "./radiantjs.js";
import {
  INPUT_REF_OP_MIN,
  INPUT_REF_OP_MAX,
} from "./constants.js";
import { ValidationError } from "./errors.js";
import type { NetworkName } from "./types.js";

/** OP codes that consume a signature (used by zeroRefs to detect covenants). */
const CHECKSIG_OPS = new Set<number>([
  0xac, // OP_CHECKSIG
  0xad, // OP_CHECKSIGVERIFY
  0xae, // OP_CHECKMULTISIG
  0xaf, // OP_CHECKMULTISIGVERIFY
]);

/**
 * ElectrumX scripthash: sha256(scriptBytes) reversed, hex.
 * This is the key ElectrumX uses to index an output; it is NOT a txid order.
 */
export function scriptHash(scriptHex: string): string {
  if (!scriptHex) {
    // Hashing the empty script yields a constant that has historically masked
    // upstream bugs (a swallowed exception returning ""). Fail loudly instead.
    throw new ValidationError("scriptHash: cannot hash an empty script");
  }
  return Buffer.from(sha256(Buffer.from(scriptHex, "hex")))
    .reverse()
    .toString("hex");
}

/**
 * Build a P2PKH output script (hex) for an address. The script is
 * network-independent — only the 20-byte pubkey hash matters — so the address
 * is decoded by its version byte without imposing a network (this also avoids
 * the testnet/regtest ambiguity, where both share version byte 0x6f). The
 * `network` parameter is accepted for call-site symmetry but not required.
 */
export function p2pkhScript(address: string, _network?: NetworkName): string {
  try {
    return Script.buildPublicKeyHashOut(address).toHex();
  } catch (err) {
    throw new ValidationError(
      `p2pkhScript: invalid address ${JSON.stringify(address)}: ${String(err)}`,
    );
  }
}

/** Convenience: ElectrumX scripthash for a plain (P2PKH) address. */
export function addressToScriptHash(
  address: string,
  network?: NetworkName,
): string {
  return scriptHash(p2pkhScript(address, network));
}

/**
 * Returns true if a script carries a Glyph token, i.e. it contains an
 * OP_PUSHINPUTREF-family opcode (0xd0-0xd8) in *opcode position*.
 *
 * Critically, this walks the script as an opcode stream and skips push
 * payloads, so a 0xd0-0xd8 byte that merely appears inside a pubkey hash or a
 * data push does NOT trigger a false positive. Spending such a UTXO as
 * discretionary RXD funding would burn the token, so funding selection relies
 * on this check.
 */
export function isTokenBearing(scriptHex: string): boolean {
  if (!scriptHex) return false;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(scriptHex, "hex");
  } catch {
    return false;
  }
  const n = bytes.length;
  let pos = 0;
  while (pos < n) {
    const op = bytes[pos]!;
    if (op >= INPUT_REF_OP_MIN && op <= INPUT_REF_OP_MAX) return true;
    let next: number;
    if (op >= 0x01 && op <= 0x4b) {
      next = pos + 1 + op; // direct push of `op` bytes
    } else if (op === 0x4c) {
      if (pos + 1 >= n) return false; // OP_PUSHDATA1, truncated
      next = pos + 2 + bytes[pos + 1]!;
    } else if (op === 0x4d) {
      if (pos + 2 >= n) return false; // OP_PUSHDATA2 (LE), truncated
      next = pos + 3 + (bytes[pos + 1]! | (bytes[pos + 2]! << 8));
    } else if (op === 0x4e) {
      if (pos + 4 >= n) return false; // OP_PUSHDATA4 (LE), truncated
      next =
        pos +
        5 +
        ((bytes[pos + 1]! |
          (bytes[pos + 2]! << 8) |
          (bytes[pos + 3]! << 16) |
          (bytes[pos + 4]! << 24)) >>>
          0);
    } else {
      next = pos + 1; // non-push opcode, no operand
    }
    if (next <= pos || next > n) return false; // truncated/overrun push
    pos = next;
  }
  return false;
}

/**
 * Zero out the 36-byte operands of OP_PUSHINPUTREF-family opcodes, but only if
 * the script also requires a signature (CHECKSIG). This reproduces how the
 * indexer keys token-gated covenant scripts: a covenant is indexed under its
 * zeroed-ref form, so to look up its UTXOs you must hash scriptHash(zeroRefs(s))
 * rather than the raw script. Plain (non-checksig) ref scripts are returned
 * unchanged.
 */
export function zeroRefs(scriptHex: string): string {
  const script = Buffer.from(scriptHex, "hex");
  const out = Buffer.from(script);
  let requiresSig = false;
  let n = 0;
  while (n < script.length) {
    const op = script[n]!;
    n += 1;
    if (CHECKSIG_OPS.has(op)) {
      requiresSig = true;
    } else if (op >= INPUT_REF_OP_MIN && op <= INPUT_REF_OP_MAX) {
      out.fill(0, n, n + 36); // zero the 36-byte ref operand
      n += 36;
    } else if (op <= 0x4e && op >= 0x01) {
      // Push opcode: skip its data payload.
      let dlen = op;
      if (op === 0x4c) {
        dlen = script[n]!;
        n += 1;
      } else if (op === 0x4d) {
        dlen = script.readUInt16LE(n);
        n += 2;
      } else if (op === 0x4e) {
        dlen = script.readUInt32LE(n);
        n += 4;
      }
      n += dlen;
    }
  }
  return (requiresSig ? out : script).toString("hex");
}

/**
 * Pack an outpoint into a 36-byte Glyph ref (72 hex chars): 32-byte txid in
 * internal (little-endian) order followed by a 4-byte little-endian vout.
 * This is the form consumed by OP_PUSHINPUTREF <ref>.
 */
export function packRef(txid: string, vout: number): string {
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
    throw new ValidationError(`packRef: invalid txid ${JSON.stringify(txid)}`);
  }
  const txidLE = Buffer.from(txid, "hex").reverse(); // display -> internal order
  const voutLE = Buffer.alloc(4);
  voutLE.writeUInt32LE(vout >>> 0, 0);
  return Buffer.concat([txidLE, voutLE]).toString("hex");
}

/** Inverse of packRef: unpack a 72-hex ref into display "txid:vout". */
export function unpackRef(ref: string): { txid: string; vout: number } {
  if (!/^[0-9a-fA-F]{72}$/.test(ref)) {
    throw new ValidationError(`unpackRef: invalid ref ${JSON.stringify(ref)}`);
  }
  const buf = Buffer.from(ref, "hex");
  const txid = Buffer.from(buf.subarray(0, 32)).reverse().toString("hex");
  const vout = buf.readUInt32LE(32);
  return { txid, vout };
}

// ---- Token-script parsing ---------------------------------------------------
//
// These are shape-exact, anchored matchers — deliberately not "find a ref
// anywhere" scans. Knowing that a script IS an NFT (rather than merely
// ref-bearing), and which ref is its SINGLETON, is what makes it safe to rebuild
// a token output or to check that a counterparty's UTXO holds what they claim.
// `parseTokenRef` cannot answer either question: it returns the first ref opcode
// it sees, which on an auth-form NFT is the MUTABLE ref, not the token's.

/** Owner address hash from a bare P2PKH script, if that's all it is. */
export function parseP2pkhScript(scriptHex: string): { addressHash?: string } {
  const [, addressHash] = scriptHex.toLowerCase().match(/^76a914([0-9a-f]{40})88ac$/) || [];
  return { addressHash };
}

/**
 * Parse an NFT output script into its singleton ref + owner hash.
 *
 * Matches the plain singleton:
 *   OP_PUSHINPUTREFSINGLETON <ref> OP_DROP <P2PKH>
 *   d8 <ref:72> 75 76a914 <h160:40> 88ac
 *
 * ...and the AUTH form that a mutable NFT (a WAVE name) is forced into after a
 * target update — the mutable covenant makes the token output re-commit the
 * mutable ref plus its scriptSig hash:
 *   ( OP_REQUIREINPUTREF <ref> <scriptSigHash> OP_2DROP )+ OP_STATESEPARATOR
 *   OP_PUSHINPUTREFSINGLETON <ref> OP_DROP <P2PKH>
 *
 * The singleton ref and owner are always the TRAILING `d8…/p2pkh`, so the
 * optional preamble is skipped without changing what's captured. Returns {} for
 * anything that isn't an NFT script.
 */
export function parseNftScript(scriptHex: string): { ref?: string; addressHash?: string } {
  const pattern = /^(?:d1[0-9a-f]{72}20[0-9a-f]{64}6d)*(?:bd)?d8([0-9a-f]{72})7576a914([0-9a-f]{40})88ac$/;
  const [, ref, addressHash] = scriptHex.toLowerCase().match(pattern) || [];
  return { ref, addressHash };
}

/** Parse an FT output script into its ref + owner hash. Returns {} if not an FT. */
export function parseFtScript(scriptHex: string): { ref?: string; addressHash?: string } {
  const pattern = /^76a914([0-9a-f]{40})88acbdd0([0-9a-f]{72})dec0e9aa76e378e4a269e69d$/;
  const [, addressHash, ref] = scriptHex.toLowerCase().match(pattern) || [];
  return { ref, addressHash };
}

/** What kind of token a script is, if any. */
export type TokenScriptKind = "nft" | "ft" | null;

/** Classify a token output script by SHAPE (not by a loose ref scan). */
export function tokenScriptKind(scriptHex: string): TokenScriptKind {
  if (parseNftScript(scriptHex).ref) return "nft";
  if (parseFtScript(scriptHex).ref) return "ft";
  return null;
}
