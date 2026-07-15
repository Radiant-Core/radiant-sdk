// End-to-end tests against a REAL regtest node.
//
// These exist because unit tests cannot tell you whether a consensus-level
// script is valid — they'd pass just as happily on a script the node rejects.
// The only proof that a transfer works is a node accepting it and the output
// landing where we said it would.
//
// Skipped unless a regtest radiantd is reachable, so `npm test` still works
// without one. To run:
//
//   radiantd -regtest -server -txindex -rpcuser=rt -rpcpassword=rt \
//            -rpcport=17443 -datadir=<dir> -daemon
//   radiant-cli ... createwallet rt
//   radiant-cli ... generatetoaddress 120 <addr>
//   RXD_REGTEST_RPC=http://127.0.0.1:17443 npm test
//
import { test, before } from "node:test";
import assert from "node:assert/strict";
import * as sdk from "../dist/index.js";

const RPC_BASE = process.env.RXD_REGTEST_RPC || "http://127.0.0.1:17443";
const RPC_USER = process.env.RXD_REGTEST_USER || "rt";
const RPC_PASS = process.env.RXD_REGTEST_PASS || "rt";
const WALLET = process.env.RXD_REGTEST_WALLET || "rt";
const NET = "regtest";

const auth = "Basic " + Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString("base64");

