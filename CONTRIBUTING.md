# Contributing to `@radiant-core/sdk`

Thanks for helping improve the Radiant dapp SDK.

## Development

```bash
git clone https://github.com/Radiant-Core/radiant-sdk.git
cd radiant-sdk
npm install
npm run build      # tsup -> dist/ (ESM + CJS + d.ts)
npm run typecheck  # tsc --noEmit
npm test           # node --test against the built bundle
```

Requires **Node 20.19+ or 22+** (radiantjs pulls in an ESM-only dependency that
needs `require(ESM)` support).

## Ground rules

- **radiantjs is wrapped, not duplicated.** All key/tx/script/signing work
  delegates to `@radiant-core/radiantjs`. Touch the underlying library only via
  `src/radiantjs.ts`.
- **Photons are `BigInt` everywhere** internally. Convert to/from RXD only at the
  edge with `rxdToPhotons` / `photonsToRxd`.
- **Never gather RXD funding by a value heuristic.** Token-bearing UTXOs must be
  excluded from funding (`isFundingSafe` / `selectRxdFunding`) — spending one
  burns the token. New code that selects inputs must preserve this invariant.
- **Keep dependencies minimal** — radiantjs + `cbor-x` (+ optional `ws`).
- Match the surrounding style: small, documented, pure where possible.

## Tests

`test/sdk.test.mjs` covers the pure + radiantjs-backed surface and runs against
the built bundle. Add cases there for new behaviour. Anything that touches the
chain (mint/transfer/broadcast) should additionally be validated on **regtest**
before it ships — see the validation summary in the README.

## Pull requests

1. Branch from `main`.
2. `npm run typecheck && npm run build && npm test` must pass.
3. Update `docs/API.md` and `CHANGELOG.md` for any public API change.
4. Keep PRs focused; describe the user-facing effect.

## Releasing (maintainers)

```bash
# bump version in package.json + CHANGELOG.md, then:
npm publish --access public   # prepublishOnly rebuilds dist/
git tag v<version> && git push --tags
```
