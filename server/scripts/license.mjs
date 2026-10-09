#!/usr/bin/env node
/**
 * Vendor tool for llull licenses (Ed25519, verified offline by the server). Keep the private key
 * OUT of the repository and off customer machines.
 *
 *   node server/scripts/license.mjs keygen [--out license-private.pem]
 *       writes the private key (0600) and prints the public key PEM for LLULL_LICENSE_PUBLIC_KEY
 *   node server/scripts/license.mjs sign <payload.json> [--key license-private.pem]
 *       payload: { "customer": "ACME", "seats": 10, "expires": "2027-12-31", "features": [] }
 *       prints the license (base64url payload + "." + base64url signature) for LLULL_LICENSE_FILE
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const [command, ...rest] = process.argv.slice(2);

function flag(name, fallback) {
  const index = rest.indexOf(name);
  return index === -1 ? fallback : (rest[index + 1] ?? fallback);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (command === 'keygen') {
  const out = flag('--out', 'license-private.pem');
  if (fs.existsSync(out)) fail(`${out} already exists; refusing to overwrite a private key.`);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.error(`Private key written to ${out} (keep it secret, never commit it). Public key:`);
  process.stdout.write(`${publicKey.export({ type: 'spki', format: 'pem' })}\n`);
} else if (command === 'sign') {
  const payloadFile = rest[0];
  if (!payloadFile || payloadFile.startsWith('--')) fail('usage: license.mjs sign <payload.json>');
  const payload = JSON.parse(fs.readFileSync(payloadFile, 'utf8'));
  if (typeof payload.customer !== 'string' || payload.customer === '') fail('customer is required');
  if (!Number.isInteger(payload.seats) || payload.seats < 1)
    fail('seats must be a positive integer');
  if (typeof payload.expires !== 'string' || Number.isNaN(Date.parse(payload.expires))) {
    fail('expires must be an ISO date (e.g. 2027-12-31)');
  }
  payload.features ??= [];
  if (!Array.isArray(payload.features)) fail('features must be an array of strings');
  const keyFile = flag(
    '--key',
    process.env.LLULL_LICENSE_PRIVATE_KEY_FILE ?? 'license-private.pem',
  );
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyFile, 'utf8'));
  const bytes = Buffer.from(
    JSON.stringify({
      customer: payload.customer,
      seats: payload.seats,
      expires: payload.expires,
      features: payload.features,
    }),
  );
  const signature = crypto.sign(null, bytes, privateKey);
  process.stdout.write(`${bytes.toString('base64url')}.${signature.toString('base64url')}\n`);
} else {
  fail('usage: license.mjs keygen [--out file] | sign <payload.json> [--key file]');
}
