// Cross-check the Python-generated vectors from the JavaScript runtime llull ships on (Node >= 20 / Electron main).
// Run: node verify_vectors.mjs   (from this directory). Exit code 0 = every expectation holds.
// Uses only node:crypto, i.e. the same primitives a future server/desktop `ReleaseCrypto` port would use.

import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const load = (rel) => JSON.parse(readFileSync(join(here, rel), 'utf8'));

// RFC 8785-style canonical JSON: JS default string comparison is by UTF-16 code units, as JCS requires.
const canonical = (v) => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
};
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ed25519Verify = (pkHex, sigHex, msg) =>
  verify(
    null,
    msg,
    createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(pkHex, 'hex')]), format: 'der', type: 'spki' }),
    Buffer.from(sigHex, 'hex'),
  );

let failures = 0;
const expect = (label, ok) => {
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n`);
};

const hv = load('vectors/hash_vectors.json');
for (const k of hv.fips_known_answer) expect(`sha256(${JSON.stringify(k.input_utf8)})`, sha256(k.input_utf8) === k.sha256);
for (const c of hv.canonicalization_cases) expect(`canonical: ${c.name}`, canonical(c.input) === c.canonical);

const envelope = load('sample_document.json');
const excluded = new Set(hv.sample_document.release_scope_excluded_fields);
const scope = {
  format: envelope.format,
  version: envelope.version,
  document: Object.fromEntries(Object.entries(envelope.document).filter(([k]) => !excluded.has(k))),
};
expect('sample_document full canonical sha256', sha256(canonical(envelope)) === hv.sample_document.full_canonical_sha256);
expect('sample_document release-scope sha256', sha256(canonical(scope)) === hv.sample_document.release_scope_canonical_sha256);

const ev = load('vectors/ed25519_vectors.json');
for (const t of ev.rfc8032) expect(`Ed25519 ${t.name}`, ed25519Verify(t.publicKey, t.signature, Buffer.from(t.messageHex, 'hex')));

const manifest = load('release_package_manifest.sample.json');
const { manifestSha256, signatures, ...body } = manifest;
const bodyCanon = canonical(body);
expect('manifest sha256', sha256(bodyCanon) === manifestSha256);
expect('manifest member[0] = document release hash', body.members[0].sha256 === hv.sample_document.release_scope_canonical_sha256);
for (const s of signatures)
  expect(`manifest signature ${s.keyId}`, ed25519Verify(s.publicKey, s.signature, Buffer.from(bodyCanon, 'utf8')));
const tampered = canonical({ ...body, item: { ...body.item, revision: 'B' } });
expect('tampered manifest rejected', !ed25519Verify(signatures[0].publicKey, signatures[0].signature, Buffer.from(tampered, 'utf8')));
for (const n of ev.negative) {
  const msg = Buffer.from(n.messageHex, 'hex');
  expect(`negative message sha256: ${n.name}`, sha256(msg) === n.messageSha256);
  expect(`negative rejected: ${n.name}`, n.expectVerified === false && !ed25519Verify(n.publicKey, n.signature, msg));
}

process.exit(failures === 0 ? 0 : 1);
