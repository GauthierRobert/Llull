/** `llull` CLI parity for 09 PLM (VC-PLM-22, 25, 26): there is no way to claim to be human; a trusted key's signature is the only way. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deserializeDocument } from '@core/commands/persistence/serialization';
import { EXIT_COMMAND_ERROR, EXIT_OK, EXIT_USAGE, runCli, type CliIo } from '../src/cli/main';
import { createKeyStore } from '../src/plm/keyStore';
import { createTrustStore } from '../src/plm/trustStore';
import { issueTrustGrant } from '../src/plm/trustGrant';
import { PASSPHRASE, T, type TestHome, testHome } from './plmTestSupport';
import { verifyAuditChain } from '../src/plm/auditChain';

const SAMPLE = path.resolve(__dirname, '../../docs/aerospace/09-plm-configuration-traceability/validation/sample_document.json');

let home: TestHome;
let docPath = '';
beforeEach(() => {
  home = testHome();
  docPath = path.join(home.dir, 'part.llull.json');
  copyFileSync(SAMPLE, docPath);
  home.apply();
  typed = PASSPHRASE;
});
afterEach(() => home.cleanup());

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}
/** The terminal: a typed passphrase is only available through this injected prompt (the real one needs a TTY). */
let typed: string | null = PASSPHRASE;
async function llull(...argv: string[]): Promise<Run> {
  return llullWith({}, ...argv);
}
async function llullWith(extraEnv: Record<string, string>, ...argv: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    readStdin: () => Promise.resolve(''),
    env: { ...process.env, ...extraEnv },
    prepareKernel: () => Promise.resolve(),
    readPassphrase: () => Promise.resolve(typed),
  };
  const code = await runCli([...argv, '--doc', docPath], io);
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const json = (run: Run): { isError: boolean; summary: string; error?: { code: string; remediation: string } } =>
  JSON.parse(run.out) as never;
const exec = (command: string, params: unknown, ...flags: string[]): Promise<Run> =>
  llull('exec', command, JSON.stringify(params), '--json', ...flags);
const plm = (): NonNullable<ReturnType<typeof deserializeDocument>['plm']> =>
  deserializeDocument(readFileSync(docPath, 'utf8')).plm as never;

/** Enroll a key through the CLI and trust it the way the desktop app does (the CLI itself cannot). */
async function enrolledAndTrusted(user: string): Promise<string> {
  const created = await llull('keys', 'create', '--user', user, '--name', `User ${user}`, '--json');
  expect(created.code).toBe(EXIT_OK);
  const key = JSON.parse(created.out) as { keyId: string; publicKey: string };
  createTrustStore(home.trust).trust(createKeyStore(home.env).find(key.keyId) as never, issueTrustGrant('test'), T);
  return key.keyId;
}

