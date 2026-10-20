/**
 * Local signing key ENROLLMENT (09 PLM §5.7, TR-PLM-08): the registry of enrolled public keys and the passphrase-protected private keys of this machine.
 * Enrollment is NOT trust: an enrolled key signs nothing that counts until the user trusts it in the desktop app (`trustStore.ts`).
 * Environment: LLULL_KEYS_DIR  directory (default ~/.llull/keys), read on every call (it holds secrets and public records only, never trust).
 * Files: `registry.json` (public records) and `<keyId>.key.json` (private seed: scrypt N=2^17, AES-256-GCM with AAD = keyId || publicKey).
 * @invariant directories are 0o700 and files 0o600; the seed never leaves this module except to sign; no network
 */

import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, randomBytes, scrypt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { writeFileAtomic } from '../writeFileAtomic';
import { generateEd25519, signEd25519 } from './ed25519';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export interface KeyRecord {
  readonly keyId: string;
  readonly userId: string;
  readonly name: string;
  /** 64 lowercase hex chars. */
  readonly publicKey: string;
  readonly createdAt: string;
  readonly revokedAt?: string;
}

interface SealedSeed {
  readonly format: 'llull-private-key';
  readonly kdf: 'scrypt';
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly salt: string;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

/** scrypt cost of new keys (N = 2^17, about 128 MiB, a few hundred ms); stored with each key so it can be raised later. */
const KDF = { N: 131072, r: 8, p: 1 } as const;
export const MIN_PASSPHRASE_LENGTH = 12;

function keysDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['LLULL_KEYS_DIR'];
  return configured !== undefined && configured !== '' ? path.resolve(configured) : path.join(homedir(), '.llull', 'keys');
}

const registryFile = (dir: string): string => path.join(dir, 'registry.json');
const keyFile = (dir: string, keyId: string): string => path.join(dir, `${keyId}.key.json`);
const SAFE_KEY_ID = /^k-[0-9a-f]{12}$/;

function readRegistry(dir: string): KeyRecord[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(registryFile(dir), 'utf8'));
    return Array.isArray(parsed) ? (parsed as KeyRecord[]) : [];
  } catch {
    return [];
  }
}

function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

const writeRegistry = (dir: string, records: readonly KeyRecord[]): void => {
  privateDir(dir);
  writeFileAtomic(registryFile(dir), `${JSON.stringify(records, null, 2)}\n`, 0o600);
};

const kdfOptions = (n: number, r: number, p: number): { N: number; r: number; p: number; maxmem: number } => ({
  N: n,
  r,
  p,
  maxmem: 256 * n * r + 1024 * 1024,
});
const aadOf = (keyId: string, publicKey: string): Buffer => Buffer.from(`${keyId}|${publicKey}`, 'utf8');

async function seal(seedHex: string, passphrase: string, keyId: string, publicKey: string): Promise<SealedSeed> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await scryptAsync(passphrase, salt, 32, kdfOptions(KDF.N, KDF.r, KDF.p));
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aadOf(keyId, publicKey));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(seedHex, 'hex')), cipher.final()]);
  return {
    format: 'llull-private-key',
    kdf: 'scrypt',
    ...KDF,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

const publicKeyOfSeed = (seedHex: string): string =>
  createPublicKey(
    createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seedHex, 'hex')]),
      format: 'der',
      type: 'pkcs8',
    }),
  )
    .export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('hex');

/** The seed (hex) when the passphrase is right, the AAD matches the record and the seed derives the recorded public key; else null. */
async function unseal(sealed: SealedSeed, passphrase: string, record: KeyRecord): Promise<string | null> {
  try {
    const key = await scryptAsync(passphrase, Buffer.from(sealed.salt, 'hex'), 32, kdfOptions(sealed.N, sealed.r, sealed.p));
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'hex'));
    decipher.setAAD(aadOf(record.keyId, record.publicKey));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'hex'));
    const seed = Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'hex')), decipher.final()]).toString('hex');
    return publicKeyOfSeed(seed) === record.publicKey ? seed : null;
  } catch {
    return null;
  }
}

export interface KeyStore {
  list(): readonly KeyRecord[];
  find(keyId: string): KeyRecord | undefined;
  /** The enrolled record of a public key. */
  byPublicKey(publicKey: string): KeyRecord | undefined;
  /** Generate and enroll a key (untrusted until the desktop app trusts it). @failure a passphrase shorter than 12 characters -> throws */
  create(input: { readonly userId: string; readonly name: string; readonly passphrase: string; readonly at: string }): Promise<KeyRecord>;
  /** Mark a key revoked (it stays in the registry: past signatures keep their provenance). */
  revoke(keyId: string, at: string): KeyRecord | null;
  /** Signature (hex) of `message` with `keyId`, or null for an unknown / revoked key or a wrong passphrase. */
  sign(keyId: string, passphrase: string, message: string): Promise<string | null>;
}

export function createKeyStore(env: NodeJS.ProcessEnv = process.env): KeyStore {
  const dir = (): string => keysDir(env);
  return {
    list: () => readRegistry(dir()),
    find: (keyId) => readRegistry(dir()).find((record) => record.keyId === keyId),
    byPublicKey: (publicKey) => readRegistry(dir()).find((record) => record.publicKey === publicKey),
    async create({ userId, name, passphrase, at }) {
      if (passphrase.length < MIN_PASSPHRASE_LENGTH) throw new Error(`a key passphrase needs at least ${MIN_PASSPHRASE_LENGTH} characters`);
      const pair = generateEd25519();
      const keyId = `k-${createHash('sha256').update(pair.publicKeyHex).digest('hex').slice(0, 12)}`;
      const record: KeyRecord = { keyId, userId, name, publicKey: pair.publicKeyHex, createdAt: at };
      privateDir(dir());
      writeFileAtomic(keyFile(dir(), keyId), `${JSON.stringify(await seal(pair.seedHex, passphrase, keyId, pair.publicKeyHex))}\n`, 0o600);
      writeRegistry(dir(), [...readRegistry(dir()), record]);
      return record;
    },
    revoke(keyId, at) {
      const records = readRegistry(dir());
      const found = records.find((record) => record.keyId === keyId);
      if (found === undefined) return null;
      const revoked: KeyRecord = { ...found, revokedAt: found.revokedAt ?? at };
      writeRegistry(
        dir(),
        records.map((record) => (record.keyId === keyId ? revoked : record)),
      );
      return revoked;
    },
    async sign(keyId, passphrase, message) {
      const record = readRegistry(dir()).find((candidate) => candidate.keyId === keyId);
      if (record === undefined || record.revokedAt !== undefined || !SAFE_KEY_ID.test(keyId) || !existsSync(keyFile(dir(), keyId)))
        return null;
      const seed = await unseal(JSON.parse(readFileSync(keyFile(dir(), keyId), 'utf8')) as SealedSeed, passphrase, record);
      return seed === null ? null : signEd25519(seed, message);
    },
  };
}
