/** LOTAR archive package (09 PLM M6, VC-PLM-24): the release package plus AP242 PDM, validation properties, records and verification; tamper and CLI end to end. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { CadDocument } from '@core/model/types';
import { deserializeDocument } from '@core/commands/persistence/serialization';
import { jcsJson } from '@lib/jcs';
import { EXIT_COMMAND_ERROR, EXIT_OK, EXIT_USAGE, runCli, type CliIo } from '../src/cli/main';
import { buildLotarPackage, verifyLotarPackage } from '../src/plm/lotarPackage';
import { buildReleasePackage, writeReleasePackage } from '../src/plm/releasePackage';
import { createKeyStore } from '../src/plm/keyStore';
import { createSignaturePort } from '../src/plm/signaturePort';
import { createTrustStore } from '../src/plm/trustStore';
import { issueTrustGrant } from '../src/plm/trustGrant';
import { run } from '../../tests/unit/plm/scenarioRunner';
import { boxOf, step } from '../../tests/unit/materials/support';
import { approveAll, inWork, reviewWithEco } from '../../tests/unit/plm/fixtures';
import { PASSPHRASE, T, type TestHome, testHome, trustedKey } from './plmTestSupport';

const SAMPLE = path.resolve(__dirname, '../../docs/aerospace/09-plm-configuration-traceability/validation/sample_document.json');
const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

let home: TestHome;
let dir = '';
beforeEach(() => {
  home = testHome();
  dir = home.dir;
});
afterEach(() => home.cleanup());

const port = (): ReturnType<typeof createSignaturePort> => createSignaturePort(createTrustStore(home.trust));

/** A released revision A of the sample part, release-signed with a real, trusted local key, with a baseline and an as-built record. */
async function archivable(prepare: (doc: CadDocument) => CadDocument = (doc) => doc): Promise<CadDocument> {
  const key = await trustedKey(home, 'u-1');
  const review = run(prepare(inWork()), 'submit_for_review', { at: T, by: 'u-1' }).document;
  const eco = run(review, 'create_change_order', {
    id: 'ECO-0100',
    purpose: 'initial-release',
    effectivity: [{ kind: 'serial', from: 1 }],
    at: T,
    by: 'u-1',
  }).document;
  const released = run(approveAll(eco), 'release_item', { changeOrder: 'ECO-0100', at: T, by: 'u-1' }).document;
  const real = { ...defaultContext(), humanSignature: port() };
  const manifest = execute(released, 'release_manifest', { revision: 'A', meaning: 'release' }, real).data as { canonical: string };
  const signed = execute(
    released,
    'record_signature',
    {
      target: { kind: 'release', ref: 'A' },
      alg: 'Ed25519',
      keyId: key.record.keyId,
      publicKey: key.record.publicKey,
      signature: await key.raw(manifest.canonical),
      meaning: 'release',
      signer: { userId: 'u-1', name: 'J. Example' },
      at: T,
    },
    real,
  );
  expect(signed.rejected, signed.summary).toBeUndefined();
  const baselined = run(signed.document, 'create_baseline', { id: 'BL-1', name: 'PBL', kind: 'product', at: T, by: 'u-1' }).document;
  return run(baselined, 'record_as_built', {
    serial: 'SN-0001',
    partNumber: 'LL-2001',
    asDesignedBaseline: 'BL-1',
    deviations: [],
    at: T,
    by: 'u-9',
  }).document;
}

const withoutHash = <T extends Record<string, unknown>>(manifest: T): Omit<T, 'manifestSha256'> => {
  const { manifestSha256: omitted, ...rest } = manifest;
  void omitted;
  return rest;
};

const pack = (doc: CadDocument, options = {}): Exclude<ReturnType<typeof buildLotarPackage>, string> => {
  const built = buildLotarPackage(doc, 'A', '0.1.0', undefined, options);
  if (typeof built === 'string') throw new Error(built);
  return built;
};

