// Unit tests for @radiant-core/sdk. Runs against the built bundle (dist/) so
// CI also validates the build output. Uses Node's built-in test runner — no
// extra dev dependencies. Network/chain behaviour is validated separately
// (regtest + RXinDexer); these cover the pure + radiantjs-backed surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as sdk from "../dist/index.js";

const MN =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

test("units: rxd <-> photons", () => {
  assert.equal(sdk.rxdToPhotons("1.5"), 150000000n);
  assert.equal(sdk.rxdToPhotons(2), 200000000n);
  assert.equal(sdk.photonsToRxd(150000000n), "1.5");
  assert.equal(sdk.photonsToRxd(100000000n), "1.0");
  assert.throws(() => sdk.rxdToPhotons("1.123456789")); // >8 decimals
});

test("refs: pack/unpack roundtrip", () => {
  const packed = sdk.packRef("a".repeat(64), 0);
  assert.equal(packed.length, 72);
  assert.deepEqual(sdk.unpackRef(packed), { txid: "a".repeat(64), vout: 0 });
  assert.equal(sdk.unpackRef(sdk.packRef("ab".repeat(32), 7)).vout, 7);
});

test("isTokenBearing: opcode-position detection, no false positives", () => {
  assert.equal(sdk.isTokenBearing("76a914" + "11".repeat(20) + "88ac"), false);
  assert.equal(sdk.isTokenBearing("d0" + "00".repeat(36)), true); // OP_PUSHINPUTREF
  assert.equal(sdk.isTokenBearing("01d0"), false); // 0xd0 inside a data push
  assert.equal(sdk.isTokenBearing(""), false);
});

test("HDWallet: SLIP-0044 512 derivation", () => {
  const wallet = sdk.HDWallet.fromMnemonic(MN, { network: "mainnet" });
  const k0 = wallet.deriveKey(0);
  assert.equal(k0.path, "m/44'/512'/0'/0/0");
  assert.ok(k0.address.length > 20);
  assert.ok(k0.wif.length > 30);
  assert.match(k0.scriptHash, /^[0-9a-f]{64}$/);
  assert.notEqual(wallet.deriveKey(1).address, k0.address);
  // deterministic
  assert.equal(sdk.HDWallet.fromMnemonic(MN).deriveKey(0).address, k0.address);
  // generated mnemonic is usable
  const gen = sdk.HDWallet.generateMnemonic();
  assert.ok(sdk.HDWallet.fromMnemonic(gen).deriveKey(0).address.length > 0);
});

test("scripthash: addressToScriptHash == scriptHash(p2pkh)", () => {
  const addr = sdk.HDWallet.fromMnemonic(MN).deriveKey(0).address;
  assert.equal(
    sdk.addressToScriptHash(addr),
    sdk.scriptHash(sdk.p2pkhScript(addr)),
  );
});

test("selectRxdFunding: ref-safe, excludes token UTXOs", () => {
  const addr = sdk.HDWallet.fromMnemonic(MN).deriveKey(0).address;
  const p2pkh = sdk.p2pkhScript(addr);
  const tokenScript = "d0" + "00".repeat(36) + "76a914" + "11".repeat(20) + "88ac";
  const utxos = [
    { txid: "11".repeat(32), vout: 0, value: 50000n, script: p2pkh },
    { txid: "22".repeat(32), vout: 0, value: 9000000n, script: tokenScript }, // token script
    { txid: "33".repeat(32), vout: 0, value: 30000000n, script: p2pkh, refs: [{ ref: "x:0", type: "ft" }] }, // refs
    { txid: "44".repeat(32), vout: 0, value: 80000000n, script: p2pkh },
  ];
  const sel = sdk.selectRxdFunding(utxos, 1000000n, 1000n);
  const chosen = sel.inputs.map((i) => i.txid);
  assert.ok(!chosen.includes("22".repeat(32)), "token-script utxo excluded");
  assert.ok(!chosen.includes("33".repeat(32)), "refs utxo excluded");
  assert.ok(sel.total >= 1000000n + sel.fee);
  assert.ok(sel.change >= 0n);
  assert.equal(sdk.filterFundingCandidates(utxos).length, 2);
  assert.throws(() => sdk.assertFundingSafe(utxos), sdk.TokenBurnGuardError);
  assert.throws(
    () => sdk.selectRxdFunding(utxos, 10n ** 18n, 1000n),
    sdk.InsufficientFundsError,
  );
});

test("glyph: encode + ft/nft scripts carry the ref", () => {
  const addr = sdk.HDWallet.fromMnemonic(MN).deriveKey(0).address;
  const enc = sdk.encodeGlyph({ v: 2, p: [1], ticker: "DEMO" });
  assert.match(enc.payloadHash, /^[0-9a-f]{64}$/);
  assert.ok(enc.revealScriptSig.startsWith("03676c79")); // push "gly"
  const ref = sdk.packRef("ab".repeat(32), 0);
  const fts = sdk.ftScript(addr, ref);
  const nfts = sdk.nftScript(addr, ref);
  assert.equal(sdk.parseTokenRef(fts), ref);
  assert.equal(sdk.parseTokenRef(nfts), ref);
  assert.ok(sdk.isTokenBearing(fts) && sdk.isTokenBearing(nfts));
});

test("buildRxdTransfer: builds and signs a real tx", () => {
  const w = sdk.HDWallet.fromMnemonic(MN);
  const me = w.deriveKey(0);
  const to = w.deriveKey(1);
  const tx = sdk.buildRxdTransfer({
    address: me.address,
    wif: me.wif,
    to: to.address,
    amount: 100000000n,
    utxos: [{ txid: "55".repeat(32), vout: 0, value: 500000000n, script: sdk.p2pkhScript(me.address) }],
    feeRate: 10000n,
  });
  assert.match(tx.hex, /^[0-9a-f]+$/);
  assert.match(tx.txid, /^[0-9a-f]{64}$/);
  assert.ok(tx.outputs.length >= 2);
  assert.ok(tx.outputs.some((o) => o.value === 100000000n));
});

test("waveLabel: normalisation + validation", () => {
  assert.equal(sdk.waveLabel("Alice.rxd"), "alice");
  assert.equal(sdk.waveLabel("  BOB  "), "bob");
  assert.equal(sdk.waveLabel("mail.alice.rxd"), "mail.alice");
  assert.throws(() => sdk.waveLabel(".rxd"));
});
