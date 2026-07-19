# Changelog

All notable changes to `@radiant-core/sdk` are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Token discovery** (`getRecentTokens`, `getTokensByType`,
  `GLYPH_TOKEN_TYPE`) — global newest-first asset lists over the RXinDexer v4
  discovery indexes (`/glyphs/recent`, `/glyphs/by-type/{id}?order=recent`),
  cursor-paginated with typed pages (`TokenPage`, `GlyphTokenSummary`).
  Enables incremental watermark sync: walk once, then on later runs page
  newest-first and stop below your saved `deploy_height`. Requires an indexer
  running Glyph DB schema v4 (deployed to the public API 2026-07-18).

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

[0.1.0]: https://github.com/Radiant-Core/radiant-sdk/releases/tag/v0.1.0
