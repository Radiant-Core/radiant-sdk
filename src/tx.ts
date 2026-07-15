/**
 * Transaction building primitive.
 *
 * A thin, faithful port of Photonic-Wallet's `buildTx`: it wraps radiantjs
 * (which does the real script/sighash work) and adds two things the SDK needs —
 * BigInt photon values and a per-input scriptSig hook used by the Glyph
 * commit/reveal flow. Everything signs with SIGHASH_ALL | FORKID.
 */

import {
  Transaction,
  Script,
  PrivateKey,
  crypto,
  SIGHASH_FORKID_ALL,
} from "./radiantjs.js";
import { selectRxdFunding } from "./utxo.js";
import { p2pkhScript } from "./script.js";
import { ValidationError } from "./errors.js";
import { MAX_REASONABLE_FEE_RATE } from "./constants.js";
import type { NetworkName, TxOutput, Utxo } from "./types.js";

/**
 * Refuse to hand miners an absurd fee.
 *
 * Nothing else catches this. A fee is just "inputs minus outputs", so every way
 * of getting it wrong looks like a perfectly valid transaction:
 *
 *  - Unit confusion. Radiant's floor is 10,000 photons/BYTE; the same number as
 *    sats/kB is off by 1,000x, and the tx still broadcasts — it just pays a
 *    thousand times over.
 *  - No change output. With `addChange: false`, the ENTIRE excess over the
 *    outputs is the fee. Over-fund by an RXD and you have donated an RXD.
 *  - Sub-dust change. radiantjs silently DROPS a change output below its dust
 *    threshold and rolls it into the fee instead (transaction.js: `if
 *    (changeAmount >= Transaction.DUST_AMOUNT)`), so the last few hundred
 *    photons vanish quietly.
 *
 * All of these are one-way: once mined, the money is the miner's. So we compare
 * the real fee against `size * MAX_REASONABLE_FEE_RATE` (2x the network floor)
 * and throw rather than broadcast. The 20% tolerance absorbs the size headroom
 * buildTx adds; it is a unit-confusion guard, not relay policy.
 */
function assertSaneFee(tx: any, network: NetworkName): void {
  const sizeBytes = BigInt(tx.toString().length / 2);
  // Measured against the NETWORK ceiling, deliberately not the caller's rate.
  // Trusting `feeRate` here would defeat the guard entirely: a units slip *is* a
  // wrong feeRate, so a reference derived from it would move to meet the mistake
  // and wave it through. A caller that genuinely wants >2x the floor has to say
  // so somewhere this function can't be fooled by.
  const reference = MAX_REASONABLE_FEE_RATE[network];
  const ceiling = (sizeBytes * reference * 12n) / 10n; // +20% for size headroom
  const actual = BigInt(tx.getFee?.() ?? 0);
  if (actual > ceiling) {
    throw new ValidationError(
      `buildTx: fee ${actual} photons is above the sanity ceiling ${ceiling} for a ${sizeBytes}-byte tx ` +
        `(${network} reference ${reference} photons/byte). Refusing to build — this is almost always a units ` +
        `mistake or an over-funded change-less tx, and the excess would be paid to miners irrecoverably.`,
    );
  }
}

/** An input to {@link buildTx}. Provide `script` for non-default (token) inputs. */
export interface BuildTxInput {
  txid: string;
  vout: number;
  value: bigint;
  /** Prevout scriptPubKey hex. If omitted, treated as P2PKH for `address`. */
  script?: string;
}

/** Per-input scriptSig override, called after the default sig+pubkey is built. */
export type SetInputScript = (
  index: number,
  defaultScript: any,
) => any | string | void;

export interface BuildTxParams {
  /** Change address and default signer/owner address. */
  address: string;
  /** Signing key(s) as WIF. A single WIF signs all inputs. */
  wif: string | string[];
  inputs: BuildTxInput[];
  outputs: TxOutput[];
  /** Append a change output back to `address`. Default true. */
  addChange?: boolean;
  /** Fee rate, photons/byte. */
  feeRate: bigint;
  /** Network (for address/change encoding). Default "mainnet". */
  network?: NetworkName;
  /** Override the scriptSig for specific inputs (Glyph reveal uses this). */
  setInputScript?: SetInputScript;
}

/** A signed transaction ready to broadcast. */
export interface BuiltTx {
  /** The radiantjs Transaction object (escape hatch). */
  tx: any;
  /** Serialised raw transaction hex. */
  hex: string;
  /** Transaction id (display order). */
  txid: string;
  /** Outputs, with resolved photon values (includes any change). */
  outputs: { script: string; value: bigint }[];
}

/** BN from a (possibly large) photon value, avoiding JS number precision loss. */
function bn(value: bigint): any {
  return new crypto.BN(value.toString());
}

