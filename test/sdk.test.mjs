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

// ---- Token script parsing ---------------------------------------------------
// These matter because `parseTokenRef` scans for the FIRST ref opcode, which on
// an auth-form (mutable / WAVE) NFT is the MUTABLE ref — not the token's own.

const REF = "ab".repeat(36); // 72 hex
const MUT_REF = "cd".repeat(36);
const SIG_HASH = "ef".repeat(32); // 64 hex
const PKH = "11".repeat(20);
const P2PKH = `76a914${PKH}88ac`;

const PLAIN_NFT = `d8${REF}75${P2PKH}`;
// A WAVE name after a target update: the mutable covenant forces the auth form.
const AUTH_NFT = `d1${MUT_REF}20${SIG_HASH}6dbdd8${REF}75${P2PKH}`;
const FT = `${P2PKH}bdd0${REF}dec0e9aa76e378e4a269e69d`;

test("parseNftScript: plain singleton", () => {
  assert.deepEqual(sdk.parseNftScript(PLAIN_NFT), { ref: REF, addressHash: PKH });
});

test("parseNftScript: auth form yields the SINGLETON ref, not the mutable one", () => {
  const { ref, addressHash } = sdk.parseNftScript(AUTH_NFT);
  assert.equal(ref, REF);
  assert.notEqual(ref, MUT_REF); // the trap
  assert.equal(addressHash, PKH);
});

test("parseTokenRef returns the MUTABLE ref on an auth-form NFT (why parseNftScript exists)", () => {
  // Documents the exact footgun: a loose "first ref opcode" scan is wrong here.
  assert.equal(sdk.parseTokenRef(AUTH_NFT), MUT_REF);
  assert.equal(sdk.parseNftScript(AUTH_NFT).ref, REF);
});

test("parseFtScript / parseP2pkhScript", () => {
  assert.deepEqual(sdk.parseFtScript(FT), { ref: REF, addressHash: PKH });
  assert.deepEqual(sdk.parseP2pkhScript(P2PKH), { addressHash: PKH });
  assert.equal(sdk.parseP2pkhScript(PLAIN_NFT).addressHash, undefined); // not a bare p2pkh
});

test("parsers are shape-exact: they reject the other kind", () => {
  assert.equal(sdk.parseNftScript(FT).ref, undefined);
  assert.equal(sdk.parseFtScript(PLAIN_NFT).ref, undefined);
  assert.equal(sdk.parseNftScript("deadbeef").ref, undefined);
});

test("tokenScriptKind classifies by shape", () => {
  assert.equal(sdk.tokenScriptKind(PLAIN_NFT), "nft");
  assert.equal(sdk.tokenScriptKind(AUTH_NFT), "nft");
  assert.equal(sdk.tokenScriptKind(FT), "ft");
  assert.equal(sdk.tokenScriptKind(P2PKH), null);
});

// ---- Fee sanity guard -------------------------------------------------------
// A fee is just "inputs - outputs", so every way of getting it wrong looks like
// a valid tx. These pin the guard that stops the money reaching a miner.

const NET = "regtest";
const feeWallet = sdk.HDWallet.fromMnemonic(MN, { network: NET });
const feeKey = feeWallet.deriveKey(0);

const utxo = (value) => ({
  txid: "a".repeat(64),
  vout: 0,
  value,
  script: sdk.p2pkhScript(feeKey.address, NET),
});

test("buildTx: a normal change-bearing tx passes the fee guard", () => {
  const built = sdk.buildTx({
    address: feeKey.address,
    wif: feeKey.wif,
    inputs: [utxo(100_000_000n)],
    outputs: [{ script: sdk.p2pkhScript(feeKey.address, NET), value: 50_000_000n }],
    addChange: true,
    feeRate: 1_000n, // regtest min-relay
    network: NET,
  });
  assert.ok(built.hex.length > 0);
});

test("buildTx: REFUSES to burn the excess on an over-funded change-less tx", () => {
  // 1 RXD in, 0.01 RXD out, no change → the other 0.99 RXD is silently the fee.
  assert.throws(
    () =>
      sdk.buildTx({
        address: feeKey.address,
        wif: feeKey.wif,
        inputs: [utxo(100_000_000n)],
        outputs: [{ script: sdk.p2pkhScript(feeKey.address, NET), value: 1_000_000n }],
        addChange: false,
        feeRate: 1_000n,
        network: NET,
      }),
    /fee .* above the sanity ceiling/,
  );
});

test("buildTx: REFUSES a sats/kB-for-photons/byte units slip", () => {
  // 1_000_000 is the sats/kB figure; as photons/byte it's a 1000x overpay.
  assert.throws(
    () =>
      sdk.buildTx({
        address: feeKey.address,
        wif: feeKey.wif,
        inputs: [utxo(100_000_000n)],
        outputs: [{ script: sdk.p2pkhScript(feeKey.address, NET), value: 1_000_000n }],
        addChange: true,
        feeRate: 1_000_000n,
        network: NET,
      }),
    /units mistake|sanity ceiling/,
  );
});

// ---- Discovery (RXinDexer v4 lists) ----------------------------------------
// Offline: fetchImpl injection; validates URL construction, param encoding,
// page mapping, and error paths.

function fakeFetch(expectUrl, payload, status = 200) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    if (expectUrl) assert.equal(url, expectUrl);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "ERR",
      json: async () => payload,
    };
  };
  fn.calls = calls;
  return fn;
}

const PAGE = {
  tokens: [{ ref: "aa_0", ref_hex: "aa".repeat(36), type: 2, type_name: "NFT",
             protocols: [2], name: "T", ticker: null, deploy_height: 447786,
             deploy_txid: "bb".repeat(32), is_spent: false }],
  next_cursor: "R1H_-SrW",
};

test("getRecentTokens: url + page mapping", async () => {
  const f = fakeFetch("https://radiantcore.org/api/glyphs/recent?limit=2", PAGE);
  const page = await sdk.getRecentTokens({ limit: 2, fetchImpl: f });
  assert.equal(page.tokens.length, 1);
  assert.equal(page.tokens[0].deploy_height, 447786);
  assert.equal(page.nextCursor, "R1H_-SrW");
});

test("getRecentTokens: cursor + type filter are query-encoded", async () => {
  const f = fakeFetch(
    "https://radiantcore.org/api/glyphs/recent?limit=1&cursor=R1H_-SrW&type_id=2",
    { tokens: [], next_cursor: null },
  );
  const page = await sdk.getRecentTokens({
    limit: 1, cursor: "R1H_-SrW", typeId: sdk.GLYPH_TOKEN_TYPE.NFT, fetchImpl: f,
  });
  assert.equal(page.nextCursor, null);
});

test("getTokensByType: recent order + custom restBase", async () => {
  const f = fakeFetch("http://localhost:8000/glyphs/by-type/5?order=recent", PAGE);
  const page = await sdk.getTokensByType(sdk.GLYPH_TOKEN_TYPE.WAVE, {
    order: "recent", restBase: "http://localhost:8000/", fetchImpl: f,
  });
  assert.equal(page.tokens[0].ref, "aa_0");
});

test("getTokensByType: rejects invalid typeId; surfaces HTTP errors", async () => {
  await assert.rejects(() => sdk.getTokensByType(99, { fetchImpl: fakeFetch(null, {}) }));
  await assert.rejects(
    () => sdk.getTokensByType(2, { fetchImpl: fakeFetch(null, {}, 500) }),
    /HTTP 500/,
  );
});
