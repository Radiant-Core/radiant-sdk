# @radiant-core/sdk

A clean TypeScript SDK for building [Radiant (RXD)](https://radiantcore.org) dapps — without reading internal Photonic/radiantjs source.

It wraps [`@radiant-core/radiantjs`](https://www.npmjs.com/package/@radiant-core/radiantjs) (the low‑level tx/script library) and gives you the primitives most web/app developers actually need: an ElectrumX client, **ref‑safe** UTXO selection that never burns tokens, Glyph token mint/transfer, WAVE name resolution, and SLIP‑0044 HD wallets.

- 🔌 **ElectrumX WebSocket client** — balance, UTXOs, broadcast, subscribe, auto‑reconnect with backoff
- 🛡️ **Ref‑safe funding** — token‑bearing UTXOs are *never* spent as RXD funding (no silent token burns)
- 🪙 **Glyph tokens** — mint FT/NFT and transfer via the commit/reveal pattern
- 🌊 **WAVE names** — resolve `alice` → address
- 🔑 **HD wallets** — `m/44'/512'/0'/0/k` (Radiant coin type 512, the v3.0.0+ default)
- 📦 **Dual ESM + CJS**, tree‑shakeable, TypeScript types included
- 🔢 **Photons as `BigInt`** everywhere internally, with RXD helpers at the edge

```bash
npm install @radiant-core/sdk
# radiantjs is a peer of the token/wallet APIs; install it too:
npm install @radiant-core/radiantjs
# On Node < 22 (no global WebSocket), also:
npm install ws
```

> **Units.** The base unit is the *photon*. `1 RXD = 100,000,000 photons`. All
> amounts inside the SDK are `BigInt` photons. Use `rxdToPhotons()` /
> `photonsToRxd()` only at your UI/input boundary — never do balance math in
> floating point.

---

## Quickstart

### Connect and read a balance

```ts
import { ElectrumClient, photonsToRxd } from "@radiant-core/sdk";

const client = new ElectrumClient({ network: "mainnet" });
await client.connect();

const address = "1Yourradiantaddress...";
const { confirmed, unconfirmed } = await client.getBalance(address);
console.log(`Confirmed: ${photonsToRxd(confirmed)} RXD`);

const utxos = await client.listUnspent(address); // Utxo[] (photons as BigInt)
```

### Create / restore an HD wallet

```ts
import { HDWallet } from "@radiant-core/sdk";

// New wallet
const mnemonic = HDWallet.generateMnemonic();
const wallet = HDWallet.fromMnemonic(mnemonic, { network: "mainnet" });

// Address #0 at m/44'/512'/0'/0/0
const acct0 = wallet.deriveKey(0);
console.log(acct0.path);        // m/44'/512'/0'/0/0
console.log(acct0.address);     // base58 address
console.log(acct0.scriptHash);  // ElectrumX scripthash

// Batch derive a gap of receive addresses
const receive = wallet.deriveRange(0, 20); // DerivedKey[]
```

### Send RXD (ref‑safe funding)

```ts
import { ElectrumClient, HDWallet, buildRxdTransfer, rxdToPhotons } from "@radiant-core/sdk";

const client = new ElectrumClient({ network: "mainnet" });
const wallet = HDWallet.fromMnemonic(mnemonic);
const me = wallet.deriveKey(0);

const utxos = await client.listUnspent(me.address);

const { hex, txid } = buildRxdTransfer({
  address: me.address,
  wif: me.wif,
  to: "1Recipient...",
  amount: rxdToPhotons("1.25"), // 1.25 RXD -> photons
  utxos,                        // token‑bearing UTXOs are auto‑excluded
  feeRate: 10_000n,             // photons/byte (mainnet min‑relay)
});

await client.broadcastTx(hex);
console.log("sent", txid);
```

### Ref‑safe selection, explicitly

The single most important safety property: **funding is never gathered by a
value heuristic.** A UTXO that carries a token ref (FT/NFT/dMint) looks like
plain value to a naive selector, but spending it as funding *burns the token*.
`selectRxdFunding` screens every candidate two ways — indexer‑reported `refs`
and a local script scan (`isTokenBearing`) — and throws `TokenBurnGuardError`
rather than risk a burn.

```ts
import { selectRxdFunding, filterFundingCandidates, isTokenBearing } from "@radiant-core/sdk";

const safe = filterFundingCandidates(allUtxos); // drops anything token‑bearing
const sel  = selectRxdFunding(allUtxos, rxdToPhotons("0.5"), 10_000n);
console.log(sel.inputs, sel.fee, sel.change);

isTokenBearing(scriptHex); // true if the script has an OP_PUSHINPUTREF opcode
```

### Mint a Glyph token

```ts
import { mintFT, mintNFT, filterFundingCandidates } from "@radiant-core/sdk";

const funding = filterFundingCandidates(await client.listUnspent(me.address));

// Fungible token (FT amount == output photons)
const ft = await mintFT({
  client,
  address: me.address,
  wif: me.wif,
  ticker: "DEMO",
  supply: 1_000_000n,
  metadata: { name: "Demo Token", desc: "Minted with @radiant-core/sdk" },
  fundingUtxos: funding,
});
console.log("FT ref:", ft.refDisplay, ft.commitTxid, ft.revealTxid);

// Non‑fungible token (singleton)
const nft = await mintNFT({
  client,
  address: me.address,
  wif: me.wif,
  metadata: { name: "My NFT", attrs: { rarity: "rare" } },
  fundingUtxos: funding,
});
```

### Transfer a token

```ts
import { transferToken } from "@radiant-core/sdk";

// `tokenUtxo` must include its on‑chain `script` (the token output script).
await transferToken({
  client,
  address: me.address,
  wif: me.wif,
  tokenUtxo,                 // the FT/NFT UTXO to move
  toAddress: "1Recipient...",
  fundingUtxos: funding,     // covers the fee only; token value is conserved
});
```

### Resolve a WAVE name

```ts
import { waveResolve, waveResolveAddress } from "@radiant-core/sdk";

const rec = await waveResolve("alice"); // "alice.rxd" works too (suffix stripped)
if (rec.registered) console.log(rec.address, rec.owner, rec.expires);

const addr = await waveResolveAddress("alice"); // string | null
```

### Subscribe to address activity

```ts
const status = await client.subscribe(me.address, (newStatus) => {
  console.log("address changed:", newStatus); // re‑fetch UTXOs/balance here
});
```

---

## API surface

| Area | Exports |
| --- | --- |
| Client | `ElectrumClient` |
| Wallet | `HDWallet`, `Keys` |
| Funding | `selectRxdFunding`, `filterFundingCandidates`, `isFundingSafe`, `estimateFee`, `sumValue` |
| Tx | `buildTx`, `buildRxdTransfer` |
| Tokens | `mintFT`, `mintNFT`, `transferToken`, `encodeGlyph`, `ftScript`, `nftScript`, `parseTokenRef` |
| WAVE | `waveResolve`, `waveResolveAddress`, `waveLabel` |
| Script | `scriptHash`, `addressToScriptHash`, `p2pkhScript`, `isTokenBearing`, `zeroRefs`, `packRef`, `unpackRef` |
| Units | `rxdToPhotons`, `photonsToRxd` |
| Errors | `RadiantSdkError`, `InsufficientFundsError`, `TokenBurnGuardError`, `ElectrumError`, `ValidationError` |

---

## Design notes

- **radiantjs is wrapped, not duplicated.** All key/tx/script work delegates to
  `@radiant-core/radiantjs`; the SDK adds BigInt photons, ref‑safety, the
  ElectrumX transport, and Glyph/WAVE conveniences. The raw library is available
  via the `radiantjs` export if you need an escape hatch.
- **Fee rate.** Mainnet min‑relay is `10,000` photons/byte (since the V2 upgrade
  at block 410,000); testnet/regtest is `1,000`. These are exposed as
  `MIN_RELAY_FEE_RATE` and used as defaults — pin them, don't tune them.
  `buildTx` sets the fee from the *measured signed transaction size* (not an
  estimate), so token transactions carrying a CBOR envelope reliably clear the
  node's min‑relay floor. Funding selection reserves a little extra so a
  tightly‑funded wallet still has enough inputs; any surplus returns as change.
- **Endpoints.** The public mainnet ElectrumX is `wss://electrumx.radiantcore.org:443`
  (TLS on :443 only). WAVE resolution defaults to `https://radiantcore.org/api`.
  Both are overridable.

> ✅ **Mint/transfer flows are regtest‑validated.** `mintFT` / `mintNFT` /
> `transferToken` reproduce the proven Photonic‑Wallet on‑chain templates and
> have been run end‑to‑end against a real `radiantd` regtest node — commit +
> reveal accepted, outputs match `ftScript`/`nftScript` and carry the ref, FT
> amount and singleton ref preserved across transfers. They still broadcast
> real, irreversible transactions, so smoke‑test your own flow on
> regtest/testnet before mainnet.

## Building from source

Requires Node 20.19+ or 22+ (`require(ESM)` support; radiantjs pulls in an
ESM-only dependency).

```bash
npm install
npm run build      # tsup -> dist/ (ESM + CJS + d.ts)
npm run typecheck  # tsc --noEmit
npm test           # node --test against the built bundle
```

## License

MIT
