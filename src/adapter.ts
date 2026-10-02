/** IMD's two-signature exact/Permit2 bridge. No network or wallet dependency. */
export const IMD_ASSET = '0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7';
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const EXACT_PROXY = '0x402085c248EeA27D92E8b30b2C58ed07f9E20001';

export type TypedField = { name: string; type: string };
export type TypedData = {
  domain: Record<string, unknown>;
  types: Record<string, TypedField[]>;
  primaryType: string;
  message: Record<string, unknown>;
};
export interface Signer {
  address: string;
  signTypedData(data: TypedData): Promise<string>;
}
export interface Requirement {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}
export interface Challenge {
  accepts: Requirement[];
  quote: {
    id: string;
    quoteHash: string;
    action: string;
    payment: { network?: string; asset: string; amount: string; payTo: string };
    expiresAt: string | number;
  };
  resource: { url: string; [key: string]: unknown };
  resourceUrl: string;
  requesterScopeHash: string;
}
export interface Payment {
  x402Version: 2;
  resource: Challenge['resource'];
  accepted: Requirement;
  payload: {
    signature: string;
    permit2Authorization: {
      from: string;
      permitted: { token: string; amount: string };
      spender: string;
      nonce: string;
      deadline: string;
      witness: { to: string; validAfter: string };
    };
  };
}
export interface Capabilities {
  payment: { network: string; asset: string; amount: string; payTo: string; decimals?: number };
  quoteTtlSeconds?: number;
}

