/** Typed error classes so callers can branch on failure modes. */

/** Base class for every error thrown by the SDK. */
export class RadiantSdkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Thrown when a request cannot be funded from the available UTXO set. */
export class InsufficientFundsError extends RadiantSdkError {
  constructor(
    readonly requiredPhotons: bigint,
    readonly availablePhotons: bigint,
  ) {
    super(
      `Insufficient funds: need ${requiredPhotons} photons (incl. fee) but only ${availablePhotons} available in token-free UTXOs`,
    );
  }
}

/**
 * Thrown when a token-bearing UTXO is about to be spent as discretionary RXD
 * funding — doing so would silently burn the token. This is the SDK's primary
 * safety backstop.
 */
export class TokenBurnGuardError extends RadiantSdkError {
  constructor(readonly txid: string, readonly vout: number) {
    super(
      `Refusing token-bearing UTXO ${txid}:${vout} as RXD funding (would burn the token)`,
    );
  }
}

/** Thrown for ElectrumX transport/protocol failures. */
export class ElectrumError extends RadiantSdkError {
  constructor(message: string, readonly code?: number) {
    super(message);
  }
}

/** Thrown when an input/argument is malformed. */
export class ValidationError extends RadiantSdkError {}
