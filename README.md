# imd-x402-compat

Experimental, commissioned as a test of the IMD swarm. It may not work as described. Read the code, start with small amounts, no warranty.

A Node 20+ TypeScript adapter for IMD's paid x402 exact/Permit2 requests. It creates the x402 payment, signs IMD's extra `QuoteApproval`, submits both, and polls the order. The [compatibility report](report.md) shows why the stock x402 fetch and axios wrappers cannot finish this flow. All tests use a local HTTP mock and never transfer tokens.

## Run it in five minutes

No install or network is needed to build and test: the TypeScript compiler, the CLI's ethers signer, and the tested x402 clients are vendored as ordinary files.

```sh
npm test
node dist/cli.js --help
```

For a real paid request, read the current [IMD paid-request docs](https://imd.fun/docs/#paid) and `GET https://api.imd.fun/openapi.json` for an enabled action and valid input. `GET https://api.imd.fun/requests/capabilities` gives the live price, asset, recipient and quote lifetime. Your wallet needs IMD on Ethereum mainnet and a one-time ERC-20 `approve` allowing the canonical Permit2 contract (`0x000000000022D473030F116dDEE9F6B43aC78BA3`) to spend IMD. The wallet pays gas for that approval; the IMD server pays gas for a paid request. This package does not send the approval transaction.

```sh
export IMD_PRIVATE_KEY='0x...your-wallet-private-key...'
export IMD_PAID_TOKEN="$(openssl rand -hex 32)"  # save this to read the order later
node dist/cli.js --execute \
  --action job.open \
  --input '{"objective":"Write a sourced report comparing three approaches to deterministic EVM testing.","skill":"research-report","outputs":[{"name":"report","path":"artifacts/report.md","mediaType":"text/markdown"}],"minCitations":5,"github":false}' \
  --max-amount 500000000000000000 \
  --bearer-token "$IMD_PAID_TOKEN"
```

The example cap is 0.5 IMD in atomic units, as documented by IMD on 2026-10-02. The CLI requires `--execute`; running the example authorizes one paid action. It refuses an offer above the cap or one that differs from the quote or live capabilities. It is intended for a server-side Node process: IMD's paid routes return 403 for cross-origin browser requests. Keep the bearer token and wallet key private. If a request times out, query `GET /requests/{id}` with the same bearer; do not start a new payment just because the HTTP response was lost.

Before paying, the public `POST /requests/check` can evaluate `{action,input}` without charging; its verdict is noisy, so retry up to three times. `POST /requests/import` accepts a public GitHub URL and kind (`site`, `contracts`, or `code`) and returns the `repoUrl` and `baseCommit` needed for some job inputs. The adapter itself does not call these helpers.

## Use as a library

`runPaidAction(action, input, signer, options)` is exported from [src/adapter.ts](src/adapter.ts). The signer has an `address` and a `signTypedData({domain, types, primaryType, message})` method, compatible with viem-style EVM signers. Pass a saved 64-character hex `bearerToken` and `maxAmount` as a `bigint` in atomic IMD units. Use `onQuoted(orderId)` to save the order ID before signing; the CLI prints it. `baseUrl` and `fetch` can point it at a local mock. `createPayment(challenge, signer, maxAmount)` signs only and performs no HTTP request. The package exposes the exact payment type and EIP-712 message types for other transports.

The paid state transitions are: the requester quotes to get fixed terms (no gas); the wallet signs Permit2 and QuoteApproval because it wants that specific action and price (no gas); the IMD server settles Permit2 and pays gas because it collects the payment; the server admits work after payment; the requester polls until the order leaves its pending states. The initial one-time ERC-20 approval is initiated and paid for by the wallet. IMD is a service with a server operator: payment and admission depend on that operator remaining available. No live request or onchain transaction was used in this project's tests.

## Discovery draft

[discovery/listing.draft.json](discovery/listing.draft.json) follows the x402 v2 `GET /discovery/resources` response format and includes a Bazaar discovery extension. It is a **draft**: replace the zero-address `payTo` with the live value from `/requests/capabilities`, verify its amount and timeout, and provide a catalog route that explains the prerequisite quote. The `:id` URL is a route template, not a usable order URL. Bazaar discovery is generally indexed from a resource server's `PAYMENT-REQUIRED` extension echoed in a payment settled by a participating facilitator; `GET /discovery/resources` is a read endpoint, not a submission endpoint. IMD currently rejects nonempty extra payment fields, so its operator or a catalog operator would need to support that discovery path before this draft could be submitted. The [report](report.md) records the validation performed.

The source builds offline with `npm run build`; `npm test` rebuilds and runs the local mock and client compatibility tests. The vendored x402 client bundle is test-only, not a runtime dependency of the adapter. Vendored licenses and notices are in `vendor/`.

Commissioned through paid IMD swarm requests.
