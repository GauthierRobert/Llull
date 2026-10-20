/**
 * Local signing key store (09 PLM §5.7, TR-PLM-08): the public registry of trusted keys and the passphrase-protected private keys of this machine.
 * Environment: LLULL_KEYS_DIR  directory (default ~/.llull/keys), read on every call.
 * Files: `registry.json` (public records) and `<keyId>.key.json` (private seed, scrypt + AES-256-GCM, owner-only). The seed never leaves this
 * module in clear except to sign; no network, no OS keychain dependency (an OS-protected store is a later host option, Q8).
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../writeFileAtomic';
import { generateEd25519, signEd25519 } from './ed25519';

interface KeyRecord {
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
  readonly salt: string;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

function keysDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['LLULL_KEYS_DIR'];
  return configured !== undefined && configured !== '' ? path.resolve(configured) : path.join(homedir(), '.llull', 'keys');
}

const registryFile = (dir: string): string => path.join(dir, 'registry.json');
const keyFile = (dir: string, keyId: string): string => path.join(dir, `${keyId}.key.json`);

function readRegistry(dir: string): KeyRecord[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(registryFile(dir), 'utf8'));
    return Array.isArray(parsed) ? (parsed as KeyRecord[]) : [];
  } catch {
    return [];
  }
}

const writeRegistry = (dir: string, records: readonly KeyRecord[]): void => {
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(registryFile(dir), `${JSON.stringify(records, null, 2)}\n`);
};

const deriveKey = (passphrase: string, salt: Buffer): Buffer => scryptSync(passphrase, salt, 32);

function seal(seedHex: string, passphrase: string): SealedSeed {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(seedHex, 'hex')), cipher.final()]);
  return {
    format: 'llull-private-key',
    kdf: 'scrypt',
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

function unseal(sealed: SealedSeed, passphrase: string): string | null {
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, Buffer.from(sealed.salt, 'hex')), Buffer.from(sealed.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'hex')), decipher.final()]).toString('hex');
  } catch {
    return null;
  }
}

export interface KeyStore {
  list(): readonly KeyRecord[];
  find(keyId: string): KeyRecord | undefined;
  /** The registered record of a public key. */
  byPublicKey(publicKey: string): KeyRecord | undefined;
  /** Generate and register a key; `at` is the host time. @failure an empty passphrase -> throws */
  create(input: { readonly userId: string; readonly name: string; readonly passphrase: string; readonly at: string }): KeyRecord;
  /** Mark a key revoked (it stays in the registry: past signatures keep their provenance). */
  revoke(keyId: string, at: string): KeyRecord | null;
  /** Signature (hex) of `message` with `keyId`, or null for an unknown / revoked key or a wrong passphrase. */
  sign(keyId: string, passphrase: string, message: string): string | null;
}

export function createKeyStore(env: NodeJS.ProcessEnv = process.env): KeyStore {
  const dir = (): string => keysDir(env);
  return {
    list: () => readRegistry(dir()),
    find: (keyId) => readRegistry(dir()).find((record) => record.keyId === keyId),
    byPublicKey: (publicKey) => readRegistry(dir()).find((record) => record.publicKey === publicKey),
    create({ userId, name, passphrase, at }) {
      if (passphrase.length < 1) throw new Error('a key needs a passphrase');
      const pair = generateEd25519();
      const keyId = `k-${createHash('sha256').update(pair.publicKeyHex).digest('hex').slice(0, 12)}`;
      const record: KeyRecord = { keyId, userId, name, publicKey: pair.publicKeyHex, createdAt: at };
      mkdirSync(dir(), { recursive: true });
      writeFileAtomic(keyFile(dir(), keyId), `${JSON.stringify(seal(pair.seedHex, passphrase))}\n`, 0o600);
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
    sign(keyId, passphrase, message) {
      const record = readRegistry(dir()).find((candidate) => candidate.keyId === keyId);
      if (record === undefined || record.revokedAt !== undefined || !existsSync(keyFile(dir(), keyId))) return null;
      const seed = unseal(JSON.parse(readFileSync(keyFile(dir(), keyId), 'utf8')) as SealedSeed, passphrase);
      return seed === null ? null : signEd25519(seed, message);
    },
  };
}
