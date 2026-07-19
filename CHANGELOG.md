# Changelog

All notable changes to `@radiant-core/sdk` are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-07-18

### Added

- **Token discovery** (`getRecentTokens`, `getTokensByType`,
  `GLYPH_TOKEN_TYPE`) — global newest-first asset lists over the RXinDexer v4
  discovery indexes (`/glyphs/recent`, `/glyphs/by-type/{id}?order=recent`),
  cursor-paginated with typed pages (`TokenPage`, `GlyphTokenSummary`).
  Enables incremental watermark sync: walk once, then on later runs page
  newest-first and stop below your saved `deploy_height`. Requires an indexer
  running Glyph DB schema v4 (live on the public API since 2026-07-18).
- **`transferFungible`** — send part of an FT balance: multi-UTXO
  accumulation with an FT change output back to the sender. Additive;
  `transferToken` still moves a single UTXO wholesale.
- **Shape-exact script parsers** (`parseNftScript`, `parseFtScript`,
  `parseP2pkhScript`, `tokenScriptKind`) — security-critical primitives for
  validating what a prevout actually holds (e.g. maker advertises X,
  prevout is Y). On auth-form (mutable/WAVE) NFTs, `parseNftScript` returns
  the SINGLETON ref where a loose first-ref scan would return the mutable
  ref.

### Fixed

- **`transferToken` for WAVE names / mutable NFTs** — previously the node
  rejected the transfer (`invalid-transaction-reference-operations`): the
  output was rebuilt by editing the on-chain script in place, carrying the
  mutable covenant's auth preamble (`OP_REQUIREINPUTREF`) into the output.
  Outputs are now rebuilt canonically (`nftScript`/`ftScript`), dropping the
  preamble — proven on-chain against a regtest node
  (`test/regtest.test.mjs`, skips when no node is available).
- **`buildTx` fee guard** (`assertSaneFee`, `MAX_REASONABLE_FEE_RATE`) —
  catches the three silent burn paths: photons/byte ↔ sats/kB unit slips,
  `addChange: false` over-funding, and radiantjs rolling sub-dust change
  into the fee. Measured against the per-network ceiling, not the caller's
  fee rate.

## [0.1.0] — 2026-06-28

Initial release.

### Added

- **ElectrumX WebSocket client** (`ElectrumClient`) — `getBalance`,
  `listUnspent`, `getHistory`, `getTransaction`, `subscribe`/`unsubscribe`,
  `broadcastTx`, and a `request` escape hatch. Auto-reconnect with exponential
  backoff + jitter; isomorphic (global `WebSocket`, or the optional `ws` peer on
  Node < 22).
- **Ref-safe UTXO selection** (`selectRxdFunding`, `filterFundingCandidates`,
  `isFundingSafe`, `assertFundingSafe`) — never spends a token-bearing UTXO as
  RXD funding, so a raw `listUnspent()` result is safe to pass in.
- **Glyph token operations** (`mintFT`, `mintNFT`, `transferToken`) via the
  commit/reveal pattern, plus `encodeGlyph`, `ftScript`, `nftScript`,
  `parseTokenRef`.
- **WAVE name resolution** (`waveResolve`, `waveResolveAddress`, `waveLabel`).
- **HD wallets** (`HDWallet`, `Keys`) at `m/44'/512'/0'/0/k` (SLIP-0044 512).
- **Transaction building** (`buildRxdTransfer`, `buildTx`) — fee set from the
  measured signed size so token txs clear the min-relay floor.
- **Script + unit helpers** — `scriptHash`, `zeroRefs`, `isTokenBearing`,
  `packRef`/`unpackRef`, `rxdToPhotons`/`photonsToRxd`. Photons are `BigInt`
  throughout.
- Typed errors (`RadiantSdkError`, `InsufficientFundsError`,
  `TokenBurnGuardError`, `ElectrumError`, `ValidationError`).
- Dual ESM + CJS build with bundled TypeScript types; tree-shakeable.

### Validated

- 9 unit test groups (run in CI on Node 20/22/24).
- 15 on-chain consensus assertions against a `radiantd` regtest node (FT/NFT
  mint + transfer).
- 14 indexer assertions against RXinDexer/ElectrumX (tokens surfaced via
  `listUnspent` with `refs`; SDK `zeroRefs` confirmed byte-identical to the
  indexer's keying).

### Notes

- Requires Node 20.19+ or 22+ (`require(ESM)` support; radiantjs pulls in an
  ESM-only dependency).

[0.2.0]: https://github.com/Radiant-Core/radiant-sdk/releases/tag/v0.2.0
[0.1.0]: https://github.com/Radiant-Core/radiant-sdk/releases/tag/v0.1.0
