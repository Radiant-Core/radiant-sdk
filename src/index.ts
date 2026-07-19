/**
 * @radiant-core/sdk — build Radiant (RXD) dapps without reading internal
 * Photonic/radiantjs source.
 *
 * Modules:
 * - client : ElectrumX WebSocket client (balance, UTXOs, broadcast, subscribe)
 * - wallet : SLIP-0044 HD key derivation (m/44'/512'/0'/0/k)
 * - utxo   : ref-safe RXD funding selection (never burns tokens)
 * - tokens : Glyph FT/NFT mint + transfer (commit/reveal)
 * - wave   : WAVE name resolution
 * - discovery : global newest-first token lists (RXinDexer v4)
 * - units  : photon <-> RXD conversion (BigInt photons internally)
 */

// Core types
export type {
  NetworkName,
  Utxo,
  UtxoRef,
  TxOutput,
  FundingSelection,
  ScriptHashBalance,
  WaveResolution,
} from "./types.js";

// Errors
export {
  RadiantSdkError,
  InsufficientFundsError,
  TokenBurnGuardError,
  ElectrumError,
  ValidationError,
} from "./errors.js";

// Constants (selected, useful ones)
export {
  PHOTONS_PER_RXD,
  RADIANT_COIN_TYPE,
  MIN_RELAY_FEE_RATE,
  DUST_LIMIT,
  DEFAULT_ELECTRUM_ENDPOINT,
  DEFAULT_REST_BASE,
  GLYPH_PROTOCOL,
} from "./constants.js";

// Units
export { rxdToPhotons, photonsToRxd, RXD_DECIMALS } from "./units.js";

// Script / ref-safety primitives
export {
  scriptHash,
  addressToScriptHash,
  p2pkhScript,
  isTokenBearing,
  zeroRefs,
  packRef,
  unpackRef,
  parseP2pkhScript,
  parseNftScript,
  parseFtScript,
  tokenScriptKind,
  type TokenScriptKind,
} from "./script.js";

// ElectrumX client
export {
  ElectrumClient,
  type ElectrumClientOptions,
} from "./client.js";

// HD wallet
export {
  HDWallet,
  Keys,
  type HDWalletOptions,
  type DerivedKey,
} from "./wallet.js";

// UTXO selection
export {
  selectRxdFunding,
  filterFundingCandidates,
  assertFundingSafe,
  isFundingSafe,
  estimateFee,
  sumValue,
  type SelectRxdFundingOptions,
} from "./utxo.js";

// Transaction building
export {
  buildTx,
  buildRxdTransfer,
  type BuildTxParams,
  type BuildTxInput,
  type BuiltTx,
} from "./tx.js";

// Glyph tokens
export {
  mintFT,
  mintNFT,
  transferToken,
  transferFungible,
  type TransferFungibleParams,
  encodeGlyph,
  ftScript,
  nftScript,
  parseTokenRef,
  type GlyphPayload,
  type MintResult,
  type MintFtParams,
  type MintNftParams,
  type TransferTokenParams,
} from "./tokens.js";

// WAVE names
export {
  waveResolve,
  waveResolveAddress,
  waveLabel,
  type WaveResolveOptions,
} from "./wave.js";

// Token discovery (RXinDexer v4 — newest-first global asset lists)
export {
  getRecentTokens,
  getTokensByType,
  GLYPH_TOKEN_TYPE,
  type GlyphTokenTypeId,
  type GlyphTokenSummary,
  type TokenPage,
  type DiscoveryOptions,
} from "./discovery.js";

// radiantjs escape hatch (advanced users who need the raw library)
export { radiantjs } from "./radiantjs.js";
