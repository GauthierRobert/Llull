/**
 * The trust store (09 PLM TR-PLM-19): which enrolled public keys may make signatures that COUNT (approvals, releases, human gates).
 * - Trust is added only with a `TrustGrant`, which only the desktop app issues after the user confirmed in a native dialog (`trustGrant.ts`, imported by
 *   desktop/ only, enforced by dependency-cruiser). The CLI and REST routes can enroll a key but never trust it; they can only REVOKE trust.
 * - The location is fixed per user profile (~/.llull/trust); `LLULL_KEYS_DIR` and every other environment variable cannot redirect it. The only
 *   override is `LLULL_TRUST_DIR` inside a test run (`isTestRun`).
 * - `trust.json` carries an HMAC-SHA256 under `trust.secret` (0600, created at the first grant): a file edited without the secret trusts nothing.
 * Honest limit: a process running as the same OS user can read the secret; this separates the desktop confirmation from agent-reachable surfaces
 * (CLI, REST, command params), it is not a defence against arbitrary code with the user's file access.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { jcsJson } from '@lib/jcs';
import { isTestRun } from '../env';
import { writeFileAtomic } from '../writeFileAtomic';
import type { KeyRecord } from './keyStore';
import type { TrustGrant } from './trustGrant';

interface TrustedKey {
  readonly keyId: string;
  readonly userId: string;
  readonly name: string;
  readonly publicKey: string;
  readonly trustedAt: string;
  readonly revokedAt?: string;
}

interface TrustFile {
  readonly keys: readonly TrustedKey[];
  readonly mac: string;
}

export function trustDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['LLULL_TRUST_DIR'];
  return isTestRun(env) && override !== undefined && override !== '' ? path.resolve(override) : path.join(homedir(), '.llull', 'trust');
}

const macOf = (secret: Buffer, keys: readonly TrustedKey[]): string => createHmac('sha256', secret).update(jcsJson(keys)).digest('hex');
const secretFile = (dir: string): string => path.join(dir, 'trust.secret');
const trustFile = (dir: string): string => path.join(dir, 'trust.json');

function readSecret(dir: string): Buffer | null {
  try {
    return Buffer.from(readFileSync(secretFile(dir), 'utf8').trim(), 'hex');
  } catch {
    return null;
  }
}

/** The trusted keys when `trust.json` verifies under the secret; an empty list for a missing, unreadable or tampered store. */
function readTrusted(dir: string): TrustedKey[] {
  const secret = readSecret(dir);
  if (secret === null || secret.length !== 32) return [];
  try {
    const parsed = JSON.parse(readFileSync(trustFile(dir), 'utf8')) as TrustFile;
    const expected = Buffer.from(macOf(secret, parsed.keys), 'hex');
    const actual = Buffer.from(parsed.mac, 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual) ? [...parsed.keys] : [];
  } catch {
    return [];
  }
}

function write(dir: string, keys: readonly TrustedKey[]): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(secretFile(dir))) writeFileAtomic(secretFile(dir), `${randomBytes(32).toString('hex')}\n`, 0o600);
  const secret = readSecret(dir) as Buffer;
  writeFileAtomic(trustFile(dir), `${JSON.stringify({ keys, mac: macOf(secret, keys) } satisfies TrustFile, null, 2)}\n`, 0o600);
}

export interface TrustStore {
  list(): readonly TrustedKey[];
  /** The trusted, not revoked record of a public key, else null. */
  find(publicKey: string): TrustedKey | null;
  /** Trust an enrolled key. @invariant needs a `TrustGrant` (issued by the desktop app after the user confirmed) */
  trust(record: KeyRecord, grant: TrustGrant, at: string): TrustedKey;
  /** Withdraw trust (allowed from the CLI: it can only reduce what counts). */
  revoke(publicKey: string, at: string): boolean;
}

export function createTrustStore(env: NodeJS.ProcessEnv = process.env): TrustStore {
  const dir = (): string => trustDir(env);
  return {
    list: () => readTrusted(dir()),
    find: (publicKey) => readTrusted(dir()).find((key) => key.publicKey === publicKey && key.revokedAt === undefined) ?? null,
    trust(record, grant, at) {
      if (!grant.userConfirmed) throw new Error('trusting a key needs the confirmation of the user in the desktop app');
      const others = readTrusted(dir()).filter((key) => key.publicKey !== record.publicKey);
      const entry: TrustedKey = {
        keyId: record.keyId,
        userId: record.userId,
        name: record.name,
        publicKey: record.publicKey,
        trustedAt: at,
      };
      write(dir(), [...others, entry]);
      return entry;
    },
    revoke(publicKey, at) {
      const keys = readTrusted(dir());
      if (!keys.some((key) => key.publicKey === publicKey && key.revokedAt === undefined)) return false;
      write(
        dir(),
        keys.map((key) => (key.publicKey === publicKey ? { ...key, revokedAt: at } : key)),
      );
      return true;
    },
  };
}
