import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import x402 from '../vendor/x402-clients.cjs';

test('draft discovery entry passes published payment and Bazaar validators', () => {
  const listing = JSON.parse(readFileSync(new URL('../discovery/listing.draft.json', import.meta.url)));
  assert.equal(listing.x402Version, 2);
  assert.equal(listing.items.length, 1);
  const item = listing.items[0];
  assert.equal(item.type, 'http');
  assert.equal(item.x402Version, 2);
  assert.ok(URL.canParse(item.resource));
  assert.ok(Number.isFinite(Date.parse(item.lastUpdated)));
  assert.equal(listing.pagination.total, 1);
  assert.equal(x402.PaymentRequirementsV2Schema.safeParse(item.accepts[0]).success, true);
  assert.deepEqual(x402.validateDiscoveryExtension(item.extensions.bazaar), { valid: true });
  assert.deepEqual(x402.validateDiscoveryExtensionSpec(item.extensions.bazaar), { valid: true });
  assert.equal(item.accepts[0].payTo, '0x0000000000000000000000000000000000000000');
});
