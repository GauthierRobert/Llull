/** Support for the PLM server tests: enroll + trust a key in temp directories (the test stand-in for the desktop confirmation). */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type KeyRecord, createKeyStore } from '../src/plm/keyStore';
import { GATE_CONTEXT } from '../src/plm/signaturePort';
import { createTrustStore } from '../src/plm/trustStore';
import { issueTrustGrant } from '../src/plm/trustGrant';

export const PASSPHRASE = 'correct horse battery';
export const T = '2026-11-02T09:00:00Z';

export interface TestHome {
  readonly dir: string;
  /** Environment for the stores (and, applied to process.env, for the server context). */
  readonly env: NodeJS.ProcessEnv;
  apply(): void;
  cleanup(): void;
}

const VARS = ['LLULL_KEYS_DIR', 'LLULL_TRUST_DIR', 'LLULL_AUDIT_DIR', 'LLULL_KEY_PASSPHRASE', 'LLULL_USER'] as const;

export function testHome(): TestHome {
  const dir = mkdtempSync(path.join(tmpdir(), 'llull-plm-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LLULL_KEYS_DIR: path.join(dir, 'keys'),
    LLULL_TRUST_DIR: path.join(dir, 'trust'),
    LLULL_AUDIT_DIR: path.join(dir, 'audit'),
    LLULL_KEY_PASSPHRASE: PASSPHRASE,
    LLULL_USER: 'u-cli',
  };
  return {
    dir,
    env,
    apply: () => {
      for (const name of VARS) process.env[name] = env[name] as string;
    },
    cleanup: () => {
      for (const name of VARS) delete process.env[name];
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Enroll a key for `userId` and trust it (what the user does in the desktop app). */
export interface TestKey {
  readonly record: KeyRecord;
  gate(payload: string): Promise<string | null>;
  raw(message: string): Promise<string | null>;
}

export async function trustedKey(env: NodeJS.ProcessEnv, userId: string, name = 'J. Example'): Promise<TestKey> {
  const record = await createKeyStore(env).create({ userId, name, passphrase: PASSPHRASE, at: T });
  createTrustStore(env).trust(record, issueTrustGrant('test'), T);
  return {
    record,
    /** Signature over the human-gate context + `payload`. */
    gate: (payload: string): Promise<string | null> => createKeyStore(env).sign(record.keyId, PASSPHRASE, `${GATE_CONTEXT}${payload}`),
    raw: (message: string): Promise<string | null> => createKeyStore(env).sign(record.keyId, PASSPHRASE, message),
  };
}
