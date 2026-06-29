/**
 * WAVE name resolution.
 *
 * WAVE names resolve through the RXinDexer REST API:
 *   GET {base}/wave/resolve/{name}
 * The indexer keys on the BARE label (no domain suffix), so "alice.rxd" is
 * normalised to "alice" before the request. The canonical (first) registration
 * is always returned; later duplicates are tracked but not used for resolution.
 */

import { DEFAULT_REST_BASE } from "./constants.js";
import { ValidationError } from "./errors.js";
import type { WaveResolution } from "./types.js";

/** Options for WAVE resolution. */
export interface WaveResolveOptions {
  /** REST base URL. Default https://radiantcore.org/api */
  restBase?: string;
  /** Inject a fetch implementation (tests / non-global-fetch runtimes). */
  fetchImpl?: typeof fetch;
  /** AbortSignal to cancel the request. */
  signal?: AbortSignal;
}

/**
 * Normalise a WAVE name to the label the indexer resolves on: lowercase,
 * trimmed, with a single trailing suffix (e.g. ".rxd") stripped — mirroring the
 * REST endpoint's `rfind('.')` behaviour, so subdomains like "mail.alice.rxd"
 * become "mail.alice". Rejects empty names and leading/trailing dots.
 */
export function waveLabel(name: string): string {
  const trimmed = name.trim().toLowerCase();
  if (!trimmed || trimmed.startsWith(".") || trimmed.endsWith(".")) {
    throw new ValidationError(`waveLabel: invalid WAVE name ${JSON.stringify(name)}`);
  }
  const lastDot = trimmed.lastIndexOf(".");
  const label = lastDot > 0 ? trimmed.slice(0, lastDot) : trimmed;
  if (!label || label.length > 253) {
    throw new ValidationError(`waveLabel: invalid WAVE name ${JSON.stringify(name)}`);
  }
  return label;
}

/**
 * Resolve a WAVE name to its full record. Returns `registered: false` when the
 * name is available (unregistered) rather than throwing.
 */
export async function waveResolve(
  name: string,
  options: WaveResolveOptions = {},
): Promise<WaveResolution> {
  const label = waveLabel(name);
  const base = (options.restBase ?? DEFAULT_REST_BASE).replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new ValidationError(
      "waveResolve: no fetch implementation available; pass options.fetchImpl",
    );
  }

  const url = `${base}/wave/resolve/${encodeURIComponent(label)}`;
  const res = await doFetch(url, { signal: options.signal });
  if (!res.ok) {
    throw new ValidationError(
      `waveResolve: ${label} -> HTTP ${res.status} ${res.statusText}`,
    );
  }
  const data: any = await res.json();

  // Unregistered: indexer returns { name, available: true, resolved: false }.
  const registered = data?.available !== true && data?.resolved !== false;
  const zone = data?.zone ?? {};
  return {
    name: data?.name ?? label,
    registered,
    address: data?.target ?? zone?.address ?? undefined,
    ref: data?.ref ?? undefined,
    owner: data?.owner ?? undefined,
    expires: zone?.expires ?? undefined,
    records: zone?.records ?? undefined,
    raw: data,
  };
}

/**
 * Convenience: resolve a WAVE name straight to its target address, or null if
 * the name is unregistered or has no target.
 */
export async function waveResolveAddress(
  name: string,
  options: WaveResolveOptions = {},
): Promise<string | null> {
  const r = await waveResolve(name, options);
  return r.registered ? r.address ?? null : null;
}