const address = /^0x[0-9a-fA-F]{40}$/;
const uint = /^(0|[1-9][0-9]*)$/;
const bytes32 = /^(0x)?[0-9a-fA-F]{64}$/;
function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function sameAddress(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }
function hex32(value: string): string {
  assert(bytes32.test(value), 'Expected a 32-byte hex hash');
  return `0x${value.replace(/^0x/, '').toLowerCase()}`;
}
function expirySeconds(value: string | number): number {
  const seconds = typeof value === 'number' ? value : /^\d+$/.test(value) ? Number(value) : Math.floor(Date.parse(value) / 1000);
  assert(Number.isSafeInteger(seconds) && seconds > 0, 'Invalid quote expiry');
  return seconds;
}
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, sorted(v)]));
  }
  return value;
}
export function canonicalJson(value: unknown): string { return JSON.stringify(sorted(value)); }
export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `0x${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')}`;
}
function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return BigInt(`0x${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`).toString();
}
export function validateChallenge(challenge: Challenge, maxAmount: bigint, now = Math.floor(Date.now() / 1000), capabilities?: Capabilities): Requirement {
  assert(challenge && typeof challenge === 'object', 'Missing challenge');
  assert(Array.isArray(challenge.accepts) && challenge.accepts.length > 0, 'No accepted payment method');
  const accepted = challenge.accepts[0];
  assert(accepted && typeof accepted === 'object', 'Invalid accepted payment method');
  const quote = challenge.quote;
  assert(quote && quote.payment, 'Missing quote payment');
  assert(typeof quote.payment.asset === 'string' && typeof quote.payment.payTo === 'string', 'Invalid quote payment');
  assert(accepted.scheme === 'exact', 'Only x402 exact is supported');
  assert(accepted.network === 'eip155:1', 'Only Ethereum mainnet is supported');
  assert(accepted.extra?.assetTransferMethod === 'permit2', 'Permit2 is required');
  assert(address.test(accepted.asset) && sameAddress(accepted.asset, IMD_ASSET), 'Unexpected asset');
  assert(address.test(accepted.payTo) && sameAddress(accepted.payTo, quote.payment.payTo), 'Recipient differs from quote');
  if (quote.payment.network) assert(accepted.network === quote.payment.network, 'Network differs from quote');
  assert(sameAddress(accepted.asset, quote.payment.asset), 'Asset differs from quote');
  assert(uint.test(accepted.amount) && accepted.amount === quote.payment.amount, 'Amount differs from quote');
  assert(BigInt(accepted.amount) > 0n && BigInt(accepted.amount) <= maxAmount, 'Amount exceeds cap');
  assert(Number.isSafeInteger(accepted.maxTimeoutSeconds) && accepted.maxTimeoutSeconds > 0, 'Invalid timeout');
  assert(expirySeconds(quote.expiresAt) > now + 5, 'Quote expires too soon');
  assert(typeof quote.id === 'string' && quote.id.length > 0, 'Missing quote id');
  assert(typeof quote.action === 'string' && quote.action.length > 0, 'Missing action');
  hex32(quote.quoteHash);
  hex32(challenge.requesterScopeHash);
  assert(typeof challenge.resourceUrl === 'string' && URL.canParse(challenge.resourceUrl), 'Invalid resource URL');
  assert(challenge.resource && typeof challenge.resource.url === 'string', 'Invalid x402 resource');
  assert(challenge.resource.url === challenge.resourceUrl, 'Resource URL differs from quote');
  if (capabilities) {
    assert(capabilities.payment && capabilities.payment.network === accepted.network, 'Network differs from capabilities');
    assert(typeof capabilities.payment.asset === 'string' && typeof capabilities.payment.payTo === 'string', 'Invalid capability payment');
    assert(sameAddress(capabilities.payment.asset, accepted.asset), 'Asset differs from capabilities');
    assert(sameAddress(capabilities.payment.payTo, accepted.payTo), 'Recipient differs from capabilities');
    if (!quote.action.startsWith('schedule.')) {
      assert(capabilities.payment.amount === accepted.amount, 'Amount differs from capabilities');
    }
  }
  return accepted;
}
export async function createPayment(challenge: Challenge, signer: Signer, maxAmount: bigint, now = Math.floor(Date.now() / 1000), capabilities?: Capabilities):
  Promise<{ payment: Payment; quoteSignature: string; paymentHash: string }> {
  const accepted = validateChallenge(challenge, maxAmount, now, capabilities);
  assert(address.test(signer.address), 'Invalid signer address');
  const deadline = Math.min(expirySeconds(challenge.quote.expiresAt) - 5, Math.floor(now + accepted.maxTimeoutSeconds));
  assert(deadline > now, 'No safe signing window');
  const auth = {
    from: signer.address,
    permitted: { token: accepted.asset, amount: accepted.amount },
    spender: EXACT_PROXY,
    nonce: randomNonce(),
    deadline: String(deadline),
    witness: { to: accepted.payTo, validAfter: '0' }
  };
  const permitTypes: Record<string, TypedField[]> = {
    PermitWitnessTransferFrom: [
      { name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' },
      { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'witness', type: 'Witness' }
    ],
    TokenPermissions: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
    Witness: [{ name: 'to', type: 'address' }, { name: 'validAfter', type: 'uint256' }]
  };
  const signature = await signer.signTypedData({
    domain: { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 },
    types: permitTypes, primaryType: 'PermitWitnessTransferFrom', message: auth
  });
  assert(/^0x[0-9a-fA-F]+$/.test(signature), 'Signer returned invalid Permit2 signature');
  const payment: Payment = {
    x402Version: 2, resource: challenge.resource, accepted,
    payload: { signature, permit2Authorization: auth }
  };
  const paymentHash = await sha256Hex(canonicalJson(payment));
  const approvalTypes = {
    QuoteApproval: [
      { name: 'resource', type: 'string' }, { name: 'requesterScopeHash', type: 'bytes32' },
      { name: 'quoteId', type: 'string' }, { name: 'quoteHash', type: 'bytes32' },
      { name: 'paymentHash', type: 'bytes32' }, { name: 'action', type: 'string' },
      { name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' },
      { name: 'payTo', type: 'address' }, { name: 'expiresAt', type: 'uint256' }
    ]
  };
  const quoteSignature = await signer.signTypedData({
    domain: { name: 'IdentityMD Paid Action', version: '1', chainId: 1 },
    types: approvalTypes, primaryType: 'QuoteApproval',
    message: {
      resource: challenge.resourceUrl, requesterScopeHash: hex32(challenge.requesterScopeHash),
      quoteId: challenge.quote.id, quoteHash: hex32(challenge.quote.quoteHash), paymentHash,
      action: challenge.quote.action, asset: accepted.asset, amount: accepted.amount,
      payTo: accepted.payTo, expiresAt: String(expirySeconds(challenge.quote.expiresAt))
    }
  });
  assert(/^0x[0-9a-fA-F]+$/.test(quoteSignature), 'Signer returned invalid quote signature');
  return { payment, quoteSignature, paymentHash };
}

export type RequestOptions = {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  bearerToken?: string;
  maxAmount: bigint;
  pollIntervalMs?: number;
  timeoutMs?: number;
  onQuoted?: (orderId: string) => void;
};
export async function runPaidAction(action: string, input: unknown, signer: Signer, options: RequestOptions): Promise<unknown> {
  const base = options.baseUrl ?? 'https://api.imd.fun';
  const fetcher = options.fetch ?? fetch;
  assert(/^https?:\/\//.test(base), 'Invalid base URL');
  const token = options.bearerToken ?? Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
  assert(/^[0-9a-fA-F]{64}$/.test(token), 'Bearer token must be 32 random bytes as hex');
  const headers = { Authorization: `Bearer ${token}` };
  async function request(path: string, init: RequestInit): Promise<Response> {
    return fetcher(new URL(path, base), { ...init, headers: { ...headers, ...init.headers } });
  }
  const quoted = await request('/requests/quote', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestKey: crypto.randomUUID(), action, input })
  });
  const quoteBody = await quoted.json() as { order?: { id?: string }; problems?: unknown };
  if (!quoted.ok) throw new Error(`Quote failed (${quoted.status}): ${JSON.stringify(quoteBody)}`);
  const id = quoteBody.order?.id;
  assert(typeof id === 'string' && id.length > 0, 'Quote omitted order id');
  options.onQuoted?.(id);
  const path = `/requests/${encodeURIComponent(id)}/submit`;
  const challenged = await request(path, { method: 'POST' });
  const challenge = await challenged.json() as Challenge;
  assert(challenged.status === 402, `Expected 402 challenge, got ${challenged.status}`);
  assert(challenge.quote.action === action, 'Challenge action differs from request');
  const capabilityResponse = await request('/requests/capabilities', { method: 'GET' });
  assert(capabilityResponse.ok, `Capabilities lookup failed (${capabilityResponse.status})`);
  const capabilities = await capabilityResponse.json() as Capabilities;
  const { payment, quoteSignature } = await createPayment(challenge, signer, options.maxAmount, Math.floor(Date.now() / 1000), capabilities);
  const submitted = await request(path, {
    method: 'POST', headers: {
      'Content-Type': 'application/json',
      'PAYMENT-SIGNATURE': btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(payment))))
    },
    body: JSON.stringify({ quoteSignature })
  });
  const submitBody = await submitted.json();
  if (submitted.status !== 202 && submitted.status !== 200) {
    throw new Error(`Payment submit failed (${submitted.status}): ${JSON.stringify(submitBody)}`);
  }
  const start = Date.now();
  const timeoutMs = options.timeoutMs ?? 120_000;
  while (Date.now() - start < timeoutMs) {
    const polled = await request(`/requests/${encodeURIComponent(id)}`, { method: 'GET' });
    const body = await polled.json() as { status?: string };
    if (!polled.ok) throw new Error(`Polling failed (${polled.status}): ${JSON.stringify(body)}`);
    if (!['quoted', 'payment_pending', 'admission_pending'].includes(body.status ?? '')) return body;
    await new Promise(resolve => setTimeout(resolve, options.pollIntervalMs ?? 1000));
  }
  throw new Error(`Timed out waiting for request ${id}; query its status with the same bearer token`);
}