async function rpc(method, params = []) {
  const res = await fetch(`${RPC_BASE}/wallet/${WALLET}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify({ jsonrpc: "1.0", id: "t", method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

let live = false;
before(async () => {
  try {
    const info = await rpc("getblockchaininfo");
    live = info.chain === "regtest" && info.blocks >= 100; // need mature coinbases
  } catch {
    live = false;
  }
  if (!live) console.log("  (regtest node unreachable — skipping on-chain tests)");
});

/** Broadcast straight to the node; stands in for an ElectrumClient. */
const client = { broadcastTx: async (hex) => rpc("sendrawtransaction", [hex]) };

const mine = async (n = 1) => rpc("generatetoaddress", [n, await rpc("getnewaddress")]);

/** Send RXD from the node wallet to `address` and return the created UTXO. */
async function fund(address, rxd) {
  const txid = await rpc("sendtoaddress", [address, rxd]);
  const raw = await rpc("getrawtransaction", [txid, true]);
  const out = raw.vout.find((o) => (o.scriptPubKey.addresses || []).includes(address));
  assert.ok(out, "funding output not found");
  await mine();
  return { txid, vout: out.n, value: BigInt(Math.round(out.value * 1e8)), script: out.scriptPubKey.hex };
}

const newWallet = () => sdk.HDWallet.fromMnemonic(sdk.HDWallet.generateMnemonic(), { network: NET });

/** The exact ftScript an address+ref produces — for matching outputs on chain. */
const ftScriptFor = (address, ref) => sdk.ftScript(address, ref, NET);

test("regtest: mint an NFT, then transfer it — both settle on chain", async (t) => {
  if (!live) return t.skip("no regtest node");

  const w = newWallet();
  const alice = w.deriveKey(0);
  const bob = w.deriveKey(1);

  // --- mint -----------------------------------------------------------------
  const mint = await sdk.mintNFT({
    client,
    address: alice.address,
    wif: alice.wif,
    fundingUtxos: [await fund(alice.address, 10)],
    network: NET,
    metadata: { name: "regtest-nft" },
  });
  await mine();

  const reveal = await rpc("getrawtransaction", [mint.revealTxid, true]);
  assert.ok(reveal.confirmations >= 1, "reveal did not confirm");

  // The reveal must carry an NFT output bound to the minted ref, owned by alice.
  const nftOut = reveal.vout.find((o) => sdk.parseNftScript(o.scriptPubKey.hex).ref === mint.ref);
  assert.ok(nftOut, "reveal produced no NFT output for the minted ref");
  const aliceHash = sdk.parseNftScript(sdk.nftScript(alice.address, mint.ref, NET)).addressHash;
  assert.equal(sdk.parseNftScript(nftOut.scriptPubKey.hex).addressHash, aliceHash);

  // --- transfer -------------------------------------------------------------
  const moved = await sdk.transferToken({
    client,
    address: alice.address,
    wif: alice.wif,
    tokenUtxo: {
      txid: mint.revealTxid,
      vout: nftOut.n,
      value: BigInt(Math.round(nftOut.value * 1e8)),
      script: nftOut.scriptPubKey.hex,
    },
    toAddress: bob.address,
    fundingUtxos: [await fund(alice.address, 5)],
    network: NET,
  });
  await mine();

  const settled = await rpc("getrawtransaction", [moved.txid, true]);
  assert.ok(settled.confirmations >= 1, "transfer did not confirm");

  const out = settled.vout.find((o) => sdk.parseNftScript(o.scriptPubKey.hex).ref === mint.ref);
  assert.ok(out, "transfer produced no NFT output for the ref");

  const bobHash = sdk.parseNftScript(sdk.nftScript(bob.address, mint.ref, NET)).addressHash;
  assert.equal(sdk.parseNftScript(out.scriptPubKey.hex).addressHash, bobHash, "bob does not own the NFT");
  assert.equal(moved.ref, mint.ref, "transfer reported the wrong ref");

  // The output must be a PLAIN singleton. Carrying an auth preamble here is the
  // bug this whole path exists to avoid: OP_REQUIREINPUTREF in an output is a
  // creation-time rule, so the node would demand the mutable ref among inputs.
  assert.ok(!out.scriptPubKey.hex.startsWith("d1"), "transfer output carries an auth preamble");
});

test("regtest: the node REJECTS an output carrying an unsatisfied require-ref", async (t) => {
  if (!live) return t.skip("no regtest node");

  // Proves the rule that makes the transferToken fix necessary, rather than
  // taking the docs' word for it: an output with OP_REQUIREINPUTREF <ref> is
  // invalid unless that ref is among the tx's INPUTS. This is exactly what the
  // old rebindOwner produced for a WAVE name.
  const w = newWallet();
  const alice = w.deriveKey(0);
  const utxo = await fund(alice.address, 2);

  const phantomRef = "ab".repeat(36); // a ref this tx does not carry as an input
  const pkh = sdk.parseNftScript(sdk.nftScript(alice.address, phantomRef, NET)).addressHash;
  const authish = `d1${phantomRef}20${"ef".repeat(32)}6dbdd8${phantomRef}7576a914${pkh}88ac`;

  const built = sdk.buildTx({
    address: alice.address,
    wif: alice.wif,
    inputs: [utxo],
    outputs: [{ script: authish, value: 100_000n }],
    addChange: true,
    feeRate: 1_000n,
    network: NET,
  });

  await assert.rejects(
    () => rpc("sendrawtransaction", [built.hex]),
    /reference|require|scriptpubkey|non-mandatory|mandatory/i,
    "node accepted an output with an unsatisfied require-ref",
  );
});

test("regtest: FT partial-send — accumulates, sends, and returns change on chain", async (t) => {
  if (!live) return t.skip("no regtest node");

  const w = newWallet();
  const alice = w.deriveKey(0);
  const bob = w.deriveKey(1);

  // Mint a fungible supply to alice.
  const SUPPLY = 500n;
  const mint = await sdk.mintFT({
    client,
    address: alice.address,
    wif: alice.wif,
    fundingUtxos: [await fund(alice.address, 10)],
    network: NET,
    ticker: "HARN",
    supply: SUPPLY,
    metadata: { name: "harness-ft" },
  });
  await mine();

  const reveal = await rpc("getrawtransaction", [mint.revealTxid, true]);
  const ftOut = reveal.vout.find((o) => sdk.parseFtScript(o.scriptPubKey.hex).ref === mint.ref);
  assert.ok(ftOut, "reveal produced no FT output");
  const held = {
    txid: mint.revealTxid,
    vout: ftOut.n,
    value: BigInt(Math.round(ftOut.value * 1e8)),
    script: ftOut.scriptPubKey.hex,
  };
  assert.equal(held.value, SUPPLY, "minted supply is the FT output's photon value");

  // Send 50 of the 500 — the thing transferToken cannot express.
  const SEND = 50n;
  const moved = await sdk.transferFungible({
    client,
    address: alice.address,
    wif: alice.wif,
    tokenUtxos: [held],
    toAddress: bob.address,
    amount: SEND,
    fundingUtxos: [await fund(alice.address, 5)],
    network: NET,
  });
  await mine();

  const settled = await rpc("getrawtransaction", [moved.txid, true]);
  assert.ok(settled.confirmations >= 1, "FT transfer did not confirm");
  assert.equal(moved.sent, SEND);
  assert.equal(moved.change, SUPPLY - SEND);

  // Bob holds exactly 50.
  const bobFt = ftScriptFor(bob.address, mint.ref);
  const toBob = settled.vout.find((o) => o.scriptPubKey.hex === bobFt);
  assert.ok(toBob, "no FT output to bob");
  assert.equal(BigInt(Math.round(toBob.value * 1e8)), SEND, "bob did not receive exactly 50");

  // Alice keeps exactly 450 — this is the one that matters. Omitting FT change
  // does not error, it BURNS the remainder: the covenant enforces
  // inputs >= outputs, so under-emitting is permitted and permanent.
  const aliceFt = ftScriptFor(alice.address, mint.ref);
  const backToAlice = settled.vout.find((o) => o.scriptPubKey.hex === aliceFt);
  assert.ok(backToAlice, "no FT change output — the remainder would have been burned");
  assert.equal(BigInt(Math.round(backToAlice.value * 1e8)), SUPPLY - SEND, "FT change is wrong");

  // Conservation: token photons in == token photons out.
  const tokenOut = settled.vout
    .filter((o) => sdk.parseFtScript(o.scriptPubKey.hex).ref === mint.ref)
    .reduce((s, o) => s + BigInt(Math.round(o.value * 1e8)), 0n);
  assert.equal(tokenOut, SUPPLY, "token value was not conserved");
});

test("regtest: FT partial-send refuses to mix two different tokens", async (t) => {
  if (!live) return t.skip("no regtest node");

  const w = newWallet();
  const alice = w.deriveKey(0);

  // Two distinct FT mints; feeding both to one send would burn one of them.
  const a = await sdk.mintFT({
    client, address: alice.address, wif: alice.wif,
    fundingUtxos: [await fund(alice.address, 10)], network: NET,
    ticker: "AAA", supply: 100n, metadata: { name: "aaa" },
  });
  await mine();
  const b = await sdk.mintFT({
    client, address: alice.address, wif: alice.wif,
    fundingUtxos: [await fund(alice.address, 10)], network: NET,
    ticker: "BBB", supply: 100n, metadata: { name: "bbb" },
  });
  await mine();

  const utxoOf = async (m) => {
    const r = await rpc("getrawtransaction", [m.revealTxid, true]);
    const o = r.vout.find((v) => sdk.parseFtScript(v.scriptPubKey.hex).ref === m.ref);
    return { txid: m.revealTxid, vout: o.n, value: BigInt(Math.round(o.value * 1e8)), script: o.scriptPubKey.hex };
  };

  const mixed = [await utxoOf(a), await utxoOf(b)];
  const funding = [await fund(alice.address, 5)];
  await assert.rejects(
    async () =>
      sdk.transferFungible({
        client, address: alice.address, wif: alice.wif,
        tokenUtxos: mixed,
        toAddress: alice.address, amount: 10n,
        fundingUtxos: funding, network: NET,
      }),
    /different tokens|mix refs/,
  );
});
