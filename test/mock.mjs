import { createServer } from 'node:http';
import ethers from '../vendor/ethers.cjs';
import { canonicalJson, sha256Hex, EXACT_PROXY, IMD_ASSET, PERMIT2 } from '../dist/adapter.js';

const payTo = '0x1111111111111111111111111111111111111111';
function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join() !== keys.sort().join()) throw new Error(`invalid_payment_shape: expected ${keys.join(',')}`);
}
function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}
async function body(req) {
  let value = '';
  for await (const chunk of req) value += chunk;
  return value ? JSON.parse(value) : undefined;
}
export async function createMock(options = {}) {
  const state = { requests: [], quoteCount: 0, polls: 0, paid: false };
  const token = 'ab'.repeat(32);
  const orderId = '11111111-2222-4333-8444-555555555555';
  const quoteId = 'quote-local-1';
  const expiry = Math.floor(Date.now() / 1000) + (options.expireIn ?? 80);
  const requirement = {
    scheme: 'exact', network: 'eip155:1', amount: '500000000000000000',
    asset: IMD_ASSET, payTo, maxTimeoutSeconds: 120,
    extra: { assetTransferMethod: 'permit2' }
  };
  const challenge = {
    accepts: [requirement],
    quote: {
      id: quoteId, quoteHash: '22'.repeat(32), action: 'local.echo',
      payment: { network: 'eip155:1', asset: IMD_ASSET, amount: requirement.amount, payTo },
      expiresAt: expiry
    },
    resource: { url: 'http://127.0.0.1/requests/local/submit', description: 'Local mock', mimeType: 'application/json' },
    resourceUrl: 'http://127.0.0.1/requests/local/submit',
    requesterScopeHash: '33'.repeat(32)
  };
  Object.assign(challenge, options.challenge ?? {});
  const server = createServer(async (req, res) => {
    try {
      state.requests.push({ method: req.method, url: req.url, headers: req.headers });
      if (req.headers.origin) return json(res, 403, { error: 'browser_origin_forbidden' });
      if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: 'invalid_bearer' });
      if (req.method === 'GET' && req.url === '/requests/capabilities') {
        return json(res, 200, { payment: { network: 'eip155:1', asset: IMD_ASSET, amount: requirement.amount, payTo, decimals: 18 }, quoteTtlSeconds: 600 });
      }
      if (req.method === 'POST' && req.url === '/requests/quote') {
        const data = await body(req);
        if (!/^[0-9a-fA-F-]{36}$/.test(data.requestKey)) throw new Error('requestKey must be UUID');
        if (data.action !== 'local.echo') return json(res, 422, { error: 'invalid_input', problems: ['action'] });
        state.quoteCount++;
        return json(res, 201, { order: { id: orderId } });
      }
      if (req.method === 'POST' && req.url === `/requests/${orderId}/submit`) {
        if (state.quoteCount === 0) return json(res, 404, { error: 'unknown_order' });
        const data = await body(req);
        if (!req.headers['payment-signature']) {
          if (data !== undefined) throw new Error('first submit must have no body');
          const standardHeader = options.standardHeader !== false ? {
            'PAYMENT-REQUIRED': Buffer.from(JSON.stringify({ x402Version: 2, resource: challenge.resource, accepts: challenge.accepts })).toString('base64')
          } : {};
          return json(res, 402, challenge, standardHeader);
        }
        exactKeys(data, ['quoteSignature']);
        const payment = JSON.parse(Buffer.from(req.headers['payment-signature'], 'base64').toString('utf8'));
        exactKeys(payment, ['x402Version', 'resource', 'accepted', 'payload']);
        exactKeys(payment.payload, ['signature', 'permit2Authorization']);
        const auth = payment.payload.permit2Authorization;
        exactKeys(auth, ['from', 'permitted', 'spender', 'nonce', 'deadline', 'witness']);
        exactKeys(auth.permitted, ['token', 'amount']);
        exactKeys(auth.witness, ['to', 'validAfter']);
        if (payment.x402Version !== 2 || canonicalJson(payment.accepted) !== canonicalJson(requirement) || canonicalJson(payment.resource) !== canonicalJson(challenge.resource)) throw new Error('payment requirements differ');
        if (auth.spender.toLowerCase() !== EXACT_PROXY.toLowerCase() || auth.permitted.token.toLowerCase() !== IMD_ASSET || auth.permitted.amount !== requirement.amount || auth.witness.to !== payTo || auth.witness.validAfter !== '0') throw new Error('permit fields differ');
        if (BigInt(auth.deadline) > BigInt(expiry - 5) || BigInt(auth.deadline) <= BigInt(Math.floor(Date.now() / 1000))) throw new Error('bad deadline');
        if (!/^[0-9]+$/.test(auth.nonce)) throw new Error('bad nonce');
        const permitSigner = ethers.verifyTypedData(
          { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 },
          {
            PermitWitnessTransferFrom: [
              { name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' },
              { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'witness', type: 'Witness' }
            ],
            TokenPermissions: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
            Witness: [{ name: 'to', type: 'address' }, { name: 'validAfter', type: 'uint256' }]
          }, auth, payment.payload.signature
        );
        if (permitSigner.toLowerCase() !== auth.from.toLowerCase()) throw new Error('invalid permit signature');
        const paymentHash = await sha256Hex(canonicalJson(payment));
        const approvalSigner = ethers.verifyTypedData(
          { name: 'IdentityMD Paid Action', version: '1', chainId: 1 },
          { QuoteApproval: [
            { name: 'resource', type: 'string' }, { name: 'requesterScopeHash', type: 'bytes32' },
            { name: 'quoteId', type: 'string' }, { name: 'quoteHash', type: 'bytes32' },
            { name: 'paymentHash', type: 'bytes32' }, { name: 'action', type: 'string' },
            { name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' },
            { name: 'payTo', type: 'address' }, { name: 'expiresAt', type: 'uint256' }
          ] },
          {
            resource: challenge.resourceUrl, requesterScopeHash: `0x${challenge.requesterScopeHash}`,
            quoteId, quoteHash: `0x${challenge.quote.quoteHash}`, paymentHash,
            action: challenge.quote.action, asset: requirement.asset, amount: requirement.amount,
            payTo, expiresAt: String(expiry)
          }, data.quoteSignature
        );
        if (approvalSigner.toLowerCase() !== auth.from.toLowerCase()) throw new Error('invalid quote signature');
        state.paid = true;
        return json(res, 202, { status: 'payment_pending' });
      }
      if (req.method === 'GET' && req.url === `/requests/${orderId}`) {
        state.polls++;
        return json(res, 200, state.polls < 2 ? { status: 'admission_pending' } : { status: 'admitted', admission: { result: { echoed: true } } });
      }
      return json(res, 404, { error: 'not_found' });
    } catch (error) {
      json(res, 400, { error: error.message });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl, token, state, challenge, requirement, close: () => new Promise(resolve => server.close(resolve)) };
}
