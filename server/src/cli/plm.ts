/**
 * `llull keys | release | audit` and `--confirm-key`: the host side of 09 PLM (key enrollment, release package, audit chain, human confirmations).
 * Commands themselves stay in the registry. This CLI can ENROLL a key and use a TRUSTED one to sign; it can never make a key trusted (desktop app only).
 */

import { randomBytes } from 'node:crypto';
import { humanGatePayload } from '@core/model/humanGate';
import { jcsJson } from '@lib/jcs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { CadDocument } from '@core/model/types';
import type { CommandOutcome } from '@protocol/restProtocol';
import { readDocumentFile } from '../documentFile';
import { auditDir, verifyAuditChain } from '../plm/auditChain';
import { createKeyStore } from '../plm/keyStore';
import { isoSeconds } from '../plm/hostRun';
import { buildReleasePackage, verifyReleasePackage, writeReleasePackage } from '../plm/releasePackage';
import { GATE_CONTEXT, createSignaturePort } from '../plm/signaturePort';
import { createTrustStore } from '../plm/trustStore';
import { type ParsedArgv, booleanFlag, cliTarget, stringFlag } from './argv';
import type { CliBackend } from './backend';

export interface PlmCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Interactive no-echo prompt (a real terminal only); absent or null = no terminal. */
  readonly readPassphrase?: (prompt: string) => Promise<string | null>;
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

/**
 * The passphrase to ENROLL a key: the environment variable named by `--passphrase-env` (default LLULL_KEY_PASSPHRASE). Enrolling a key
 * trusts nothing, so this is the only place an environment passphrase is accepted.
 */
function enrollmentPassphrase(args: ParsedArgv, io: PlmCliIo): string {
  const variable = stringFlag(args, 'passphrase-env') ?? 'LLULL_KEY_PASSPHRASE';
  const value = io.env[variable];
  if (value === undefined || value === '')
    throw new PlmUsage(`set $${variable} to the key passphrase (or name another variable with --passphrase-env).`);
  return value;
}

/**
 * The SIGNING passphrase: typed at an interactive no-echo prompt, never taken from the environment, a flag or stdin (an agent in the user's shell would
 * find it there and sign as the human). With no terminal the signature is refused: use the desktop app (Sign dialog) instead.
 */
async function signingPassphrase(keyName: string, io: PlmCliIo, shown: string): Promise<string> {
  io.stderr(shown);
  const typed = io.readPassphrase === undefined ? null : await io.readPassphrase(`Passphrase of the signing key of ${keyName}: `);
  if (typed === null || typed === '')
    throw new PlmUsage(
      'signing needs the key passphrase typed at an interactive terminal (it is never read from the environment); use the llull desktop app otherwise.',
    );
  return typed;
}

const print = (io: PlmCliIo, args: ParsedArgv, json: unknown, text: string): void =>
  io.stdout(booleanFlag(args, 'json') ? JSON.stringify(json) : text);

const mergedEnv = (io: PlmCliIo): NodeJS.ProcessEnv => ({ ...process.env, ...io.env });

/**
 * `params` of the human-only plm command `name` plus a `confirmation`: the key signs the act payload (`plm_act_payload` of the document the backend
 * holds). Only a TRUSTED key's signature clears the gate; the command verifies it, so a wrong or untrusted key is simply refused.
 * @failure no / revoked key, wrong passphrase, or the payload query refused -> throws a usage message
 */
