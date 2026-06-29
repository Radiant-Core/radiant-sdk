/**
 * HD key derivation for Radiant.
 *
 * Default path: m/44'/512'/account'/change/index — SLIP-0044 coin type 512,
 * the radiantjs v3.0.0+ default. The legacy coin-type-0 path is opt-in.
 *
 * The wallet derives keys; it never talks to the network. Combine it with
 * {@link ElectrumClient} and the tx builders to move funds.
 */

import {
  Mnemonic,
  HDPrivateKey,
  PrivateKey,
  toRjsNetwork,
} from "./radiantjs.js";
import { RADIANT_COIN_TYPE } from "./constants.js";
import { ValidationError } from "./errors.js";
import { addressToScriptHash } from "./script.js";
import type { NetworkName } from "./types.js";

/** Options when constructing an {@link HDWallet}. */
export interface HDWalletOptions {
  /** Network for address encoding. Default "mainnet". */
  network?: NetworkName;
  /** BIP39 passphrase ("25th word"). Default "". */
  passphrase?: string;
  /** Hardened account index. Default 0. */
  account?: number;
  /**
   * SLIP-0044 coin type. Default 512 (Radiant). Pass 0 only to recover legacy
   * wallets created before the coin-type-512 default.
   */
  coinType?: number;
}

/** A derived key bundle for one address index. */
export interface DerivedKey {
  index: number;
  change: number;
  path: string;
  /** WIF private key. */
  wif: string;
  /** Compressed public key, hex. */
  publicKey: string;
  /** Base58Check address. */
  address: string;
  /** ElectrumX scripthash for this address. */
  scriptHash: string;
}

/**
 * BIP44 HD wallet over a single account.
 *
 * @example
 * const wallet = HDWallet.fromMnemonic(mnemonic, { network: "mainnet" });
 * const { address, wif } = wallet.deriveKey(0);
 */
export class HDWallet {
  private readonly root: any; // radiantjs HDPrivateKey (account node)
  readonly network: NetworkName;
  readonly account: number;
  readonly coinType: number;

  private constructor(
    accountNode: any,
    network: NetworkName,
    account: number,
    coinType: number,
  ) {
    this.root = accountNode;
    this.network = network;
    this.account = account;
    this.coinType = coinType;
  }

  /** Create a wallet from a BIP39 mnemonic phrase. */
  static fromMnemonic(
    phrase: string,
    options: HDWalletOptions = {},
  ): HDWallet {
    if (!Mnemonic.isValid(phrase)) {
      throw new ValidationError("fromMnemonic: invalid BIP39 mnemonic");
    }
    const mnemonic = new Mnemonic(phrase);
    const network = options.network ?? "mainnet";
    const rjsNet = toRjsNetwork(network);
    const seed = mnemonic.toSeed(options.passphrase ?? "");
    const master = HDPrivateKey.fromSeed(seed, rjsNet);
    return HDWallet.fromMaster(master, network, options);
  }

  /** Create a wallet from a raw seed (Buffer or hex string). */
  static fromSeed(
    seed: Buffer | string,
    options: HDWalletOptions = {},
  ): HDWallet {
    const network = options.network ?? "mainnet";
    const buf = typeof seed === "string" ? Buffer.from(seed, "hex") : seed;
    const master = HDPrivateKey.fromSeed(buf, toRjsNetwork(network));
    return HDWallet.fromMaster(master, network, options);
  }

  /** Create a wallet from an extended private key (xprv). */
  static fromXprv(xprv: string, options: HDWalletOptions = {}): HDWallet {
    const network = options.network ?? "mainnet";
    const master = new HDPrivateKey(xprv);
    return HDWallet.fromMaster(master, network, options);
  }

  /** Generate a fresh random mnemonic phrase (BIP39, 12 words). */
  static generateMnemonic(): string {
    return Mnemonic.fromRandom().toString();
  }

  private static fromMaster(
    master: any,
    network: NetworkName,
    options: HDWalletOptions,
  ): HDWallet {
    const account = options.account ?? 0;
    const coinType = options.coinType ?? RADIANT_COIN_TYPE;
    // Derive down to the account node: m/44'/coin'/account'
    const accountNode = master.deriveChild(
      `m/44'/${coinType}'/${account}'`,
    );
    return new HDWallet(accountNode, network, account, coinType);
  }

  /** Full derivation path for a given change/index under this account. */
  pathFor(index: number, change = 0): string {
    return `m/44'/${this.coinType}'/${this.account}'/${change}/${index}`;
  }

  /** radiantjs PrivateKey at the given index (default external chain). */
  privateKey(index: number, change = 0): any {
    const node = this.root.deriveChild(change).deriveChild(index);
    return node.privateKey;
  }

  /** Derive a full key bundle (WIF, pubkey, address, scripthash) at an index. */
  deriveKey(index: number, change = 0): DerivedKey {
    const priv: any = this.privateKey(index, change);
    const address: string = priv.toAddress(toRjsNetwork(this.network)).toString();
    return {
      index,
      change,
      path: this.pathFor(index, change),
      wif: priv.toWIF(),
      publicKey: priv.toPublicKey().toString(),
      address,
      scriptHash: addressToScriptHash(address),
    };
  }

  /** Address at an index (external chain by default). */
  address(index = 0, change = 0): string {
    return this.deriveKey(index, change).address;
  }

  /** WIF private key at an index. */
  wif(index = 0, change = 0): string {
    return this.privateKey(index, change).toWIF();
  }

  /** Derive a batch of key bundles [start, start+count). */
  deriveRange(start: number, count: number, change = 0): DerivedKey[] {
    const out: DerivedKey[] = [];
    for (let i = 0; i < count; i++) out.push(this.deriveKey(start + i, change));
    return out;
  }
}

/**
 * Low-level WIF helpers for callers who already manage their own keys and do
 * not need HD derivation.
 */
export const Keys = {
  /** Address (Base58Check) for a WIF private key. */
  addressFromWif(wif: string, network: NetworkName = "mainnet"): string {
    return PrivateKey.fromWIF(wif).toAddress(toRjsNetwork(network)).toString();
  },
  /** Compressed public key hex for a WIF private key. */
  publicKeyFromWif(wif: string): string {
    return PrivateKey.fromWIF(wif).toPublicKey().toString();
  },
  /** ElectrumX scripthash for a WIF private key's P2PKH address. */
  scriptHashFromWif(wif: string, network: NetworkName = "mainnet"): string {
    return addressToScriptHash(this.addressFromWif(wif, network));
  },
};
