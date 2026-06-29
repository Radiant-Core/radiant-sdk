/**
 * Glyph token operations: mint (FT/NFT) and transfer.
 *
 * Glyph uses a commit/reveal two-transaction pattern. The COMMIT output locks
 * to a script that checks the payload hash and the Glyph magic; the REVEAL
 * spends it, carrying the CBOR envelope in its input scriptSig, and produces
 * the token output whose ref equals the commit outpoint. We reproduce the
 * proven Photonic-Wallet on-chain templates here and drive them with the SDK's
 * ref-safe funding selection.
 *
 * IMPORTANT: these are real consensus-level scripts. Validate any new mint flow
 * on regtest/testnet before mainnet — see README.
 */

import { encode as cborEncode } from "cbor-x";
import { Script, Opcode, Address, sha256d } from "./radiantjs.js";
import {
  GLYPH_MAGIC_BYTES,
  GLYPH_PROTOCOL,
  TOKEN_OUTPUT_VALUE,
  DUST_LIMIT,
  MIN_RELAY_FEE_RATE,
  INPUT_REF_OP_MIN,
  INPUT_REF_OP_MAX,
} from "./constants.js";
import { ValidationError } from "./errors.js";
import { selectRxdFunding } from "./utxo.js";
import { packRef, p2pkhScript } from "./script.js";
import { buildTx, type BuildTxInput } from "./tx.js";
import type { ElectrumClient } from "./client.js";
import type { NetworkName, Utxo } from "./types.js";

const MAGIC = Buffer.from(GLYPH_MAGIC_BYTES);

/** A Glyph payload: `p` is the protocol id list, plus free-form metadata. */
export interface GlyphPayload {
  /** Glyph version. Default 2. */
  v?: number;
  /** Protocol ids, e.g. [1]=FT, [2]=NFT, [2,5]=mutable NFT. */
  p: number[];
  [key: string]: unknown;
}

/** Result of a mint: the token ref plus both transaction ids. */
export interface MintResult {
  /** Packed 72-hex token ref (the commit outpoint). */
  ref: string;
  /** Display ref "txid:vout". */
  refDisplay: string;
  commitTxid: string;
  revealTxid: string;
}

/**
 * Encode a Glyph payload into its reveal scriptSig and commit payload hash.
 * revealScriptSig = `<gly> <cbor(payload)>`; payloadHash = sha256d(cbor).
 */
export function encodeGlyph(payload: GlyphPayload): {
  revealScriptSig: string;
  payloadHash: string;
} {
  const encoded = Buffer.from(cborEncode(payload));
  const revealScriptSig = new Script().add(MAGIC).add(encoded).toHex();
  const payloadHash = Buffer.from(sha256d(encoded)).toString("hex");
  return { revealScriptSig, payloadHash };
}

// ---- Script templates (mirrors Photonic-Wallet) -----------------------------

/** Commit script that gates a mint by payload hash + Glyph magic + ref type. */
function commitScript(
  address: string,
  payloadHash: string,
  refType: 1 | 2,
  network: NetworkName,
): string {
  // P2PKH is network-independent; decode by version byte (avoids the
  // testnet/regtest 0x6f ambiguity). `network` is kept for call-site symmetry.
  void network;
  const addr = Address.fromString(address);
  const refOp = refType === 1 ? "OP_1" : "OP_2";
  const script = new Script();
  script
    .add(Opcode.OP_HASH256)
    .add(Buffer.from(payloadHash, "hex"))
    .add(Opcode.OP_EQUALVERIFY)
    .add(MAGIC)
    .add(Opcode.OP_EQUALVERIFY)
    .add(
      Script.fromASM(
        `OP_INPUTINDEX OP_OUTPOINTTXHASH OP_INPUTINDEX OP_OUTPOINTINDEX OP_4 OP_NUM2BIN OP_CAT OP_REFTYPE_OUTPUT ${refOp} OP_NUMEQUALVERIFY`,
      ),
    )
    .add(Script.buildPublicKeyHashOut(addr));
  return script.toHex();
}