export async function confirmedParams(backend: CliBackend, name: string, params: unknown, keyId: string, io: PlmCliIo): Promise<unknown> {
  const store = createKeyStore(mergedEnv(io));
  const key = store.find(keyId);
  if (key === undefined) throw new PlmUsage(`unknown --confirm-key ${keyId}; see: llull keys list`);
  const nonce = randomBytes(16).toString('hex');
  const given = typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
  const payload = await backend.run('plm_act_payload', { command: name, params: given, nonce });
  const data = payload.data as
    | { payloadSha256?: string; act?: string; ids?: string[]; details?: { params?: unknown; contentHash?: string; stateHash?: string } }
    | undefined;
  if (payload.isError || data?.payloadSha256 === undefined || data.act === undefined || data.details === undefined)
    throw new PlmUsage(`${name} is not a human-only plm command (${outcomeText(payload)})`);
  // The backend is NOT trusted (--server / desktop.json are agent-writable): check it describes THIS act and rebuild the payload locally.
  const expected = Object.fromEntries(Object.entries(given).filter(([field]) => !['confirmation', 'at', 'by'].includes(field)));
  if (data.act !== `plm:${name}` || jcsJson(data.details.params ?? null) !== jcsJson(expected))
    throw new PlmUsage(`the backend described another act than ${name} with your params; nothing was signed.`);
  const hash = humanGatePayload(data.act, data.ids ?? [], data.details, nonce);
  if (hash !== data.payloadSha256)
    throw new PlmUsage('the backend payload hash is not the hash of the act it described; nothing was signed.');
  const shown = `Signing ${data.act} on part ${(data.ids ?? []).join(',')}; params ${jcsJson(expected)}; document content ${data.details.contentHash ?? '(not bound)'}\n`;
  const signature = await store.sign(key.keyId, await signingPassphrase(key.name, io, shown), `${GATE_CONTEXT}${hash}`);
  if (signature === null) throw new PlmUsage(`the key ${key.keyId} could not sign (wrong passphrase, or it is revoked).`);
  return { ...given, confirmation: { alg: 'Ed25519', keyId: key.keyId, publicKey: key.publicKey, signature, nonce } };
}

async function runKeys(args: ParsedArgv, io: PlmCliIo, now: () => Date): Promise<number> {
  const action = args.positionals[1];
  const env = mergedEnv(io);
  const store = createKeyStore(env);
  const trust = createTrustStore();
  if (action === 'list') {
    const keys = store.list().map((key) => ({ ...key, trusted: trust.find(key.publicKey) !== null }));
    print(
      io,
      args,
      keys,
      keys.length === 0
        ? 'No signing keys. Enroll one: llull keys create --user ID --name NAME'
        : keys
            .map(
              (key) =>
                `${key.keyId}  ${key.userId}  ${key.name}  ${key.publicKey}  ${key.revokedAt !== undefined ? 'REVOKED' : key.trusted ? 'TRUSTED' : 'enrolled, NOT trusted (trust it in the llull desktop app)'}`,
            )
            .join('\n'),
    );
    return OK;
  }
  if (action === 'create') {
    const record = await store.create({
      userId: required(args, 'user'),
      name: required(args, 'name'),
      passphrase: enrollmentPassphrase(args, io),
      at: isoSeconds(now()),
    });
    print(
      io,
      args,
      { ...record, trusted: false },
      `Key ${record.keyId} enrolled for ${record.userId}; public key ${record.publicKey}. It is NOT trusted yet: signatures by it count only after you trust it in the llull desktop app (Keys).`,
    );
    return OK;
  }
  if (action === 'revoke') {
    const keyId = args.positionals[2];
    const record = keyId === undefined ? null : store.revoke(keyId, isoSeconds(now()));
    if (record === null) throw new PlmUsage(`no such key '${String(keyId)}'; see: llull keys list`);
    trust.revoke(record.publicKey, isoSeconds(now()));
    print(io, args, record, `Key ${record.keyId} revoked; its trust is withdrawn and it can no longer sign.`);
    return OK;
  }
  throw new PlmUsage('keys needs an action: list | create --user ID --name NAME | revoke KEYID');
}

