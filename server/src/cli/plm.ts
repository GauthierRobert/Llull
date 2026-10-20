/** `llull keys | release | audit`: the host side of 09 PLM (signing key store, release package, audit chain). Commands themselves stay in the registry. */

import type { CadDocument } from '@core/model/types';
import { readDocumentFile } from '../documentFile';
import { auditDir, verifyAuditChain } from '../plm/auditChain';
import { createKeyStore } from '../plm/keyStore';
import { isoSeconds } from '../plm/hostRun';
import { buildReleasePackage, verifyReleasePackage, writeReleasePackage } from '../plm/releasePackage';
import { createSignaturePort } from '../plm/signaturePort';
import { type ParsedArgv, booleanFlag, cliTarget, stringFlag } from './argv';
import type { CliBackend } from './backend';
import type { CommandOutcome } from '@protocol/restProtocol';

export interface PlmCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const OK = 0;
const FAILED = 1;
const USAGE_ERROR = 2;

class PlmUsage extends Error {}

/** A command outcome as one line, with its stable code and remediation when it was refused (AF-11). */
const outcomeText = (outcome: CommandOutcome): string =>
  outcome.error === undefined ? outcome.summary : `${outcome.error.code}: ${outcome.summary} (${outcome.error.remediation})`;

const required = (args: ParsedArgv, flag: string): string => {
  const value = stringFlag(args, flag);
  if (value === undefined || value === '') throw new PlmUsage(`--${flag} is required.`);
  return value;
};

/** The key passphrase: the environment variable named by `--passphrase-env` (default LLULL_KEY_PASSPHRASE); never an argument, never printed. */
function passphraseOf(args: ParsedArgv, io: PlmCliIo): string {
  const variable = stringFlag(args, 'passphrase-env') ?? 'LLULL_KEY_PASSPHRASE';
  const value = io.env[variable];
  if (value === undefined || value === '')
    throw new PlmUsage(`set $${variable} to the key passphrase (or name another variable with --passphrase-env).`);
  return value;
}

const print = (io: PlmCliIo, args: ParsedArgv, json: unknown, text: string): void =>
  io.stdout(booleanFlag(args, 'json') ? JSON.stringify(json) : text);

function runKeys(args: ParsedArgv, io: PlmCliIo, now: () => Date): number {
  const action = args.positionals[1];
  const store = createKeyStore({ ...process.env, ...io.env });
  if (action === 'list') {
    const keys = store.list();
    print(
      io,
      args,
      keys,
      keys.length === 0
        ? 'No signing keys. Create one: llull keys create --user ID --name NAME'
        : keys
            .map((key) => `${key.keyId}  ${key.userId}  ${key.name}  ${key.publicKey}${key.revokedAt !== undefined ? '  REVOKED' : ''}`)
            .join('\n'),
    );
    return OK;
  }
  if (action === 'create') {
    const record = store.create({
      userId: required(args, 'user'),
      name: required(args, 'name'),
      passphrase: passphraseOf(args, io),
      at: isoSeconds(now()),
    });
    print(
      io,
      args,
      record,
      `Key ${record.keyId} created for ${record.userId}; public key ${record.publicKey}. The private key stays encrypted in ${'$LLULL_KEYS_DIR'} (default ~/.llull/keys).`,
    );
    return OK;
  }
  if (action === 'revoke') {
    const keyId = args.positionals[2];
    const record = keyId === undefined ? null : store.revoke(keyId, isoSeconds(now()));
    if (record === null) throw new PlmUsage(`no such key '${String(keyId)}'; see: llull keys list`);
    print(
      io,
      args,
      record,
      `Key ${record.keyId} revoked at ${record.revokedAt ?? ''}; signatures it made keep their provenance but are no longer trusted.`,
    );
    return OK;
  }
  throw new PlmUsage('keys needs an action: list | create --user ID --name NAME | revoke KEYID');
}