/** FT output script: a value-summed ref bound to an owner P2PKH. */
export function ftScript(address: string, ref: string, network: NetworkName = "mainnet"): string {
  // P2PKH is network-independent; decode by version byte (avoids the
  // testnet/regtest 0x6f ambiguity). `network` is kept for call-site symmetry.
  void network;
  const addr = Address.fromString(address);
  const script = Script.buildPublicKeyHashOut(addr).add(
    Script.fromASM(
      `OP_STATESEPARATOR OP_PUSHINPUTREF ${ref} OP_REFOUTPUTCOUNT_OUTPUTS OP_INPUTINDEX OP_CODESCRIPTBYTECODE_UTXO OP_HASH256 OP_DUP OP_CODESCRIPTHASHVALUESUM_UTXOS OP_OVER OP_CODESCRIPTHASHVALUESUM_OUTPUTS OP_GREATERTHANOREQUAL OP_VERIFY OP_CODESCRIPTHASHOUTPUTCOUNT_OUTPUTS OP_NUMEQUALVERIFY`,
    ),
  );
  return script.toHex();
}

/** NFT output script: a singleton ref bound to an owner P2PKH. */
export function nftScript(address: string, ref: string, network: NetworkName = "mainnet"): string {
  // P2PKH is network-independent; decode by version byte (avoids the
  // testnet/regtest 0x6f ambiguity). `network` is kept for call-site symmetry.
  void network;
  const addr = Address.fromString(address);
  const script = Script.fromASM(`OP_PUSHINPUTREFSINGLETON ${ref} OP_DROP`).add(
    Script.buildPublicKeyHashOut(addr),
  );
  return script.toHex();
}

// ---- Ref / owner parsing ----------------------------------------------------

/** Extract the 72-hex packed ref carried by a token script (FT or NFT). */
export function parseTokenRef(scriptHex: string): string | null {
  const bytes = Buffer.from(scriptHex, "hex");
  let pos = 0;
  while (pos < bytes.length) {
    const op = bytes[pos]!;
    if (op >= INPUT_REF_OP_MIN && op <= INPUT_REF_OP_MAX) {
      // The 36-byte ref operand immediately follows the ref opcode.
      if (pos + 1 + 36 > bytes.length) return null;
      return bytes.subarray(pos + 1, pos + 1 + 36).toString("hex");
    }
    // Skip push payloads so a 0xd0-0xd8 inside data isn't misread.
    if (op >= 0x01 && op <= 0x4b) pos += 1 + op;
    else if (op === 0x4c) pos += 2 + (bytes[pos + 1] ?? 0);
    else if (op === 0x4d) pos += 3 + ((bytes[pos + 1] ?? 0) | ((bytes[pos + 2] ?? 0) << 8));
    else if (op === 0x4e)
      pos +=
        5 +
        (((bytes[pos + 1] ?? 0) |
          ((bytes[pos + 2] ?? 0) << 8) |
          ((bytes[pos + 3] ?? 0) << 16) |
          ((bytes[pos + 4] ?? 0) << 24)) >>>
          0);
    else pos += 1;
  }
  return null;
}

/**
 * Re-bind a token script to a new owner by swapping the embedded owner P2PKH
 * (`76a914 <20-byte hash> 88ac`). Kind-agnostic: preserves any covenant
 * preamble exactly, which is the safest way to transfer a token output.
 */
function rebindOwner(scriptHex: string, toAddress: string, network: NetworkName): string {
  void network; // P2PKH hash is network-independent (see p2pkhScript).
  const newPkh = Address.fromString(toAddress).hashBuffer.toString("hex");
  const re = /76a914[0-9a-f]{40}88ac/i;
  const matches = scriptHex.match(new RegExp(re, "gi"));
  if (!matches || matches.length !== 1) {
    throw new ValidationError(
      "rebindOwner: expected exactly one owner P2PKH in the token script",
    );
  }
  return scriptHex.replace(re, `76a914${newPkh}88ac`);
}

// ---- Mint orchestration -----------------------------------------------------

