/**
 * Single, centralised access point to `@radiant-core/radiantjs`.
 *
 * radiantjs is the low-level tx/script/key library (a Radiant fork of
 * bitcore-lib). We wrap it — never duplicate it. Every other module imports the
 * classes it needs from here so there is exactly one place that knows about the
 * underlying library's loose runtime shape.
 */

import rjs from "@radiant-core/radiantjs";
import type { NetworkName } from "./types.js";

// radiantjs attaches everything onto its single default export object.
export const Address = rjs.Address;
export const HDPrivateKey = rjs.HDPrivateKey;
export const HDPublicKey = rjs.HDPublicKey;
export const PrivateKey = rjs.PrivateKey;
export const PublicKey = rjs.PublicKey;
export const Script = rjs.Script;
export const Opcode = rjs.Opcode;
export const Transaction = rjs.Transaction;
export const Mnemonic = rjs.Mnemonic;
export const Networks = rjs.Networks;
export const crypto = rjs.crypto;

/** The raw radiantjs namespace, for advanced callers that need an escape hatch. */
export const radiantjs = rjs;

/** Map our network name to the radiantjs Networks object. */
export function toRjsNetwork(network: NetworkName): unknown {
  switch (network) {
    case "mainnet":
      return Networks.livenet;
    case "testnet":
      return Networks.testnet;
    case "regtest":
      // radiantjs gates regtest behind an enable flag; turn it on lazily.
      Networks.enableRegtest?.();
      return Networks.regtest;
  }
}

/** sha256(data) -> Buffer, via radiantjs crypto (isomorphic, no extra dep). */
export function sha256(data: Buffer): Buffer {
  return crypto.Hash.sha256(data);
}

/** sha256d(data) -> Buffer. */
export function sha256d(data: Buffer): Buffer {
  return crypto.Hash.sha256sha256(data);
}

/** The SIGHASH flag the SDK signs with: ALL | FORKID (always enforce fork id). */
export const SIGHASH_FORKID_ALL: number =
  crypto.Signature.SIGHASH_ALL | crypto.Signature.SIGHASH_FORKID;
