# x402 v2 client compatibility with the IMD swarm

Experimental, commissioned as a test of the IMD swarm. It may not work as described. Read the code, start with small amounts, no warranty.

## Result and method

Stock x402 v2 clients cannot complete the IMD paid-request flow unaided. The exact EVM signer produces a valid Permit2 witness signature, but it chooses a relative timeout rather than the quote's absolute deadline. The fetch and axios wrappers retry the protected request with only `PAYMENT-SIGNATURE`; IMD also requires a `QuoteApproval` signature in a JSON body. This adapter bridges those gaps and passes a local mock that verifies both signatures. No request to the live paid API and no onchain payment was made.

Tests ran on 2026-10-02 with Node 24.21.0 and Node 20.19.5. The checked-in test bundle contains `@x402/evm`, `@x402/core`, `@x402/fetch`, `@x402/axios`, and `@x402/extensions` **2.28.0**, with axios **1.12.2** and viem **2.48.11**. IMD's docs say its plane pins x402 **2.27.0**; this test deliberately checks the current v2 clients. `npm test` reruns the same bundled clients against [test/mock.mjs](test/mock.mjs). The mock models the [documented IMD 402 header and JSON challenge](https://imd.fun/docs/#paid), a live-style capabilities response, and an order that becomes admitted after polling. A body-only 402 variant tests the header dependency. The mock settles nothing.

### Pass/fail by step

`P` means the named client did that step with the local mock or a directly supplied requirement; `F` means it failed or lacks the step; `—` means it is a signer or core API with no HTTP transport. The adapter column is the implementation in this repository.

| Step | `@x402/evm` 2.28.0 | `@x402/core` 2.28.0 | `@x402/fetch` 2.28.0 | `@x402/axios` 2.28.0 | Adapter |
| --- | --- | --- | --- | --- | --- |
| Make bearer, POST quote, retain order ID | — | — | F: wrapper has no quote step | F: wrapper has no quote step | P |
| Read documented `PAYMENT-REQUIRED` header | — | P when supplied as object | P | P | P: reads challenge JSON |
| Select exact/Permit2 for IMD | P: direct requirement | F by default: IMD is outside allowed assets; P after explicit configuration | F by default; P after explicit configuration | F by default; P after explicit configuration | P: validates `accepts[0]`, quote, capabilities and cap |
| Sign Permit2 witness | P: signature recovered to test wallet | P after asset configuration | P after asset configuration | P after asset configuration | P: signature recovered by mock |
| End deadline by `quote.expiresAt - 5s` | F: `now + maxTimeoutSeconds` exceeded mock quote window | F | F | F | P |
| Sign quote-bound `QuoteApproval` over payment SHA-256 | F | F | F | F | P |
| Submit same order with `PAYMENT-SIGNATURE` and `{quoteSignature}` | — | — | F: retried with header but no required body; mock returned 400 | F: same 400 | P: mock returned 202 |
| Poll with same bearer until terminal status | — | — | F | F | P |

With a body-only 402 and no `PAYMENT-REQUIRED` header, both wrappers fail at parsing (`Invalid payment required response`) after one HTTP call. IMD's current [docs](https://imd.fun/docs/#paid) say the header is present; this is a conditional test of the challenge description, not a claim that the live server omits it. With the documented header, the wrappers first reject IMD under default `spendControls` because it is a non-default asset. Setting `allowedAssets: true` and disabling the default dollar cap got each wrapper to a second request, which the mock rejected as `invalid_payment_shape` because the body omitted `quoteSignature`. Those settings were used only in the local test; a production client should allowlist IMD with an atomic spend cap.

## Where the protocols diverge

The [x402 v2 specification](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md) describes `PaymentRequired` in a `PAYMENT-REQUIRED` header, a `PaymentPayload` in `PAYMENT-SIGNATURE`, and a retry of the resource request. IMD's 402 header follows that v2 envelope, and its `accepts[0]` follows the [exact EVM Permit2 scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md): Ethereum mainnet, a Permit2 witness transfer, and the canonical exact proxy. These parts are compatible.