async function runSign(args: ParsedArgv, io: PlmCliIo, backend: () => Promise<CliBackend>, now: () => Date): Promise<number> {
  const revision = required(args, 'revision');
  const kind = stringFlag(args, 'kind') === 'iteration' ? 'iteration' : 'release';
  const meaning = stringFlag(args, 'meaning') ?? (kind === 'release' ? 'release' : 'approval');
  const store = createKeyStore(mergedEnv(io));
  const key = store.find(required(args, 'key'));
  if (key === undefined) throw new PlmUsage('unknown --key; see: llull keys list');
  const target = await backend();
  const manifest = await target.run('release_manifest', { revision, kind, meaning });
  const data = manifest.data as { canonical?: string; body?: { item: { iteration: number } } } | undefined;
  if (manifest.isError || data?.canonical === undefined || data.body === undefined) {
    io.stderr(outcomeText(manifest));
    return FAILED;
  }
  // The backend is not trusted: the manifest it returned must be the revision and meaning asked for, and the human sees what is signed.
  const body = JSON.parse(data.canonical) as {
    item?: { partNumber?: string; revision?: string };
    meaning?: string;
    documentContentHash?: string;
  };
  if (body.item?.revision !== revision || body.meaning !== meaning)
    throw new PlmUsage('the backend returned a manifest for another revision or meaning than requested; nothing was signed.');
  const shown = `Signing ${meaning} of ${body.item.partNumber} rev ${body.item.revision}; document content ${body.documentContentHash}\n`;
  const signature = await store.sign(key.keyId, await signingPassphrase(key.name, io, shown), data.canonical);
  if (signature === null) {
    io.stderr(`llull: the key ${key.keyId} could not sign (wrong passphrase, or it is revoked).`);
    return FAILED;
  }
  const params = {
    target: { kind, ref: kind === 'release' ? revision : `${revision}.${data.body.item.iteration}` },
    alg: 'Ed25519',
    keyId: key.keyId,
    publicKey: key.publicKey,
    signature,
    meaning,
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

/** The manifest hash a human attached: `--manifest-sha256`, else `packageSha256` of the package's revision in the managed document (`--doc`). */
function packageAnchor(dir: string, args: ParsedArgv, io: PlmCliIo): string | null {
  const given = stringFlag(args, 'manifest-sha256');
  if (given !== undefined) return given;
  try {
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { item?: { revision?: unknown } };
    const label = manifest.item?.revision;
    const doc = readDocumentFile(cliTarget(args, io.env).doc);
    return typeof label === 'string' ? (doc.plm?.item.revisions[label]?.packageSha256 ?? null) : null;
  } catch {
    return null;
  }
}

async function runRelease(args: ParsedArgv, io: PlmCliIo, backend: () => Promise<CliBackend>, now: () => Date): Promise<number> {
  const action = args.positionals[1];
  if (action === 'verify') {
    const dir = args.positionals[2];
    if (dir === undefined) throw new PlmUsage('release verify needs a package folder: llull release verify DIR');
    const verdict = verifyReleasePackage(dir, createSignaturePort(createTrustStore()), packageAnchor(dir, args, io));
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
    let attach: CommandOutcome | null = null;
    if (booleanFlag(args, 'attach')) {
      const target = await backend();
      const params = {
        revision: required(args, 'revision'),
        manifestSha256: written.manifestSha256,
        documentContentHash: String(pack.manifest['documentContentHash']),
        location: required(args, 'out'),
      };
      const confirmKey = stringFlag(args, 'confirm-key');
      attach = await target.run(
        'attach_release_package',
        confirmKey === undefined ? params : await confirmedParams(target, 'attach_release_package', params, confirmKey, io),
      );
    }
    print(
      io,
      args,
      { ...written, notes: pack.notes, attached: attach === null ? null : outcomeText(attach) },
      `Release package written: ${written.files} file(s), manifest sha256 ${written.manifestSha256}.${notes}${attach !== null ? ` ${outcomeText(attach)}` : ''}`,
    );
    return attach?.isError === true ? FAILED : OK;
  }
  throw new PlmUsage(
    'release needs an action: pack --revision R --out DIR [--attach --confirm-key KEYID] | verify DIR | sign --revision R --key KEYID [--kind release|iteration] [--apply]',
  );
}

function runAudit(args: ParsedArgv, io: PlmCliIo): number {
  if (args.positionals[1] !== 'verify') throw new PlmUsage('audit needs an action: verify [DIR]');
  const dir = args.positionals[2] ?? auditDir();
  if (dir === null) throw new PlmUsage('no audit directory: pass one (the default location is fixed; no environment variable sets it).');
  const verdict = verifyAuditChain(dir);
  print(
    io,
    args,
    verdict,
    verdict.ok
      ? `Audit chain intact: ${verdict.entries} entr${verdict.entries === 1 ? 'y' : 'ies'}${verdict.repairs > 0 ? `, ${verdict.repairs} crash repair(s)` : ''}. The chain is unkeyed: it does not stop someone who can write the directory from rewriting it.`
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
        return await runKeys(args, io, now);
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

export { PlmUsage };
