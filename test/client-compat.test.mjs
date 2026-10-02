import test from 'node:test';
import assert from 'node:assert/strict';
import ethers from '../vendor/ethers.cjs';
import x402 from '../vendor/x402-clients.cjs';
const {
  ExactEvmScheme, registerExactEvmScheme, x402Client,
  wrapFetchWithPayment, wrapAxiosWithPayment, axios
} = x402;
import { PERMIT2 } from '../dist/adapter.js';
import { createMock } from './mock.mjs';

const wallet = new ethers.Wallet('0x' + '12'.repeat(32));
const signer = { address: wallet.address, signTypedData: ({ domain, types, message }) => wallet.signTypedData(domain, types, message) };
const orderUrl = mock => `${mock.baseUrl}/requests/11111111-2222-4333-8444-555555555555/submit`;
function client(allowImd = false) {
  const value = new x402Client();
  registerExactEvmScheme(value, { signer });
  if (allowImd) value.setSpendControls({ allowedAssets: true, maxAmountPerPayment: false });
  return value;
}
async function quote(mock) {
  const response = await fetch(`${mock.baseUrl}/requests/quote`, {
    method: 'POST', headers: { Authorization: `Bearer ${mock.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestKey: '11111111-2222-4333-8444-555555555555', action: 'local.echo', input: {} })
  });
  assert.equal(response.status, 201);
}

test('@x402/evm exact signer makes Permit2 authorization but misses quote deadline', async () => {
  const mock = await createMock();
  try {
    const partial = await new ExactEvmScheme(signer).createPaymentPayload(2, mock.requirement);
    assert.deepEqual(Object.keys(partial), ['x402Version', 'payload']);
    const auth = partial.payload.permit2Authorization;
    assert.equal(auth.spender.toLowerCase(), '0x402085c248eea27d92e8b30b2c58ed07f9e20001');
    assert.equal(auth.witness.validAfter, '0');
    assert.ok(Number(auth.deadline) > mock.challenge.quote.expiresAt - 5);
    const recovered = ethers.verifyTypedData(
      { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 },
      {
        PermitWitnessTransferFrom: [
          { name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' },
          { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'witness', type: 'Witness' }
        ],
        TokenPermissions: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
        Witness: [{ name: 'to', type: 'address' }, { name: 'validAfter', type: 'uint256' }]
      }, auth, partial.payload.signature
    );
    assert.equal(recovered.toLowerCase(), wallet.address.toLowerCase());
  } finally { await mock.close(); }
});

test('@x402/core rejects IMD by default; configured core creates a standard payment', async () => {
  const mock = await createMock();
  try {
    const required = { x402Version: 2, resource: mock.challenge.resource, accepts: [mock.requirement] };
    await assert.rejects(client().createPaymentPayload(required), /only default assets/);
    const payment = await client(true).createPaymentPayload(required);
    assert.equal(payment.x402Version, 2);
    assert.equal(payment.accepted.asset, mock.requirement.asset);
    assert.equal(payment.resource.url, mock.challenge.resourceUrl);
    assert.equal(payment.extensions, undefined);
    assert.ok(Number(payment.payload.permit2Authorization.deadline) > mock.challenge.quote.expiresAt - 5);
  } finally { await mock.close(); }
});

test('@x402/fetch cannot finish the documented challenge, even with IMD asset enabled', async () => {
  const mock = await createMock();
  try {
    await quote(mock);
    const init = { method: 'POST', headers: { Authorization: `Bearer ${mock.token}` } };
    await assert.rejects(wrapFetchWithPayment(fetch, client())(orderUrl(mock), init), /only default assets/);
    assert.equal(mock.state.requests.filter(r => r.url.endsWith('/submit')).length, 1);
    const response = await wrapFetchWithPayment(fetch, client(true))(orderUrl(mock), init);
    assert.equal(response.status, 400);
    assert.match(await response.text(), /quoteSignature/);
    assert.equal(mock.state.requests.filter(r => r.url.endsWith('/submit')).length, 3);
    assert.equal(mock.state.paid, false);
  } finally { await mock.close(); }
});

test('@x402/axios cannot finish the documented challenge, even with IMD asset enabled', async () => {
  const mock = await createMock();
  try {
    await quote(mock);
    const base = { headers: { Authorization: `Bearer ${mock.token}` } };
    await assert.rejects(wrapAxiosWithPayment(axios.create(), client()).post(orderUrl(mock), undefined, base), /only default assets/);
    await assert.rejects(
      wrapAxiosWithPayment(axios.create(), client(true)).post(orderUrl(mock), undefined, base),
      error => error.response?.status === 400 && /quoteSignature/.test(error.response.data.error)
    );
    assert.equal(mock.state.requests.filter(r => r.url.endsWith('/submit')).length, 3);
    assert.equal(mock.state.paid, false);
  } finally { await mock.close(); }
});

test('without PAYMENT-REQUIRED header both wrappers reject the body-only challenge', async () => {
  const mock = await createMock({ standardHeader: false });
  try {
    await quote(mock);
    await assert.rejects(
      wrapFetchWithPayment(fetch, client(true))(orderUrl(mock), { method: 'POST', headers: { Authorization: `Bearer ${mock.token}` } }),
      /Invalid payment required response/
    );
    await assert.rejects(
      wrapAxiosWithPayment(axios.create(), client(true)).post(orderUrl(mock), undefined, { headers: { Authorization: `Bearer ${mock.token}` } }),
      /Invalid payment required response/
    );
  } finally { await mock.close(); }
});
