/** Support for the PLM server tests: enroll + trust a key in temp directories (the test stand-in for the desktop confirmation). */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type KeyRecord, createKeyStore } from '../src/plm/keyStore';
import { configureHostForTests } from '../src/plm/hostConfig';
import { GATE_CONTEXT } from '../src/plm/signaturePort';
import { createTrustStore } from '../src/plm/trustStore';
import { issueTrustGrant } from '../src/plm/trustGrant';

export const PASSPHRASE = 'correct horse battery';
export const T = '2026-11-02T09:00:00Z';

export interface TestHome {
  readonly dir: string;
  /** Trust store and audit directories configured for this process (test code only: production reads no environment for either). */
  readonly trust: string;
  readonly audit: string;
  /** Environment for the key store (enrollment only). */
  readonly env: NodeJS.ProcessEnv;
  /** Also export the enrollment variables to process.env (for code that reads it). */
  apply(): void;
  cleanup(): void;
}

const VARS = ['LLULL_KEYS_DIR', 'LLULL_KEY_PASSPHRASE', 'LLULL_USER'] as const;

export function testHome(): TestHome {
  const dir = mkdtempSync(path.join(tmpdir(), 'llull-plm-'));
  const trust = path.join(dir, 'trust');
  const audit = path.join(dir, 'audit');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LLULL_KEYS_DIR: path.join(dir, 'keys'),
    LLULL_KEY_PASSPHRASE: PASSPHRASE,
    LLULL_USER: 'u-cli',
  };
  configureHostForTests({ trustDir: trust, auditDir: audit });
  return {
    dir,
    trust,
    audit,
    env,
    apply: () => {
      for (const name of VARS) process.env[name] = env[name] as string;
    },
    cleanup: () => {
      for (const name of VARS) delete process.env[name];
      configureHostForTests({ auditDir: null, trustDir: path.join(tmpdir(), 'llull-test-trust-default') });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface TestKey {
  readonly record: KeyRecord;
  gate(payload: string): Promise<string | null>;
  raw(message: string): Promise<string | null>;
}

/** Enroll a key for `userId` and trust it (what the user does in the desktop app). */
export async function trustedKey(home: TestHome, userId: string, name = 'J. Example'): Promise<TestKey> {
  const record = await createKeyStore(home.env).create({ userId, name, passphrase: PASSPHRASE, at: T });
  createTrustStore(home.trust).trust(record, issueTrustGrant('test'), T);
  return {
    record,
    /** Signature over the human-gate context + `payload`. */
    gate: (payload: string): Promise<string | null> => createKeyStore(home.env).sign(record.keyId, PASSPHRASE, `${GATE_CONTEXT}${payload}`),
    raw: (message: string): Promise<string | null> => createKeyStore(home.env).sign(record.keyId, PASSPHRASE, message),
  };
}