describe('LOTAR package', () => {
  it('extends the release package with PDM, validation properties, records and the procedure, and verifies end to end', async () => {
    const doc = await archivable();
    const built = pack(doc, { organization: { id: 'CAGE-1', name: 'Acme' } });
    const out = path.join(dir, 'lotar');
    const written = writeReleasePackage(built, out);
    const paths = built.files.map((file) => file.path).sort();
    expect(paths).toEqual(
      expect.arrayContaining([
        'model/LL-2001_A.llull.json',
        'pdm/LL-2001_A.pdm.stp',
        'records/plm-records.json',
        'validation/validation-properties.json',
        'VERIFY.txt',
      ]),
    );
    const manifest = JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8')) as {
      lotar: {
        schema: string;
        content: Record<string, string>;
        validationProperties: { counts: { solids: number }; solids: { volume: number }[] };
        verification: string[];
      };
      members: { path: string; role: string; sha256: string }[];
    };
    expect(manifest.lotar).toMatchObject({
      schema: 'llull-lotar-1',
      content: { native: 'model/LL-2001_A.llull.json', neutral: 'pdm/LL-2001_A.pdm.stp' },
    });
    expect(manifest.lotar.validationProperties.counts.solids).toBeGreaterThan(0);
    expect(manifest.lotar.validationProperties.solids[0]?.volume).toBeGreaterThan(0);
    expect(manifest.lotar.verification).toHaveLength(7);
    expect(manifest.members.find((member) => member.role === 'neutral-pdm')?.sha256).toBe(
      sha256(readFileSync(path.join(out, 'pdm/LL-2001_A.pdm.stp'))),
    );
    expect(readFileSync(path.join(out, 'pdm/LL-2001_A.pdm.stp'), 'utf8')).toContain("ORGANIZATION('CAGE-1','Acme'");
    expect(readFileSync(path.join(out, 'VERIFY.txt'), 'utf8')).toContain('llull lotar verify');
    const records = JSON.parse(readFileSync(path.join(out, 'records/plm-records.json'), 'utf8')) as {
      asBuilt: { serial: string }[];
      baselines: unknown[];
    };
    expect(records.asBuilt.map((record) => record.serial)).toEqual(['SN-0001']);

    const verdict = verifyLotarPackage(out, port(), written.manifestSha256);
    expect(verdict).toMatchObject({ ok: true, findings: [], rederived: true });
    expect(verdict.members).toBe(manifest.members.length);
  });

  it('is deterministic: the same revision packs to the same manifest hash', async () => {
    const doc = await archivable();
    expect(pack(doc).manifest['manifestSha256']).toBe(pack(doc).manifest['manifestSha256']);
  });

  it('without the anchor the verdict is PLM_PACKAGE_UNANCHORED, and a different anchor is a manifest mismatch', async () => {
    const out = path.join(dir, 'lotar');
    writeReleasePackage(pack(await archivable()), out);
    expect(verifyLotarPackage(out, port()).findings.map((finding) => finding.code)).toEqual(['PLM_PACKAGE_UNANCHORED']);
    expect(verifyLotarPackage(out, port(), 'f'.repeat(64)).findings.map((finding) => finding.code)).toEqual([
      'PLM_PACKAGE_MANIFEST_MISMATCH',
    ]);
  });

  it('finds an archived validation property that no longer matches the definition, even when every hash is recomputed (forged archive)', async () => {
    const built = pack(await archivable());
    const out = path.join(dir, 'lotar');
    writeReleasePackage(built, out);
    const manifestFile = path.join(out, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown> & {
      lotar: { validationProperties: { solids: { volume: number }[] } };
      members: { path: string; sha256: string; bytes: number }[];
    };
    manifest.lotar.validationProperties.solids[0]!.volume *= 1.5;
    const properties = `${jcsJson(manifest.lotar.validationProperties)}\n`;
    const propertiesFile = path.join(out, 'validation/validation-properties.json');
    chmodSync(propertiesFile, 0o644);
    writeFileSync(propertiesFile, properties);
    const member = manifest.members.find((candidate) => candidate.path === 'validation/validation-properties.json')!;
    member.sha256 = sha256(properties);
    member.bytes = Buffer.byteLength(properties);
    const { signatures, ...unsealed } = withoutHash(manifest);
    const forged = { ...unsealed, manifestSha256: sha256(jcsJson(unsealed)), signatures };
    chmodSync(manifestFile, 0o644);
    writeFileSync(manifestFile, JSON.stringify(forged, null, 2));
    const verdict = verifyLotarPackage(out, port(), String(forged.manifestSha256));
    expect(verdict.ok).toBe(false);
    expect(verdict.findings.map((finding) => finding.code)).toEqual(['PLM_LOTAR_VALIDATION_MISMATCH']);
    expect(verdict.findings[0]?.message).toContain('volume');
    expect(verifyLotarPackage(out, port(), built.manifest['manifestSha256'] as string).findings.map((finding) => finding.code)).toContain(
      'PLM_PACKAGE_MANIFEST_MISMATCH',
    );
  });

  it('finds a PDM file that does not describe the released revision, and an as-built record edited by hand', async () => {
    const built = pack(await archivable());
    const out = path.join(dir, 'lotar');
    writeReleasePackage(built, out);
    const manifestFile = path.join(out, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown> & {
      members: { path: string; sha256: string; bytes: number }[];
    };
    const rewrite = (file: string, change: (text: string) => string): void => {
      const target = path.join(out, file);
      chmodSync(target, 0o644);
      const text = change(readFileSync(target, 'utf8'));
      writeFileSync(target, text);
      const member = manifest.members.find((candidate) => candidate.path === file)!;
      member.sha256 = sha256(text);
      member.bytes = Buffer.byteLength(text);
    };
    rewrite('pdm/LL-2001_A.pdm.stp', (text) => text.replace("PRODUCT_DEFINITION_FORMATION('A'", "PRODUCT_DEFINITION_FORMATION('B'"));
    rewrite('records/plm-records.json', (text) => text.replace('"by":"u-9"', '"by":"u-0"'));
    const { signatures, ...unsealed } = withoutHash(manifest);
    const forged = { ...unsealed, manifestSha256: sha256(jcsJson(unsealed)), signatures };
    chmodSync(manifestFile, 0o644);
    writeFileSync(manifestFile, JSON.stringify(forged, null, 2));
    const codes = verifyLotarPackage(out, port(), String(forged.manifestSha256)).findings.map((finding) => finding.code);
    expect(codes).toEqual(['PLM_LOTAR_PDM_MISMATCH', 'PLM_LOTAR_RECORDS_MISMATCH']);
  });

  it('refuses a plain release package, a missing PDM / records member and an unloadable definition', async () => {
    const doc = await archivable();
    const plain = buildReleasePackage(doc, 'A', '0.1.0');
    if (typeof plain === 'string') throw new Error(plain);
    const plainDir = path.join(dir, 'plain');
    const plainWritten = writeReleasePackage(plain, plainDir);
    expect(verifyLotarPackage(plainDir, port(), plainWritten.manifestSha256).findings.map((finding) => finding.code)).toContain(
      'PLM_LOTAR_NOT_A_PACKAGE',
    );

    const out = path.join(dir, 'lotar');
    const built = pack(doc);
    writeReleasePackage(built, out);
    const manifestFile = path.join(out, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown> & {
      lotar: { content: Record<string, string> };
    };
    manifest.lotar.content = { native: 'model/none.json', neutral: 'pdm/none.stp', records: 'records/none.json' };
    chmodSync(manifestFile, 0o644);
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    const codes = verifyLotarPackage(out, port()).findings.map((finding) => finding.code);
    expect(codes).toEqual(
      expect.arrayContaining(['PLM_LOTAR_VALIDATION_MISMATCH', 'PLM_LOTAR_PDM_MISMATCH', 'PLM_LOTAR_RECORDS_MISMATCH']),
    );
    expect(verifyLotarPackage(path.join(dir, 'nothing'), port()).ok).toBe(false);
  });

  it('only archives a frozen revision, and an export-controlled definition needs the human confirmation', async () => {
    const doc = await archivable();
    expect(buildLotarPackage(doc, 'Z', '0.1.0', undefined)).toContain('not a frozen');
    expect(buildLotarPackage(run(reviewWithEco(), 'reject_review', { at: T, by: 'u-1' }).document, 'A', '0.1.0', undefined)).toContain(
      'not a frozen',
    );
    const used = await archivable((draft) => {
      const record = { id: 'secret', designation: 'X', specs: [], licence: 'company-proprietary', exportMarking: { regime: 'ITAR' } };
      return boxOf(step(draft, 'define_material_record', record), 'secret').doc;
    });
    const refused = buildLotarPackage(used, 'A', '0.1.0', undefined);
    expect(typeof refused === 'string' ? refused : 'built').toContain('MAT_EXPORT_CONTROLLED');
  });
});

describe('llull lotar (CLI)', () => {
  let docPath = '';
  beforeEach(() => {
    docPath = path.join(home.dir, 'part.llull.json');
    copyFileSync(SAMPLE, docPath);
    home.apply();
  });

  async function llull(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      readStdin: () => Promise.resolve(''),
      env: { ...process.env },
      prepareKernel: () => Promise.resolve(),
      readPassphrase: () => Promise.resolve(PASSPHRASE),
    };
    const code = await runCli([...argv, '--doc', docPath], io);
    return { code, out: out.join('\n'), err: err.join('\n') };
  }
  const exec = (command: string, params: unknown, ...flags: string[]): ReturnType<typeof llull> =>
    llull('exec', command, JSON.stringify(params), '--json', ...flags);

  async function trusted(user: string): Promise<string> {
    const created = await llull('keys', 'create', '--user', user, '--name', `User ${user}`, '--json');
    expect(created.code).toBe(EXIT_OK);
    const key = JSON.parse(created.out) as { keyId: string };
    createTrustStore(home.trust).trust(createKeyStore(home.env).find(key.keyId) as never, issueTrustGrant('test'), T);
    return key.keyId;
  }

  it('packs a released revision, attaches the hash as a human act, and verifies it against the attached hash; a flipped byte fails', async () => {
    const user = await trusted('u-1');
    const checker = await trusted('u-2');
    await exec(
      'set_item_identity',
      { partNumber: 'LL-1001', name: 'Bracket', itemType: 'part', policy: { humanSignatureRequired: false } },
      '--confirm-key',
      user,
    );
    await exec('submit_for_review', {});
    await exec('record_approval', { role: 'design-authority' }, '--confirm-key', user);
    await exec('record_approval', { role: 'checker' }, '--confirm-key', checker);
    await exec('release_item', {}, '--confirm-key', user);
    expect((await llull('release', 'sign', '--revision', 'A', '--key', user, '--apply')).code).toBe(EXIT_OK);
    const out = path.join(home.dir, 'archive');
    const refused = await llull('lotar', 'pack', '--revision', 'A', '--out', path.join(home.dir, 'refused'), '--attach');
    expect(refused.out).toContain('PLM_HUMAN_GATE');
    const packed = await llull(
      'lotar',
      'pack',
      '--revision',
      'A',
      '--out',
      out,
      '--organization-id',
      'CAGE-1',
      '--organization-name',
      'Acme',
      '--attach',
      '--confirm-key',
      user,
      '--json',
    );
    expect(packed.code, packed.out + packed.err).toBe(EXIT_OK);
    const attachedHash = deserializeDocument(readFileSync(docPath, 'utf8')).plm?.item.revisions['A']?.packageSha256;
    expect(attachedHash).toBe((JSON.parse(packed.out) as { manifestSha256: string }).manifestSha256);
    expect(existsSync(path.join(out, 'pdm/LL-1001_A.pdm.stp'))).toBe(true);
    const verified = await llull('lotar', 'verify', out);
    expect(verified.code, verified.out + verified.err).toBe(EXIT_OK);
    expect(verified.out).toContain('LOTAR package verified');
    const noAnchor = await llull('lotar', 'verify', out, '--manifest-sha256', 'f'.repeat(64), '--json');
    expect(noAnchor.code).toBe(EXIT_COMMAND_ERROR);
    expect(JSON.stringify(JSON.parse(noAnchor.out))).toContain('PLM_PACKAGE_MANIFEST_MISMATCH');
    const stp = path.join(out, 'pdm/LL-1001_A.pdm.stp');
    chmodSync(stp, 0o644);
    writeFileSync(stp, readFileSync(stp, 'utf8').replace('LL-1001', 'LL-1009'));
    expect((await llull('lotar', 'verify', out)).out).toContain('PLM_PACKAGE_MEMBER_MISMATCH');
  });

  it('exits 2 with a message on usage errors', async () => {
    for (const argv of [
      ['lotar'],
      ['lotar', 'verify'],
      ['lotar', 'pack', '--revision', 'A'],
      ['lotar', 'pack', '--out', path.join(home.dir, 'x')],
    ]) {
      const result = await llull(...argv);
      expect(result.code, argv.join(' ')).toBe(EXIT_USAGE);
      expect(result.err).toContain('llull:');
    }
  });
});