/** Apply a photons/byte fee rate to a radiantjs tx (feature-detected). */
function applyFeeRate(tx: any, feeRate: bigint): void {
  const rate = Number(feeRate);
  if (typeof tx.feePerByte === "function") {
    tx.feePerByte(rate);
  } else if (typeof tx.feePerKb === "function") {
    tx.feePerKb(rate * 1000);
  }
}

/**
 * Build and sign a transaction. Inputs with a `script` are added manually and
 * signed via a scriptSig callback; inputs without are added as standard P2PKH.
 */
export function buildTx(params: BuildTxParams): BuiltTx {
  const {
    address,
    inputs,
    outputs,
    feeRate,
    addChange = true,
    network = "mainnet",
  } = params;

  const wifs = Array.isArray(params.wif) ? params.wif : [params.wif];
  const privKeys = wifs.map((w) => PrivateKey.fromWIF(w));
  const ownerP2pkh = p2pkhScript(address, network);

  const tx = new Transaction();
  applyFeeRate(tx, feeRate);

  inputs.forEach((input, index) => {
    const prevScript = input.script ?? ownerP2pkh;
    tx.addInput(
      new Transaction.Input({
        prevTxId: input.txid,
        outputIndex: input.vout,
        script: new Script(),
        output: new Transaction.Output({
          script: Script.fromHex(prevScript),
          satoshis: bn(input.value),
        }),
      }),
    );
    tx.setInputScript(index, (_tx: any, output: any) => {
      const privKey = privKeys[index] ?? privKeys[0];
      const sigType = SIGHASH_FORKID_ALL;
      const sig = Transaction.Sighash.sign(
        tx,
        privKey,
        sigType,
        index,
        output.script,
        bn(input.value),
      );
      const spend = Script.empty()
        .add(Buffer.concat([sig.toBuffer(), Buffer.from([sigType])]))
        .add(privKey.toPublicKey().toBuffer());
      if (params.setInputScript) {
        const overridden = params.setInputScript(index, spend);
        if (overridden) {
          return typeof overridden === "string"
            ? overridden
            : overridden.toString();
        }
      }
      return spend.toString();
    });
  });

  outputs.forEach(({ script, value }) => {
    tx.addOutput(
      new Transaction.Output({ script: Script.fromHex(script), satoshis: bn(value) }),
    );
  });

  // Every input is signed by its setInputScript hook during serialisation, so
  // `tx.toString()` yields a fully signed tx. radiantjs's own change-based fee
  // estimator under-sizes non-standard token inputs (the reveal carrier's
  // scriptSig holds the whole CBOR envelope) and otherwise sits exactly on the
  // min-relay boundary. So when there is a change output we measure the REAL
  // signed size and set an explicit fee of (size + headroom) * feeRate, which
  // guarantees the tx clears the node's min-relay floor.
  if (addChange) {
    tx.change(address);
    const probe: string = tx.toString();
    const sizeBytes = BigInt(probe.length / 2);
    const fee = (sizeBytes + 20n) * feeRate; // +20 bytes of headroom
    tx.fee(Number(fee));
    tx.change(address); // recompute change against the explicit fee
  }

  // Sign standard (from-style) inputs; manual inputs are handled by the hooks.
  tx.sign(privKeys[0]);
  if (typeof tx.seal === "function") tx.seal();

  assertSaneFee(tx, network);

  const hex: string = tx.toString();
  const resolvedOutputs = tx.outputs.map((o: any) => ({
    script: o.script.toHex(),
    value: BigInt(o.satoshis?.toString?.() ?? o.satoshis),
  }));

  return { tx, hex, txid: tx.id, outputs: resolvedOutputs };
}

/**
 * Build a simple RXD payment: pay `amount` photons to `to`, funded ref-safely
 * from `utxos`, change back to `address`.
 */
export function buildRxdTransfer(params: {
  address: string;
  wif: string;
  to: string;
  amount: bigint;
  utxos: Utxo[];
  feeRate: bigint;
  network?: NetworkName;
}): BuiltTx {
  const { address, wif, to, amount, utxos, feeRate, network = "mainnet" } = params;
  if (amount <= 0n) throw new ValidationError("buildRxdTransfer: amount must be > 0");

  const selection = selectRxdFunding(utxos, amount, feeRate, {
    baseOutputCount: 1, // the recipient output
    withChange: true,
  });

  const inputs: BuildTxInput[] = selection.inputs.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    value: u.value,
    script: u.script || undefined,
  }));

  return buildTx({
    address,
    wif,
    inputs,
    outputs: [{ script: p2pkhScript(to, network), value: amount }],
    addChange: true,
    feeRate,
    network,
  });
}
