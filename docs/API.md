# API Reference — `@radiant-core/sdk`

Full reference for every public export. For a narrative quickstart see the
[README](../README.md); for a hosted guide see
[radiantcore.org/docs/sdk.html](https://radiantcore.org/docs/sdk.html).

> **Units.** Every amount is in **photons** as a `BigInt`. `1 RXD = 100,000,000
> photons`. Convert only at the UI edge with [`rxdToPhotons`](#unit-helpers) /
> [`photonsToRxd`](#unit-helpers).

## Contents

- [Install & import](#install--import)
- [`ElectrumClient`](#electrumclient) — network access
- [`HDWallet` / `Keys`](#hdwallet) — key derivation
- [Funding selection](#funding-selection) — `selectRxdFunding` & friends
- [Transactions](#transactions) — `buildTx`, `buildRxdTransfer`
- [Glyph tokens](#glyph-tokens) — `mintFT`, `mintNFT`, `transferToken`
- [WAVE names](#wave-names) — `waveResolve`
- [Script helpers](#script-helpers) — scripthash, ref-safety, refs
- [Unit helpers](#unit-helpers)
- [Errors](#errors)
- [Constants](#constants)
- [Types](#types)

---

## Install & import

```bash
npm install @radiant-core/sdk
# Node < 22 has no global WebSocket — also install the optional peer:
npm install ws
```

Requires **Node 20.19+ or 22+** (radiantjs pulls in an ESM-only dependency that
needs `require(ESM)` support). Dual ESM + CJS, types included.

```ts
import { ElectrumClient, HDWallet, selectRxdFunding } from "@radiant-core/sdk";
// CommonJS:
const { ElectrumClient } = require("@radiant-core/sdk");
```

---

## ElectrumClient

A reconnecting ElectrumX WebSocket client. All scripthash methods accept either
a plain address (P2PKH scripthash is computed for you) or a 64-hex scripthash.

```ts
const client = new ElectrumClient({ network: "mainnet" });
await client.connect();
```

### `new ElectrumClient(options?)`

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `endpoint` | `string` | network default | Full `wss://`/`ws://` URL. Overrides `network`. |
| `network` | `"mainnet" \| "testnet" \| "regtest"` | `"mainnet"` | Selects the default endpoint. |
| `requestTimeoutMs` | `number` | `15000` | Per-request timeout. |
| `reconnect` | `boolean` | `true` | Auto-reconnect with exponential backoff + jitter (1s → 30s). |
| `webSocketCtor` | `WebSocket` ctor | auto | Inject a WebSocket implementation (tests/custom transport). |

Mainnet default endpoint: `wss://electrumx.radiantcore.org:443`.

### Methods

| Method | Returns | Description |
| --- | --- | --- |
| `connect()` | `Promise<void>` | Open the socket (idempotent). |
| `connected` | `boolean` | Whether the socket is open. |
| `serverVersion(client?, protocol?)` | `Promise<unknown>` | Negotiate protocol version. |
| `getBalance(addressOrScriptHash)` | `Promise<ScriptHashBalance>` | `{ confirmed, unconfirmed }` in photons. |
| `listUnspent(addressOrScriptHash)` | `Promise<Utxo[]>` | UTXOs as SDK `Utxo`s. For an **address** the `script` is filled (P2PKH); for a raw scripthash `script` is `""`. Token UTXOs include `refs`. |
| `getHistory(addressOrScriptHash)` | `Promise<unknown[]>` | Raw confirmed/mempool history. |
| `getTransaction(txid, verbose?)` | `Promise<unknown>` | Raw tx hex, or verbose object. |
| `subscribe(addressOrScriptHash, onUpdate)` | `Promise<string \| null>` | Fires `onUpdate(status)` on change; returns the current status. |
| `unsubscribe(addressOrScriptHash)` | `Promise<unknown>` | Stop updates. |
| `broadcastTx(rawHex)` | `Promise<string>` | Returns the txid. Treats "already in blockchain" as success. |
| `request(method, ...params)` | `Promise<T>` | Escape hatch for any ElectrumX JSON-RPC method. |
| `close()` | `void` | Close and stop reconnecting. |

```ts
const { confirmed } = await client.getBalance(address);
const utxos = await client.listUnspent(address);
await client.subscribe(address, (status) => console.log("changed:", status));
const txid = await client.broadcastTx(rawHex);
```

---

## HDWallet

BIP44 HD derivation at the Radiant path `m/44'/512'/account'/change/index`
(SLIP-0044 coin type 512). Derives keys only — it never touches the network.

### Constructors

| Static | Signature |
| --- | --- |
| `HDWallet.fromMnemonic(phrase, options?)` | BIP39 mnemonic → wallet |
| `HDWallet.fromSeed(seed, options?)` | `Buffer`/hex seed → wallet |
| `HDWallet.fromXprv(xprv, options?)` | extended private key → wallet |
| `HDWallet.generateMnemonic()` | → fresh 12-word phrase (`string`) |

**`HDWalletOptions`:** `network` (`"mainnet"` default), `passphrase` (BIP39 "25th
word"), `account` (hardened, default `0`), `coinType` (default `512`; pass `0`
only to recover legacy wallets).

### Instance methods

| Method | Returns | Description |
| --- | --- | --- |
| `deriveKey(index, change?)` | `DerivedKey` | `{ index, change, path, wif, publicKey, address, scriptHash }` |
| `deriveRange(start, count, change?)` | `DerivedKey[]` | Batch derive (e.g. a receive gap). |
| `address(index?, change?)` | `string` | Address at an index. |
| `wif(index?, change?)` | `string` | WIF at an index. |
| `privateKey(index, change?)` | radiantjs `PrivateKey` | Raw key (escape hatch). |
| `pathFor(index, change?)` | `string` | The full derivation path. |

```ts
const mnemonic = HDWallet.generateMnemonic();
const wallet = HDWallet.fromMnemonic(mnemonic, { network: "mainnet" });
const me = wallet.deriveKey(0);          // m/44'/512'/0'/0/0
const receive = wallet.deriveRange(0, 20);
```

### `Keys`

Stateless helpers for callers who manage their own WIFs:

```ts
Keys.addressFromWif(wif, network?);   // -> address
Keys.publicKeyFromWif(wif);           // -> compressed pubkey hex
Keys.scriptHashFromWif(wif, network?);// -> ElectrumX scripthash
```

---

## Funding selection

**The core safety primitive.** RXD funding is never gathered by a value
heuristic: a UTXO carrying a token ref (FT/NFT/dMint) looks like plain value but
spending it as funding silently **burns the token**. Every candidate is screened
two ways — indexer-reported `refs` and a local script scan — before it can fund
a transaction.

| Function | Description |
| --- | --- |
| `selectRxdFunding(utxos, target, feeRate, options?)` | Greedy, ref-safe selection. **Silently excludes** token UTXOs, so you can pass a raw `listUnspent()` result. Returns `FundingSelection`. Throws `InsufficientFundsError` if the token-free pool can't cover `target`. |
| `filterFundingCandidates(utxos)` | Drop every token-bearing UTXO. |
| `isFundingSafe(utxo)` | `boolean` — no `refs` and no `OP_PUSHINPUTREF` opcodes. |
| `assertFundingSafe(utxos)` | Throw `TokenBurnGuardError` on the first token UTXO (opt-in strict guard). |
| `estimateFee(inputCount, outputCount, feeRate, extraInputBytes?)` | Photon fee estimate. |
| `sumValue(utxos)` | Sum of photon values. |

**`SelectRxdFundingOptions`:** `baseOutputCount` (non-change outputs, default 1),
`extraInputBytes` (bytes from inputs you've already committed), `withChange`
(default `true`).

```ts
const sel = selectRxdFunding(utxos, rxdToPhotons("0.5"), 10_000n);
// sel.inputs, sel.fee, sel.total, sel.change  (all token-free, all BigInt)
```

---

## Transactions

| Function | Description |
| --- | --- |
| `buildRxdTransfer({ address, wif, to, amount, utxos, feeRate, network? })` | Build + sign a simple RXD payment, funded ref-safely. Returns `BuiltTx`. |
| `buildTx(params)` | Low-level builder (manual inputs/outputs + a per-input scriptSig hook). Used internally by the token flows. |

`BuiltTx` = `{ tx, hex, txid, outputs }` where `outputs` carry resolved photon
values (including change). `buildTx` measures the **real signed size** and sets
an explicit fee `(size + headroom) × feeRate` so token transactions reliably
clear the node's min-relay floor.

```ts
const { hex, txid } = buildRxdTransfer({
  address: me.address, wif: me.wif,
  to: "1Recipient...", amount: rxdToPhotons("1.25"),
  utxos, feeRate: 10_000n,
});
await client.broadcastTx(hex);
```

---

## Glyph tokens

Mint and move Glyph tokens via the commit/reveal pattern. These reproduce the
proven Photonic-Wallet on-chain templates and are
[regtest-validated](../README.md). They broadcast real, irreversible
transactions — test your flow on regtest/testnet first.

| Function | Description |
| --- | --- |
| `mintFT({ client, address, wif, ticker, supply, fundingUtxos, metadata?, feeRate?, network? })` | Mint a fungible token. `supply` is in base units (FT amount == output photons). Returns `MintResult`. |
| `mintNFT({ client, address, wif, fundingUtxos, mutable?, outputValue?, metadata?, feeRate?, network? })` | Mint an NFT singleton. `mutable: true` → `p:[2,5]`. Returns `MintResult`. |
| `transferToken({ client, address, wif, tokenUtxo, toAddress, fundingUtxos, feeRate?, network? })` | Move an FT or NFT to a new owner (kind-agnostic; preserves the covenant, re-binds the owner P2PKH). |
| `encodeGlyph(payload)` | `{ revealScriptSig, payloadHash }` — CBOR envelope + hash. |
| `ftScript(address, ref, network?)` / `nftScript(...)` | Build the on-chain token output script. |
| `parseTokenRef(scriptHex)` | Extract the 72-hex packed ref from a token script (`null` if none). |

`MintResult` = `{ ref, refDisplay, commitTxid, revealTxid }`. `ref` is the packed
72-hex ref; `refDisplay` is `"txid:vout"`.

```ts
const funding = filterFundingCandidates(await client.listUnspent(me.address));

const ft = await mintFT({
  client, address: me.address, wif: me.wif,
  ticker: "DEMO", supply: 1_000_000n,
  metadata: { name: "Demo Token", desc: "Minted with @radiant-core/sdk" },
  fundingUtxos: funding,
});

await transferToken({
  client, address: me.address, wif: me.wif,
  tokenUtxo,                    // the FT/NFT UTXO (must include its on-chain script)
  toAddress: "1Recipient...",
  fundingUtxos: funding,        // covers the fee; token value is conserved
});
```

> **Discovering token UTXOs.** The indexer keys a token UTXO under
> `scriptHash(zeroRefs(tokenScript))`, **not** the owner's plain P2PKH
> scripthash. To list a held token: `client.listUnspent(scriptHash(zeroRefs(
> ftScript(owner, ref))))`. The returned entries carry `refs:[{ ref, type }]`
> (`type` is `"normal"` for FT, `"single"` for an NFT singleton).

---

## WAVE names

| Function | Description |
| --- | --- |
| `waveResolve(name, options?)` | Resolve a WAVE name → `WaveResolution` (`registered: false` for unregistered, not an error). |
| `waveResolveAddress(name, options?)` | Resolve straight to the target address, or `null`. |
| `waveLabel(name)` | Normalise to the bare label the indexer resolves on. |

**`WaveResolveOptions`:** `restBase` (default `https://radiantcore.org/api`),
`fetchImpl` (inject a `fetch`), `signal` (AbortSignal).

```ts
const rec = await waveResolve("alice.rxd"); // ".rxd" stripped
if (rec.registered) console.log(rec.address, rec.owner, rec.expires);

const addr = await waveResolveAddress("alice"); // string | null
```

---

## Script helpers

Pure, dependency-light primitives (these mirror RXinDexer's exact algorithms, so
scripthashes line up with the indexer).

| Function | Description |
| --- | --- |
| `scriptHash(scriptHex)` | ElectrumX scripthash = `sha256(script)` reversed, hex. |
| `addressToScriptHash(address)` | Scripthash for a plain (P2PKH) address. |
| `p2pkhScript(address)` | P2PKH output script hex for an address. |
| `isTokenBearing(scriptHex)` | `true` if the script has an `OP_PUSHINPUTREF`-family opcode (0xd0–0xd8) in opcode position — i.e. it carries a token. |
| `zeroRefs(scriptHex)` | Zero the 36-byte ref operands (only when a CHECKSIG is present) — how the indexer keys covenant scripts. |
| `packRef(txid, vout)` | Outpoint → 72-hex packed ref (internal byte order). |
| `unpackRef(ref)` | Packed ref → `{ txid, vout }` (display order). |

---

## Unit helpers

| Function | Description |
| --- | --- |
| `rxdToPhotons(rxd: string \| number)` | RXD → photons (`BigInt`). String form avoids float rounding. |
| `photonsToRxd(photons: bigint)` | Photons → fixed-point RXD string. |
| `PHOTONS_PER_RXD` | `100_000_000n`. |
| `RXD_DECIMALS` | `8`. |

```ts
rxdToPhotons("1.5")        // 150000000n
photonsToRxd(150000000n)   // "1.5"
```

---

## Errors

All extend `RadiantSdkError`, so you can `instanceof` to branch:

| Class | Thrown when |
| --- | --- |
| `RadiantSdkError` | Base class. |
| `InsufficientFundsError` | Token-free UTXOs can't cover `target + fee`. Has `requiredPhotons`, `availablePhotons`. |
| `TokenBurnGuardError` | A token-bearing UTXO was about to fund a tx. Has `txid`, `vout`. |
| `ElectrumError` | ElectrumX transport/protocol failure. Optional `code`. |
| `ValidationError` | Malformed input/argument. |

---

## Constants

`PHOTONS_PER_RXD`, `RADIANT_COIN_TYPE` (512), `MIN_RELAY_FEE_RATE` (`{ mainnet:
10_000n, testnet: 1_000n, regtest: 1_000n }`), `DUST_LIMIT` (`1_000n`),
`DEFAULT_ELECTRUM_ENDPOINT`, `DEFAULT_REST_BASE`, `GLYPH_PROTOCOL`
(`{ FT: 1, NFT: 2, MUTABLE: 5, CONTAINER: 7, ENCRYPTED: 8, WAVE: 11 }`).

The raw underlying library is exported as `radiantjs` for advanced use.

---

## Types

`NetworkName`, `Utxo`, `UtxoRef`, `TxOutput`, `FundingSelection`,
`ScriptHashBalance`, `WaveResolution`, `DerivedKey`, `HDWalletOptions`,
`BuildTxParams`, `BuildTxInput`, `BuiltTx`, `GlyphPayload`, `MintResult`,
`MintFtParams`, `MintNftParams`, `TransferTokenParams`, `SelectRxdFundingOptions`,
`ElectrumClientOptions`, `WaveResolveOptions`.

```ts
interface Utxo {
  txid: string;
  vout: number;
  value: bigint;          // photons
  script: string;         // scriptPubKey hex
  height?: number;        // 0/undefined = unconfirmed
  refs?: { ref: string; type: string }[]; // present => token-bearing
}
```