describe('PLM through the CLI', () => {
  it('an agent controlling the environment gains nothing: TEST=true, test keys, its own trust directory and an exported passphrase all fail, and the audit log is written', async () => {
    const mine = await enrolledAndTrusted('u-1');
    const identity = { partNumber: 'LL-1001', name: 'Bracket', itemType: 'part', policy: { humanSignatureRequired: false } };
    const attackerTrust = path.join(home.dir, 'attacker-trust');
    createTrustStore(attackerTrust).trust(createKeyStore(home.env).find(mine) as never, issueTrustGrant('attacker'), T);
    const agentEnv = {
      TEST: 'true',
      VITEST: '1',
      LLULL_PLM_TEST_KEYS: '1',
      LLULL_TRUST_DIR: attackerTrust,
      LLULL_AUDIT_DIR: path.join(home.dir, 'nowhere'),
    };
    typed = null; // an agent has no terminal
    const refused = await llullWith(agentEnv, 'exec', 'set_item_identity', JSON.stringify(identity), '--json', '--confirm-key', mine);
    expect(refused.code).toBe(EXIT_USAGE);
    expect(refused.err).toContain('interactive terminal');
    const noConfirm = await llullWith(agentEnv, 'exec', 'set_item_identity', JSON.stringify(identity), '--json');
    expect(json(noConfirm).error?.code).toBe('PLM_HUMAN_GATE');
    const log = readFileSync(path.join(home.audit, 'audit-000001.jsonl'), 'utf8');
    expect(log).toContain('PLM_HUMAN_GATE');
    expect(verifyAuditChain(home.audit).ok).toBe(true);
    // the exported passphrase and stdin cannot sign either
    const exported = await llullWith(
      { ...agentEnv, LLULL_KEY_PASSPHRASE: PASSPHRASE },
      'exec',
      'set_item_identity',
      JSON.stringify(identity),
      '--json',
      '--confirm-key',
      mine,
      '--passphrase-env',
      'LLULL_KEY_PASSPHRASE',
    );
    expect(exported.code).toBe(EXIT_USAGE);
    expect(plm()).toBeUndefined();
  });

  it('an agent cannot clear a human act by any flag, label or param; a trusted key can', async () => {
    const identity = { partNumber: 'LL-1001', name: 'Bracket', itemType: 'part', policy: { humanSignatureRequired: false } };
    for (const flags of [[], ['--as', 'human']]) {
      const refused = await exec('set_item_identity', identity, ...flags);
      expect(json(refused).error?.code, flags.join(' ')).toBe('PLM_HUMAN_GATE');
      expect(json(refused).error?.remediation).not.toBe('');
    }
    expect((await exec('set_item_identity', { ...identity, caller: 'human' })).code).toBe(EXIT_COMMAND_ERROR);

    const user = await enrolledAndTrusted('u-1');
    const approver = await enrolledAndTrusted('u-2');
    const withKey = (key: string): string[] => ['--confirm-key', key];
    expect((await exec('set_item_identity', identity, ...withKey(user))).code).toBe(EXIT_OK);
    expect((await exec('submit_for_review', {})).code).toBe(EXIT_OK);
    expect(plm().item.revisions['A']?.stateHistory.at(-1)?.by).toBe('u-cli');

    expect(json(await exec('record_approval', { role: 'design-authority' })).error?.code).toBe('PLM_HUMAN_GATE');
    expect((await exec('record_approval', { role: 'design-authority' }, ...withKey(user))).code).toBe(EXIT_OK);
    expect((await exec('record_approval', { role: 'checker', userId: 'u-1' }, ...withKey(approver))).code).toBe(EXIT_OK);
    expect(plm().item.revisions['A']?.approvals.map((approval) => approval.userId)).toEqual(['u-1', 'u-2']);

    const refused = await exec('release_item', { by: 'u-1' });
    expect(json(refused).error?.code).toBe('PLM_HUMAN_GATE');
    expect(plm().item.revisions['A']?.state).toBe('in_review');
    const released = await exec('release_item', { by: 'someone-else' }, ...withKey(user));
    expect(released.code, released.out).toBe(EXIT_OK);
    expect(plm().item.revisions['A']).toMatchObject({ state: 'released', releasedBy: 'u-1' });
    expect(json(await exec('add_box', { size: [1, 1, 1] })).error?.code).toBe('PLM_LOCKED');
  });

  it('an enrolled key that the desktop app did not trust cannot confirm anything', async () => {
    const created = await llull('keys', 'create', '--user', 'u-9', '--name', 'Nobody', '--json');
    const key = (JSON.parse(created.out) as { keyId: string }).keyId;
    expect((await llull('keys', 'list')).out).toContain('NOT trusted');
    expect((await exec('set_item_identity', { partNumber: 'LL-9', name: 'n', itemType: 'part' })).code).toBe(EXIT_OK);
    const refused = await exec('set_item_marking', { regime: 'none' }, '--confirm-key', key);
    expect(json(refused).error?.code).toBe('PLM_HUMAN_GATE');
    expect(await llull('keys', 'trust', key)).toMatchObject({ code: EXIT_USAGE });
  });

  it('keys, release sign --apply, release pack --attach, release verify and audit verify work end to end', async () => {
    const user = await enrolledAndTrusted('u-1');
    const approver = await enrolledAndTrusted('u-2');
    await exec(
      'set_item_identity',
      { partNumber: 'LL-1001', name: 'Bracket', itemType: 'part', policy: { humanSignatureRequired: false } },
      '--confirm-key',
      user,
    );
    await exec('submit_for_review', {});
    await exec('record_approval', { role: 'design-authority' }, '--confirm-key', user);
    await exec('record_approval', { role: 'checker' }, '--confirm-key', approver);
    await exec('release_item', {}, '--confirm-key', user);

    const keys = await llull('keys', 'list');
    expect(keys.out).toContain('TRUSTED');
    const printed = await llull('release', 'sign', '--revision', 'A', '--key', user);
    expect(printed.code).toBe(EXIT_OK);
    expect((JSON.parse(printed.out) as { signer: { userId: string } }).signer.userId).toBe('u-1');
    const signed = await llull('release', 'sign', '--revision', 'A', '--key', user, '--apply');
    expect(signed.code, signed.out + signed.err).toBe(EXIT_OK);
    expect(plm().item.revisions['A']?.signatures).toHaveLength(1);

    const attachRefused = await llull('release', 'pack', '--revision', 'A', '--out', path.join(home.dir, 'pkg'), '--attach');
    expect(attachRefused.out).toContain('PLM_HUMAN_GATE');
    const packed = await llull(
      'release',
      'pack',
      '--revision',
      'A',
      '--out',
      path.join(home.dir, 'pkg2'),
      '--attach',
      '--confirm-key',
      user,
      '--json',
    );
    expect(packed.code, packed.out + packed.err).toBe(EXIT_OK);
    expect(plm().item.revisions['A']?.packageSha256).toBe((JSON.parse(packed.out) as { manifestSha256: string }).manifestSha256);
    const verified = await llull('release', 'verify', path.join(home.dir, 'pkg2'));
    expect(verified.code, verified.out).toBe(EXIT_OK);
    expect(verified.out).toContain('Package verified');

    const manifestFile = path.join(home.dir, 'pkg2', 'manifest.json');
    chmodSync(manifestFile, 0o644);
    writeFileSync(manifestFile, readFileSync(manifestFile, 'utf8').replace('LL-1001', 'LL-1002'));
    expect((await llull('release', 'verify', path.join(home.dir, 'pkg2'))).code).toBe(EXIT_COMMAND_ERROR);

    const audit = await llull('audit', 'verify');
    expect(audit.code).toBe(EXIT_OK);
    expect(audit.out).toMatch(/Audit chain intact: \d+ entries/);
    expect(readFileSync(path.join(home.dir, 'audit', 'audit-000001.jsonl'), 'utf8')).not.toContain('"signature"');
    const file = path.join(home.dir, 'audit', 'audit-000001.jsonl');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"set_item_identity"', '"set_item_idxntity"'));
    const broken = await llull('audit', 'verify');
    expect(broken.code).toBe(EXIT_COMMAND_ERROR);
    expect(broken.out).toContain('PLM_AUDIT_CHAIN_BROKEN');
  });

  it('usage errors exit 2 with a message', async () => {
    for (const argv of [
      ['keys'],
      ['keys', 'create'],
      ['keys', 'revoke', 'k-x'],
      ['release'],
      ['release', 'verify'],
      ['release', 'pack', '--revision', 'A'],
      ['audit'],
      ['release', 'sign', '--revision', 'A', '--key', 'k-x'],
      ['exec', 'plm_status', '--confirm-key', 'k-none'],
    ]) {
      const run = await llull(...argv);
      expect(run.code, argv.join(' ')).toBe(EXIT_USAGE);
      expect(run.err).toContain('llull:');
    }
    delete process.env['LLULL_KEY_PASSPHRASE'];
    expect((await llull('keys', 'create', '--user', 'u', '--name', 'n')).err).toContain('LLULL_KEY_PASSPHRASE');
    expect((await llull('release', 'pack', '--revision', 'A', '--out', path.join(home.dir, 'x'))).err).toContain('not a frozen');
  });
});
