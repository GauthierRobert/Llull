/** Ed25519 (RFC 8032 PureEdDSA) over `node:crypto`: the host-side primitives behind the signature port (09 PLM TR-PLM-07). Local, no network. */

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const HEX = /^[0-9a-f]+$/;

/** Whether `signatureHex` is a valid Ed25519 signature by `publicKeyHex` (64 hex chars) over the UTF-8 bytes of `message`; never throws. */
export function verifyEd25519(publicKeyHex: string, message: string | Uint8Array, signatureHex: string): boolean {
  if (publicKeyHex.length !== 64 || signatureHex.length !== 128 || !HEX.test(publicKeyHex) || !HEX.test(signatureHex)) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]), format: 'der', type: 'spki' });
    const bytes = typeof message === 'string' ? Buffer.from(message, 'utf8') : Buffer.from(message);
    return verify(null, bytes, key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

/** Deterministic Ed25519 signature (128 hex chars) of `message` with the 32-byte `seedHex`. */
export function signEd25519(seedHex: string, message: string | Uint8Array): string {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seedHex, 'hex')]), format: 'der', type: 'pkcs8' });
  const bytes = typeof message === 'string' ? Buffer.from(message, 'utf8') : Buffer.from(message);
  return sign(null, bytes, key).toString('hex');
}

/** A fresh key pair as 32-byte hex seed and public key. */
export function generateEd25519(): { readonly seedHex: string; readonly publicKeyHex: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { seedHex: seed.toString('hex'), publicKeyHex: pub.toString('hex') };
}
