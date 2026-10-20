/** `llull` CLI parity for 09 PLM (VC-PLM-22, 25, 26): human / agent callers, host-filled time, keys, signing, package, audit. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deserializeDocument } from '@core/commands/persistence/serialization';
import { EXIT_COMMAND_ERROR, EXIT_OK, EXIT_USAGE, runCli, type CliIo } from '../src/cli/main';

const SAMPLE = path.resolve(__dirname, '../../docs/aerospace/09-plm-configuration-traceability/validation/sample_document.json');

let work = '';
let docPath = '';
const touched = ['LLULL_KEYS_DIR', 'LLULL_AUDIT_DIR', 'LLULL_KEY_PASSPHRASE', 'LLULL_USER'] as const;

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'llull-plmcli-'));
  docPath = path.join(work, 'part.llull.json');
  copyFileSync(SAMPLE, docPath);
  process.env['LLULL_KEYS_DIR'] = path.join(work, 'keys');
  process.env['LLULL_AUDIT_DIR'] = path.join(work, 'audit');
  process.env['LLULL_KEY_PASSPHRASE'] = 'correct horse';
  process.env['LLULL_USER'] = 'u-cli';
});
afterEach(() => {
  for (const name of touched) delete process.env[name];
  rmSync(work, { recursive: true, force: true });
});

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}
async function llull(...argv: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    readStdin: () => Promise.resolve(''),
    env: { ...process.env },
    prepareKernel: () => Promise.resolve(),
  };
  const code = await runCli([...argv, '--doc', docPath], io);
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const json = (run: Run): { isError: boolean; summary: string; data?: unknown; error?: { code: string; remediation: string } } =>
  JSON.parse(run.out) as never;
const exec = (command: string, params: unknown, ...flags: string[]): Promise<Run> =>
  llull('exec', command, JSON.stringify(params), '--json', ...flags);
const plm = (): NonNullable<ReturnType<typeof deserializeDocument>['plm']> =>
  deserializeDocument(readFileSync(docPath, 'utf8')).plm as never;

describe('PLM through the CLI', () => {
  it('a human prepares and releases with the time and user filled by the host; an agent is refused with a stable code', async () => {
    const identity = { partNumber: 'LL-1001', name: 'Bracket', itemType: 'part', policy: { humanSignatureRequired: false } };
    const agentPolicy = await exec('set_item_identity', identity);
    expect(agentPolicy.code).toBe(EXIT_COMMAND_ERROR);
    expect(json(agentPolicy).error?.code).toBe('PLM_HUMAN_GATE');
    expect(json(agentPolicy).error?.remediation).not.toBe('');

    expect((await exec('set_item_identity', identity, '--as', 'human')).code).toBe(EXIT_OK);
    expect((await exec('submit_for_review', {})).code).toBe(EXIT_OK);
    expect(plm().item.revisions['A']?.iterations[0]).toMatchObject({ by: 'u-cli' });
    expect(plm().item.revisions['A']?.stateHistory.at(-1)).toMatchObject({ to: 'in_review', by: 'agent' });
    expect(plm().item.revisions['A']?.stateHistory.at(-1)?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    const refused = await exec('release_item', {
      approvals: [
        { role: 'design-authority', userId: 'u-1' },
        { role: 'checker', userId: 'u-2' },
      ],
    });
    expect(json(refused).error?.code).toBe('PLM_HUMAN_GATE');
    expect(plm().item.revisions['A']?.state).toBe('in_review');
    const released = await exec(
      'release_item',
      {
        approvals: [
          { role: 'design-authority', userId: 'u-1' },
          { role: 'checker', userId: 'u-2' },
        ],
      },
      '--as',
      'human',
    );
    expect(released.code, released.out).toBe(EXIT_OK);
    expect(plm().item.revisions['A']).toMatchObject({ state: 'released', releasedBy: 'u-cli' });
    const locked = await exec('add_box', { size: [1, 1, 1] });
    expect(json(locked).error?.code).toBe('PLM_LOCKED');
    expect((await exec('plm_status', {})).code).toBe(EXIT_OK);
  });

  it('keys, release sign --apply, release pack --attach, release verify and audit verify work end to end', async () => {
    await exec(
      'set_item_identity',
      { partNumber: 'LL-1001', name: 'Bracket', itemType: 'part', policy: { humanSignatureRequired: false } },
      '--as',
      'human',
    );
    await exec('submit_for_review', {});
    await exec(
      'release_item',
      {
        approvals: [
          { role: 'design-authority', userId: 'u-1' },
          { role: 'checker', userId: 'u-2' },
        ],
      },
      '--as',
      'human',
    );

    expect((await llull('keys', 'list')).out).toContain('No signing keys');
    const created = await llull('keys', 'create', '--user', 'u-1', '--name', 'J. Example', '--json');
    expect(created.code).toBe(EXIT_OK);
    const key = JSON.parse(created.out) as { keyId: string; publicKey: string };
    expect((await llull('keys', 'list')).out).toContain(key.keyId);

    const printed = await llull('release', 'sign', '--revision', 'A', '--key', key.keyId);
    expect(printed.code).toBe(EXIT_OK);
    expect((JSON.parse(printed.out) as { signer: { userId: string } }).signer.userId).toBe('u-1');
    expect((await llull('release', 'sign', '--revision', 'A', '--key', key.keyId, '--apply')).out).toContain('PLM_HUMAN_GATE');
    const signed = await llull('release', 'sign', '--revision', 'A', '--key', key.keyId, '--apply', '--as', 'human');
    expect(signed.code, signed.out + signed.err).toBe(EXIT_OK);
    expect(plm().item.revisions['A']?.signatures).toHaveLength(1);

    const out = path.join(work, 'pkg');
    expect((await llull('release', 'pack', '--revision', 'A', '--out', out, '--attach')).out).toContain('PLM_HUMAN_GATE');
    const packed = await llull(
      'release',
      'pack',
      '--revision',
      'A',
      '--out',
      path.join(work, 'pkg2'),
      '--attach',
      '--as',
      'human',
      '--json',
    );
    expect(packed.code, packed.out + packed.err).toBe(EXIT_OK);
    expect(plm().item.revisions['A']?.packageSha256).toBe((JSON.parse(packed.out) as { manifestSha256: string }).manifestSha256);
    const verified = await llull('release', 'verify', path.join(work, 'pkg2'));
    expect(verified.code, verified.out).toBe(EXIT_OK);
    expect(verified.out).toContain('Package verified');

    chmodSync(path.join(work, 'pkg2', 'manifest.json'), 0o644);
    writeFileSync(
      path.join(work, 'pkg2', 'manifest.json'),
      `${readFileSync(path.join(work, 'pkg2', 'manifest.json'), 'utf8').replace('LL-1001', 'LL-1002')}`,
    );
    expect((await llull('release', 'verify', path.join(work, 'pkg2'))).code).toBe(EXIT_COMMAND_ERROR);

    const audit = await llull('audit', 'verify');
    expect(audit.code).toBe(EXIT_OK);
    expect(audit.out).toMatch(/Audit chain intact: \d+ entries/);
    const file = path.join(work, 'audit', 'audit-000001.jsonl');
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
      ['exec', 'plm_status', '--as', 'robot'],
    ]) {
      const run = await llull(...argv);
      expect(run.code, argv.join(' ')).toBe(EXIT_USAGE);
      expect(run.err).toContain('llull:');
    }
    delete process.env['LLULL_KEY_PASSPHRASE'];
    expect((await llull('keys', 'create', '--user', 'u', '--name', 'n')).err).toContain('LLULL_KEY_PASSPHRASE');
    expect((await llull('release', 'pack', '--revision', 'A', '--out', path.join(work, 'x'))).err).toContain('not a frozen');
  });
});