async function runSign(args: ParsedArgv, io: PlmCliIo, backend: () => Promise<CliBackend>, now: () => Date): Promise<number> {
  const revision = required(args, 'revision');
  const kind = stringFlag(args, 'kind') === 'iteration' ? 'iteration' : 'release';
  const store = createKeyStore({ ...process.env, ...io.env });
  const key = store.find(required(args, 'key'));
  if (key === undefined) throw new PlmUsage('unknown --key; see: llull keys list');
  const target = await backend();
  const manifest = await target.run('release_manifest', { revision, kind });
  const canonical = (manifest.data as { canonical?: string } | undefined)?.canonical;
  if (manifest.isError || canonical === undefined) {
    io.stderr(manifest.summary);
    return FAILED;
  }
  const signature = store.sign(key.keyId, passphraseOf(args, io), canonical);
  if (signature === null) {
    io.stderr(`llull: the key ${key.keyId} could not sign (wrong passphrase, or it is revoked).`);
    return FAILED;
  }
  const iteration = (manifest.data as { body: { item: { iteration: number } } }).body.item.iteration;
  const params = {
    target: { kind, ref: kind === 'release' ? revision : `${revision}.${iteration}` },
    alg: 'Ed25519',
    keyId: key.keyId,
    publicKey: key.publicKey,
    signature,
    meaning: stringFlag(args, 'meaning') ?? (kind === 'release' ? 'release' : 'approval'),
    signer: { userId: key.userId, name: key.name },
    at: isoSeconds(now()),
  };
  if (!booleanFlag(args, 'apply')) {
    io.stdout(JSON.stringify(params));
    return OK;
  }
  const applied = await target.run('record_signature', params);
  io.stdout(outcomeText(applied));
  return applied.isError ? FAILED : OK;
}

async function runRelease(args: ParsedArgv, io: PlmCliIo, backend: () => Promise<CliBackend>, now: () => Date): Promise<number> {
  const action = args.positionals[1];
  if (action === 'verify') {
    const dir = args.positionals[2];
    if (dir === undefined) throw new PlmUsage('release verify needs a package folder: llull release verify DIR');
    const verdict = verifyReleasePackage(
      dir,
      createSignaturePort(createKeyStore({ ...process.env, ...io.env }), { ...process.env, ...io.env }),
    );
    print(
      io,
      args,
      verdict,
      verdict.ok
        ? `Package verified: ${verdict.members} member(s), manifest and signatures consistent.`
        : verdict.findings.map((finding) => `${finding.code}: ${finding.message}`).join('\n'),
    );
    return verdict.ok ? OK : FAILED;
  }
  if (action === 'sign') return runSign(args, io, backend, now);
  if (action === 'pack') {
    const doc: CadDocument = readDocumentFile(cliTarget(args, io.env).doc);
    const pack = buildReleasePackage(doc, required(args, 'revision'), io.env['LLULL_VERSION'] ?? 'dev');
    if (typeof pack === 'string') throw new PlmUsage(pack);
    const written = writeReleasePackage(pack, required(args, 'out'));
    const notes = pack.notes.length > 0 ? ` Notes: ${pack.notes.join('; ')}.` : '';
    const attach = booleanFlag(args, 'attach')
      ? await (
          await backend()
        ).run('attach_release_package', {
          revision: required(args, 'revision'),
          manifestSha256: written.manifestSha256,
          documentContentHash: String(pack.manifest['documentContentHash']),
          location: required(args, 'out'),
        })
      : null;
    print(
      io,
      args,
      { ...written, notes: pack.notes, attached: attach === null ? null : outcomeText(attach) },
      `Release package written: ${written.files} file(s), manifest sha256 ${written.manifestSha256}.${notes}${attach !== null ? ` ${outcomeText(attach)}` : ''}`,
    );
    return attach?.isError === true ? FAILED : OK;
  }
  throw new PlmUsage(
    'release needs an action: pack --revision R --out DIR [--attach] | verify DIR | sign --revision R --key KEYID [--kind release|iteration] [--apply]',
  );
}

function runAudit(args: ParsedArgv, io: PlmCliIo): number {
  if (args.positionals[1] !== 'verify') throw new PlmUsage('audit needs an action: verify [DIR]');
  const dir = args.positionals[2] ?? auditDir({ ...process.env, ...io.env });
  if (dir === null) throw new PlmUsage('no audit directory: pass one or set $LLULL_AUDIT_DIR.');
  const verdict = verifyAuditChain(dir);
  print(
    io,
    args,
    verdict,
    verdict.ok
      ? `Audit chain intact: ${verdict.entries} entr${verdict.entries === 1 ? 'y' : 'ies'}.`
      : `PLM_AUDIT_CHAIN_BROKEN at ${verdict.brokenAt?.file}:${verdict.brokenAt?.line} (${verdict.brokenAt?.reason}). Investigate tampering; do not rotate.`,
  );
  return verdict.ok ? OK : FAILED;
}

/** Run `keys`, `release` or `audit`; usage mistakes print a message and return 2. */
export async function runPlmCli(
  args: ParsedArgv,
  io: PlmCliIo,
  backend: () => Promise<CliBackend>,
  now: () => Date = () => new Date(),
): Promise<number> {
  try {
    switch (args.positionals[0]) {
      case 'keys':
        return runKeys(args, io, now);
      case 'release':
        return await runRelease(args, io, backend, now);
      default:
        return runAudit(args, io);
    }
  } catch (error) {
    if (!(error instanceof PlmUsage)) throw error;
    io.stderr(`llull: ${error.message}`);
    return USAGE_ERROR;
  }
}