interface BaseMintParams {
  client: ElectrumClient;
  /** Owner address (receives the token; pays the fees). */
  address: string;
  /** Owner WIF. */
  wif: string;
  /** Token-free RXD funding UTXOs for `address`. */
  fundingUtxos: Utxo[];
  /** Fee rate, photons/byte. Defaults to the network min-relay rate. */
  feeRate?: bigint;
  network?: NetworkName;
  /** Extra metadata merged into the Glyph payload (name, desc, attrs, ...). */
  metadata?: Record<string, unknown>;
}

export interface MintFtParams extends BaseMintParams {
  ticker: string;
  /** Token supply in base units. In Glyph FT, amount == output photons. */
  supply: bigint;
}

export interface MintNftParams extends BaseMintParams {
  /** Mark the NFT mutable (p:[2,5]). Default false (immutable singleton). */
  mutable?: boolean;
  /** Carrier value (photons) for the NFT output. Default dust. */
  outputValue?: bigint;
}

/**
 * Run a commit then a reveal, chaining the commit's change output into the
 * reveal so a single funding selection covers both. Returns both txids + ref.
 */
async function commitReveal(
  base: BaseMintParams,
  payload: GlyphPayload,
  refType: 1 | 2,
  buildRevealOutputScript: (ref: string) => string,
  tokenOutputValue: bigint,
): Promise<MintResult> {
  const network = base.network ?? "mainnet";
  const feeRate = base.feeRate ?? MIN_RELAY_FEE_RATE[network];
  const { revealScriptSig, payloadHash } = encodeGlyph(payload);
  const commit = commitScript(base.address, payloadHash, refType, network);

  // Fund the commit so its change output also covers the reveal. The reveal
  // needs: token output value + its own fee. The fee must include the CBOR
  // envelope bytes that ride the reveal input's scriptSig (metadata can be
  // large). We reserve generously; leftover returns as reveal change.
  const envelopeBytes = BigInt(revealScriptSig.length / 2);
  const revealReserve = tokenOutputValue + estimateRevealFee(feeRate, envelopeBytes);
  const commitTarget = TOKEN_OUTPUT_VALUE + revealReserve;

  const selection = selectRxdFunding(base.fundingUtxos, commitTarget, feeRate, {
    baseOutputCount: 1, // the commit carrier output
    withChange: true,
  });

  const commitInputs: BuildTxInput[] = selection.inputs.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    value: u.value,
    script: u.script || undefined,
  }));

  const commitTx = buildTx({
    address: base.address,
    wif: base.wif,
    inputs: commitInputs,
    outputs: [{ script: commit, value: TOKEN_OUTPUT_VALUE }],
    addChange: true,
    feeRate,
    network,
  });

  // Reveal input 1 is the commit's change output (last output, P2PKH to owner).
  const changeIndex = commitTx.outputs.length - 1;
  const change = commitTx.outputs[changeIndex]!;
  if (change.value <= 0n) {
    throw new ValidationError(
      "commitReveal: commit produced no change to fund the reveal",
    );
  }

  await base.client.broadcastTx(commitTx.hex);

  const ref = packRef(commitTx.txid, 0);
  const tokenScript = buildRevealOutputScript(ref);

  const revealTx = buildTx({
    address: base.address,
    wif: base.wif,
    inputs: [
      // input 0: the commit carrier — its scriptSig carries the envelope.
      { txid: commitTx.txid, vout: 0, value: TOKEN_OUTPUT_VALUE, script: commit },
      // input 1: the commit change, funds the token output + fee.
      {
        txid: commitTx.txid,
        vout: changeIndex,
        value: change.value,
        script: change.script,
      },
    ],
    outputs: [{ script: tokenScript, value: tokenOutputValue }],
    addChange: true,
    feeRate,
    network,
    setInputScript: (index, defaultScript) => {
      if (index === 0) {
        // <sig> <pubkey> <gly> <cbor> — append the envelope pushes.
        return defaultScript.toHex() + revealScriptSig;
      }
      return undefined;
    },
  });

  await base.client.broadcastTx(revealTx.hex);

  return {
    ref,
    refDisplay: `${commitTx.txid}:0`,
    commitTxid: commitTx.txid,
    revealTxid: revealTx.txid,
  };
}

