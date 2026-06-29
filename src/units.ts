/**
 * Photon <-> RXD conversion helpers.
 *
 * Internally the SDK uses photons as BigInt everywhere (1 RXD = 100,000,000
 * photons). These helpers exist for display/input at the application edge.
 * Never do balance math in floating point — use the BigInt photon value.
 */

import { PHOTONS_PER_RXD } from "./constants.js";
import { ValidationError } from "./errors.js";

/** Number of decimal places in a whole RXD (8). */
export const RXD_DECIMALS = 8;

/**
 * Convert an RXD amount to photons (BigInt). Accepts a number or a decimal
 * string; the string form avoids float rounding for large/precise amounts.
 *
 * @example rxdToPhotons("1.5") === 150_000_000n
 */
export function rxdToPhotons(rxd: string | number): bigint {
  const str = typeof rxd === "number" ? formatNumber(rxd) : rxd.trim();
  if (!/^-?\d*(\.\d*)?$/.test(str) || str === "" || str === "." || str === "-") {
    throw new ValidationError(`Invalid RXD amount: ${JSON.stringify(rxd)}`);
  }
  const negative = str.startsWith("-");
  const [whole, frac = ""] = (negative ? str.slice(1) : str).split(".");
  if (frac.length > RXD_DECIMALS) {
    throw new ValidationError(
      `RXD amount has more than ${RXD_DECIMALS} decimal places: ${str}`,
    );
  }
  const padded = frac.padEnd(RXD_DECIMALS, "0");
  const photons = BigInt(whole || "0") * PHOTONS_PER_RXD + BigInt(padded || "0");
  return negative ? -photons : photons;
}

/**
 * Convert photons (BigInt) to a fixed-point RXD string with 8 decimals,
 * trailing zeros trimmed (but at least one decimal kept).
 *
 * @example photonsToRxd(150_000_000n) === "1.5"
 */
export function photonsToRxd(photons: bigint): string {
  const negative = photons < 0n;
  const abs = negative ? -photons : photons;
  const whole = abs / PHOTONS_PER_RXD;
  const frac = abs % PHOTONS_PER_RXD;
  const fracStr = frac.toString().padStart(RXD_DECIMALS, "0").replace(/0+$/, "");
  const body = fracStr.length ? `${whole}.${fracStr}` : `${whole}.0`;
  return negative ? `-${body}` : body;
}

/** Format a JS number without scientific notation for parsing. */
function formatNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new ValidationError(`Invalid RXD amount: ${n}`);
  }
  // toFixed caps at RXD precision and avoids 1e-7 style output.
  return n.toFixed(RXD_DECIMALS);
}
