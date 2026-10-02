#!/usr/bin/env node
// @ts-nocheck -- Small Node CLI glue around the typed adapter API and vendored ethers.
import ethers from '../vendor/ethers.cjs';
import { runPaidAction } from './adapter.js';

const notice = 'Experimental, commissioned as a test of the IMD swarm. It may not work as described. Read the code, start with small amounts, no warranty.';
function help() {
  console.log(`${notice}\n\nUsage: imd-x402-compat --execute --action ACTION --input JSON --max-amount ATOMIC_UNITS --bearer-token 64_HEX [--base-url URL]\n\nSet IMD_PRIVATE_KEY in the environment. Generate and retain the bearer token to read your order later. This Node CLI makes paid requests; it never approves IMD to Permit2 for you. --max-amount caps one payment in atomic IMD units. --base-url is for a trusted compatible server or local mock.`);
}
const args = process.argv.slice(2);
if (args.includes('--help') || args.length === 0) {
  help();
} else {
  try {
    const values = new Map();
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--execute') { values.set('--execute', 'yes'); continue; }
      if (!args[i].startsWith('--') || i + 1 >= args.length) throw new Error(`Unexpected argument: ${args[i]}`);
      values.set(args[i], args[++i]);
    }
    if (values.get('--execute') !== 'yes') throw new Error('Add --execute to authorize a paid request');
    const action = values.get('--action');
    const input = values.get('--input');
    const cap = values.get('--max-amount');
    const bearerToken = values.get('--bearer-token');
    if (!action || !input || !cap || !bearerToken) throw new Error('--action, --input, --max-amount and --bearer-token are required');
    if (!/^(0|[1-9][0-9]*)$/.test(cap)) throw new Error('--max-amount must be atomic units');
    if (!process.env.IMD_PRIVATE_KEY) throw new Error('IMD_PRIVATE_KEY is required');
    const wallet = new ethers.Wallet(process.env.IMD_PRIVATE_KEY);
    const signer = {
      address: wallet.address,
      signTypedData: ({ domain, types, message }) => wallet.signTypedData(domain, types, message)
    };
    const result = await runPaidAction(action, JSON.parse(input), signer, {
      baseUrl: values.get('--base-url'), bearerToken, maxAmount: BigInt(cap),
      onQuoted: id => console.error(`Order ID: ${id} (retain your bearer token to query its status)`)
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
