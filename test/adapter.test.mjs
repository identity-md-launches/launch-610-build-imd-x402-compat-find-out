import test from 'node:test';
import assert from 'node:assert/strict';
import ethers from '../vendor/ethers.cjs';
import { createPayment, runPaidAction, validateChallenge, canonicalJson, sha256Hex } from '../dist/adapter.js';
import { createMock } from './mock.mjs';

const wallet = new ethers.Wallet('0x' + '12'.repeat(32));
const signer = { address: wallet.address, signTypedData: ({ domain, types, message }) => wallet.signTypedData(domain, types, message) };
const maxAmount = 500000000000000000n;

test('full quoted flow signs both messages and polls a local mock', async () => {
  const mock = await createMock();
  try {
    let quotedId;
    const result = await runPaidAction('local.echo', { text: 'hello' }, signer, {
      baseUrl: mock.baseUrl, bearerToken: mock.token, maxAmount, pollIntervalMs: 1,
      onQuoted: id => { quotedId = id; }
    });
    assert.equal(quotedId, '11111111-2222-4333-8444-555555555555');
    assert.deepEqual(result, { status: 'admitted', admission: { result: { echoed: true } } });
    assert.equal(mock.state.paid, true);
    assert.equal(mock.state.quoteCount, 1);
    assert.equal(mock.state.polls, 2);
    assert.deepEqual(mock.state.requests.map(r => [r.method, r.url]), [
      ['POST', '/requests/quote'], ['POST', '/requests/11111111-2222-4333-8444-555555555555/submit'],
      ['GET', '/requests/capabilities'],
      ['POST', '/requests/11111111-2222-4333-8444-555555555555/submit'],
      ['GET', '/requests/11111111-2222-4333-8444-555555555555'],
      ['GET', '/requests/11111111-2222-4333-8444-555555555555']
    ]);
  } finally { await mock.close(); }
});

test('payment uses exactly the required fields, a random nonce, and quote-capped deadline', async () => {
  const mock = await createMock();
  try {
    const a = await createPayment(mock.challenge, signer, maxAmount);
    const b = await createPayment(mock.challenge, signer, maxAmount);
    assert.deepEqual(Object.keys(a.payment), ['x402Version', 'resource', 'accepted', 'payload']);
    assert.notEqual(a.payment.payload.permit2Authorization.nonce, b.payment.payload.permit2Authorization.nonce);
    assert.ok(Number(a.payment.payload.permit2Authorization.deadline) <= mock.challenge.quote.expiresAt - 5);
    assert.equal(a.paymentHash, await sha256Hex(canonicalJson(a.payment)));
  } finally { await mock.close(); }
});

test('rejects unsupported offer, quote mismatch, overspend and expiry before signing', async () => {
  const mock = await createMock();
  try {
    assert.throws(() => validateChallenge(mock.challenge, maxAmount - 1n), /Amount exceeds cap/);
    assert.throws(() => validateChallenge({ ...mock.challenge, accepts: [{ ...mock.requirement, network: 'eip155:8453' }] }, maxAmount), /mainnet/);
    assert.throws(() => validateChallenge({ ...mock.challenge, accepts: [{ ...mock.requirement, extra: {} }] }, maxAmount), /Permit2/);
    assert.throws(() => validateChallenge({ ...mock.challenge, accepts: [{ ...mock.requirement, amount: '1' }] }, maxAmount), /Amount differs/);
    assert.throws(() => validateChallenge({ ...mock.challenge, quote: { ...mock.challenge.quote, expiresAt: Math.floor(Date.now() / 1000) + 3 } }, maxAmount), /expires too soon/);
  } finally { await mock.close(); }
});

test('quote validation error stays unpaid', async () => {
  const mock = await createMock();
  try {
    await assert.rejects(runPaidAction('bad.action', {}, signer, {
      baseUrl: mock.baseUrl, bearerToken: mock.token, maxAmount
    }), /422.*invalid_input/);
    assert.equal(mock.state.paid, false);
    assert.equal(mock.state.requests.length, 1);
  } finally { await mock.close(); }
});