IMD adds an order and quote before the 402, binds the authorization to that quote with a second EIP-712 message, requires the second signature in the POST body, requires the Permit2 deadline to precede the quote expiry, and returns a pending order that must be polled. Those are IMD flow requirements absent from the standard wrappers. The x402 `maxTimeoutSeconds` permits the stock signer to choose `now + maxTimeoutSeconds`; it does not tell that signer about IMD's earlier absolute quote expiry. IMD's strict payment parser also rejects nonempty or unexpected extension fields even though x402 v2 defines an extensible `extensions` map; the adapter emits exactly `x402Version`, `resource`, `accepted`, and `payload` and no extension field. This is the material x402 extensibility mismatch. IMD's bearer and server-side-only origin policy are application access rules, not an EVM scheme mismatch. The one-time token allowance to Permit2 is a normal Permit2 prerequisite, and the server-funded settlement gas matches the exact EVM scheme.

The [IMD docs](https://imd.fun/docs/#paid) say `resource.url` must equal the order's `resourceUrl`, `accepted` must equal the first offer, and an extra key at any payment depth can fail as `invalid_payment_shape`. The adapter verifies those equalities, the IMD asset and mainnet, quote and capabilities payment terms, the user's atomic spend cap, and the safe expiry before it asks the signer for either signature. The serialized payment is hashed with SHA-256 after recursive key sorting and no whitespace, exactly as IMD specifies. It signs the Permit2 EIP-712 domain (`Permit2`, chain 1, canonical Permit2 contract) and the IMD `QuoteApproval` domain (`IdentityMD Paid Action`, version `1`, chain 1). The mock independently recovers both EIP-712 signatures with ethers and checks the payment header/body shape.

## Smallest practical bridge

The necessary adapter steps are: (1) quote with a persistent random bearer and UUID, (2) obtain the 402 challenge and capabilities, (3) reject any asset, amount, network, recipient or expiry mismatch, (4) sign the exact Permit2 witness with a deadline capped at `quote.expiresAt - 5`, (5) hash the exact payment JSON and sign `QuoteApproval`, (6) submit both pieces and poll. [src/adapter.ts](src/adapter.ts) implements these steps with an injected viem-style signer and no runtime package dependency. [src/cli.ts](src/cli.ts) supplies an ethers wallet signer. The payment cannot be fixed by editing the stock signer output after signing: changing the deadline changes the Permit2 typed-data digest, so it must be signed again. A wrapper hook could orchestrate the quote and second signature, but it would still need to replace the wrapper's normal retry body and polling behavior.

## Discovery listing and submission

[discovery/listing.draft.json](discovery/listing.draft.json) is a draft v2 `GET /discovery/resources` response with one dynamic HTTP route and a Bazaar extension. The atomic amount is the documented 0.5 IMD; the zero `payTo` is an explicit placeholder because this project did not query the live capabilities endpoint. The `:id` path is a template; an actual caller must quote before it has an ID. It must not be published until the operator supplies the current payee, price and timeout and explains the quote prerequisite to clients.

The x402 v2 spec publishes the [discovery response fields](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md#8-discovery-api), and `@x402/extensions` publishes validators for the Bazaar `info`/`schema` extension. I did **not** find a published machine-readable JSON Schema for the whole `GET /discovery/resources` response, so whole-listing validation against such a schema could not be checked. The committed `npm test` checks the envelope against the published field descriptions, the offer against `@x402/core` 2.28.0 `PaymentRequirementsV2Schema`, and the Bazaar block against both `validateDiscoveryExtension` and `validateDiscoveryExtensionSpec` from `@x402/extensions` 2.28.0; all passed.

The [Bazaar documentation](https://github.com/x402-foundation/x402/blob/main/docs/extensions/bazaar.mdx) describes indexing from a server-declared Bazaar extension in `PaymentRequired`, echoed in a payment handled by a participating facilitator. A listing is not submitted by POSTing to the read-only discovery API. To submit this draft, IMD's operator would first need to support that declaration and catalog path, or a specific catalog operator would need to accept a manual listing. IMD's current strict payload shape means a normal nonempty Bazaar extension echo would be rejected, so the draft is not advertised as indexed or directly payable by stock clients.

## Check result and limits

`npm test`: **10 local tests passed**; the tests use a local HTTP server, test wallet signatures, the bundled published clients, and the draft validators. No live payment, balance, allowance, facilitator settlement, or 403 browser response was tested. Live behavior can change; `/requests/capabilities` and `/openapi.json` remain the sources for current prices, action limits and launch chains.
