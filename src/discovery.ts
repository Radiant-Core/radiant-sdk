/**
 * Token discovery — global, newest-first asset lists.
 *
 * Backed by the RXinDexer v4 discovery indexes (Glyph DB schema 4,
 * deployed 2026-07-18):
 *   GET {base}/glyphs/recent                      — newest across ALL types
 *   GET {base}/glyphs/by-type/{typeId}?order=…    — one type, ref or recent order
 *
 * Pages are cursor-paginated: pass the previous response's `nextCursor` back
 * to fetch the next page. Cursors are opaque, URL-safe strings, and are
 * order-specific — never reuse a cursor across a change of `order` or type.
 *
 * The killer pattern this enables is an incremental watermark sync: do one
 * full walk, remember the newest `deploy_height` you saw, then on later runs
 * page newest-first and STOP as soon as `deploy_height` drops below your
 * watermark — you only ever pay for tokens minted since the last run.
 */

import { DEFAULT_REST_BASE } from "./constants.js";
import { ValidationError } from "./errors.js";

/** GlyphTokenType ids as served by the indexer (`type` field). */
export const GLYPH_TOKEN_TYPE = {
  UNKNOWN: 0,
  FT: 1,
  NFT: 2,
  DAT: 3,
  DMINT: 4,
  WAVE: 5,
  CONTAINER: 6,
  AUTHORITY: 7,
} as const;

export type GlyphTokenTypeId =
  (typeof GLYPH_TOKEN_TYPE)[keyof typeof GLYPH_TOKEN_TYPE];

/**
 * One token row from a discovery list. Only the stable, always-present core is
 * typed; the indexer returns many more fields (supply, dMint, icon, attrs, …)
 * which remain reachable through the index signature.
 */
export interface GlyphTokenSummary {
  /** Display ref: big-endian txid + "_" + vout (canonical output form). */
  ref: string;
  /** 72-hex internal ref (raw index key bytes) — feed this to get_by_ref-style APIs. */
  ref_hex: string;
  /** Primary token type id (see GLYPH_TOKEN_TYPE). */
  type: number;
  type_name: string;
  /** Glyph protocol ids the token carries (1=FT, 2=NFT, 8=ENCRYPTED, 11=WAVE, …). */
  protocols: number[];
  name: string | null;
  ticker: string | null;
  deploy_height: number;
  deploy_txid: string;
  is_spent: boolean;
  [extra: string]: unknown;
}

/** One page of a discovery list. */
export interface TokenPage {
  tokens: GlyphTokenSummary[];
  /** Pass back as `cursor` to fetch the next page; null = no more pages. */
  nextCursor: string | null;
}

/** Options shared by the discovery queries. */
export interface DiscoveryOptions {
  /** Max rows per page (indexer caps at 500). Default 100. */
  limit?: number;
  /** Opaque cursor from the previous page's `nextCursor`. */
  cursor?: string;
  /** REST base URL. Default https://radiantcore.org/api */
  restBase?: string;
  /** Inject a fetch implementation (tests / non-global-fetch runtimes). */
  fetchImpl?: typeof fetch;
  /** AbortSignal to cancel the request. */
  signal?: AbortSignal;
}

async function fetchTokenPage(
  path: string,
  params: Record<string, string | number | undefined>,
  options: DiscoveryOptions,
  fnName: string,
): Promise<TokenPage> {
  const base = (options.restBase ?? DEFAULT_REST_BASE).replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new ValidationError(
      `${fnName}: no fetch implementation available; pass options.fetchImpl`,
    );
  }

  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) query.set(k, String(v));
  }
  const qs = query.toString();
  const url = `${base}${path}${qs ? `?${qs}` : ""}`;

  const res = await doFetch(url, { signal: options.signal });
  if (!res.ok) {
    throw new ValidationError(`${fnName}: HTTP ${res.status} ${res.statusText}`);
  }
  const data: any = await res.json();
  return {
    tokens: Array.isArray(data?.tokens) ? data.tokens : [],
    nextCursor: data?.next_cursor ?? null,
  };
}

/**
 * Newest-deployed tokens across every type (or one type via `typeId`),
 * newest-first.
 */
export async function getRecentTokens(
  options: DiscoveryOptions & { typeId?: GlyphTokenTypeId | number } = {},
): Promise<TokenPage> {
  return fetchTokenPage(
    "/glyphs/recent",
    { limit: options.limit, cursor: options.cursor, type_id: options.typeId },
    options,
    "getRecentTokens",
  );
}

/**
 * Tokens of one type. `order: "recent"` = newest-deployed first;
 * `order: "ref"` (default, matches the pre-v4 API) = stable ref-hash order.
 * Cursors are order-specific.
 */
export async function getTokensByType(
  typeId: GlyphTokenTypeId | number,
  options: DiscoveryOptions & { order?: "ref" | "recent" } = {},
): Promise<TokenPage> {
  if (!Number.isInteger(typeId) || typeId < 0 || typeId > 7) {
    throw new ValidationError(`getTokensByType: invalid typeId ${typeId}`);
  }
  return fetchTokenPage(
    `/glyphs/by-type/${typeId}`,
    { limit: options.limit, cursor: options.cursor, order: options.order },
    options,
    "getTokensByType",
  );
}