/** Rough reveal fee: 2 inputs, 2 outputs, token-script + envelope overhead. */
function estimateRevealFee(feeRate: bigint, envelopeBytes = 0n): bigint {
  // ~10 overhead + 2*148 inputs + 2*200 token/p2pkh outputs (generous) plus the
  // CBOR envelope bytes carried in the reveal input scriptSig.
  return (10n + 2n * 148n + 2n * 200n + envelopeBytes) * feeRate;
}

/** Mint a fungible token (Glyph FT). */
export async function mintFT(params: MintFtParams): Promise<MintResult> {
  if (!params.ticker) throw new ValidationError("mintFT: ticker is required");
  if (params.supply <= 0n) throw new ValidationError("mintFT: supply must be > 0");
  const payload: GlyphPayload = {
    v: 2,
    p: [GLYPH_PROTOCOL.FT],
    ticker: params.ticker,
    ...params.metadata,
  };
  return commitReveal(
    params,
    payload,
    1,
    (ref) => ftScript(params.address, ref, params.network ?? "mainnet"),
    params.supply,
  );
}

/** Mint a non-fungible token (Glyph NFT singleton). */
export async function mintNFT(params: MintNftParams): Promise<MintResult> {
  const p = params.mutable
    ? [GLYPH_PROTOCOL.NFT, GLYPH_PROTOCOL.MUTABLE]
    : [GLYPH_PROTOCOL.NFT];
  const payload: GlyphPayload = { v: 2, p, ...params.metadata };
  const value = params.outputValue ?? DUST_LIMIT;
  return commitReveal(
    params,
    payload,
    2,
    (ref) => nftScript(params.address, ref, params.network ?? "mainnet"),
    value,
  );
}

// ---- Transfer ---------------------------------------------------------------

export interface TransferTokenParams {
  client: ElectrumClient;
  /** Current owner address (signs the token input, pays the fee). */
  address: string;
  /** Current owner WIF. */
  wif: string;
  /** The token UTXO to move (its `script` must be the on-chain token script). */
  tokenUtxo: Utxo;
  /** Recipient address. */
  toAddress: string;
  /** Token-free RXD funding UTXOs for `address` to cover the fee. */
  fundingUtxos: Utxo[];
  feeRate?: bigint;
  network?: NetworkName;
}

/**
 * Transfer a Glyph token (FT or NFT) to a new owner. The token output's value
 * is preserved (for FT this preserves the amount); the covenant preamble is
 * carried forward unchanged and only the owner P2PKH is re-bound.
 */
export async function transferToken(
  params: TransferTokenParams,
): Promise<{ txid: string; hex: string; ref: string | null }> {
  const network = params.network ?? "mainnet";
  const feeRate = params.feeRate ?? MIN_RELAY_FEE_RATE[network];
  const { tokenUtxo } = params;

  if (!tokenUtxo.script) {
    throw new ValidationError(
      "transferToken: tokenUtxo.script is required to rebuild the token output",
    );
  }
  const newScript = rebindOwner(tokenUtxo.script, params.toAddress, network);
  const ref = parseTokenRef(tokenUtxo.script);

  // Fund just the fee; the token value is conserved input -> output.
  const selection = selectRxdFunding(params.fundingUtxos, 0n, feeRate, {
    baseOutputCount: 1, // the token output
    extraInputBytes: 148n, // the token input we add below
    withChange: true,
  });

  const inputs: BuildTxInput[] = [
    {
      txid: tokenUtxo.txid,
      vout: tokenUtxo.vout,
      value: tokenUtxo.value,
      script: tokenUtxo.script,
    },
    ...selection.inputs.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: u.value,
      script: u.script || undefined,
    })),
  ];

  const built = buildTx({
    address: params.address,
    wif: params.wif,
    inputs,
    outputs: [{ script: newScript, value: tokenUtxo.value }],
    addChange: true,
    feeRate,
    network,
  });

  await params.client.broadcastTx(built.hex);
  return { txid: built.txid, hex: built.hex, ref };
}
