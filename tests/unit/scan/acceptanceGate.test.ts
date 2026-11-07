/**
 * accept_registration / accept_asbuilt_extraction as human gates (FIX-SIG-REST): the signature is `confirmation` and never reaches the history,
 * is verified first and spent last (once), is bound to the document uid, and a replay keeps the acceptance only from a ledger a human really signed.
 */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { HumanSignaturePort } from '@core/model/analysis';
import type { CloudOp, CloudOpResult } from '@core/model/pointCloud';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import { extractionPayload } from '@aec/scan/extractionCommands';
import { registrationPayload } from '@aec/scan/registrationCommands';
import { expectBoundToDocument } from '../../helpers/documentBinding';
import { expectPure } from '../../helpers/expectNoOp';
import { fixturePort, KEY_A, KEY_B, opOk } from './fixturePort';

const SECRET = 'sig-bytes-77c1';

/** A signing port that accepts only a confirmation made over exactly `payload` (the signature carries it) and spends each once, like a real one. */
function port(): HumanSignaturePort & { readonly spentCount: () => number } {
  const spent = new Set<string>();
  return {
    verify: (given, payload) =>
      isRecord(given) && given['secret'] === SECRET && given['payload'] === payload ? { signer: 'pat', signatureId: 'sig-1' } : null,
    spend: (given, payload) => {
      const key = `${JSON.stringify(given)}|${payload}`;
      if (spent.has(key)) return false;
      spent.add(key);
      return true;
    },
    spentCount: () => spent.size,
  };
}
const withPort = (signing: HumanSignaturePort | null): ExecutionContext => ({ ...defaultContext(), humanSignature: signing });
const signedFor = (payload: string, nonce = 'n1'): Record<string, unknown> => ({ nonce, secret: SECRET, payload });

interface Gate {
  readonly command: string;
  readonly idParam: string;
  readonly notFound: string;
  readonly table: 'registrations' | 'extractions';
  readonly document: CadDocument;
  readonly id: string;
  readonly payload: (document: CadDocument, nonce?: string) => string;
}

const shift = (x: number): number[] => [1, 0, 0, x, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function registrationGate(): Gate {
  const ctx: ExecutionContext = {
    ...defaultContext(),
    pointClouds: fixturePort([
      { key: KEY_A, points: [[0, 0, 0]] },
      { key: KEY_B, points: [[0, 0, 0]] },
    ]),
  };
  const a = execute({ ...createEmptyDocument(), units: 'm' }, 'attach_point_cloud', { assetKey: KEY_A }, ctx);
  const b = execute(a.document, 'attach_point_cloud', { assetKey: KEY_B, transform: shift(2) }, ctx);
  const supplied = execute(b.document, 'mark_registration_supplied', { cloudId: b.affected[0] ?? '' });
  const id = supplied.affected[0] ?? '';
  return {
    command: 'accept_registration',
    idParam: 'registrationId',
    notFound: 'SCN_REG_NOT_FOUND',
    table: 'registrations',
    document: supplied.document,
    id,
    payload: (document, nonce = 'n1') => registrationPayload(document.scan?.registrations[id] as never, document.uid ?? '', nonce),
  };
}

function extractionGate(): Gate {
  const fit = {
    axisPoint: [1, 0, 1],
    axisDirection: [1, 0, 0],
    radius: 0.05715,
    start: [0, 0, 1],
    end: [2, 0, 1],
    length: 2,
    inliers: 4000,
    pointsInRegion: 4100,
    rms: 0.001,
    coverageDeg: 180,
    covariance: [[1e-8]],
    std: { radius: 3e-5, axisAngleDeg: 0.003, axisPosition: 8e-5 },
    crlb: { radius: 3e-5, axisAngleDeg: 0.003, axisPosition: 8e-5 },
    threshold: { value: 0.003, source: '3 x noiseSigma', spacing: 0.01 },
    ransacIterations: 40,
    warnings: [],
  };
  const answer = (op: CloudOp): CloudOpResult =>
    opOk(op.kind === 'extract_pipes' ? { extractions: [fit], rejected: [] } : { ...fit, kind: 'cylinder' });
  const ctx: ExecutionContext = { ...defaultContext(), pointClouds: fixturePort([{ key: KEY_A, points: [[0, 0, 0]] }], answer) };
  const attached = execute(createEmptyDocument(), 'attach_point_cloud', { assetKey: KEY_A }, ctx);
  const cloudId = attached.affected[0] ?? '';
  const extracted = execute(attached.document, 'extract_pipes', { cloudId, region: { kind: 'all' }, noiseSigma: 1 }, ctx);
  const extraction = ((extracted.data as { extractions: { extraction: unknown }[] }).extractions[0] as { extraction: unknown }).extraction;
  const committed = execute(attached.document, 'commit_asbuilt_extraction', { extraction }, ctx);
  const id = committed.affected[0] ?? '';
  return {
    command: 'accept_asbuilt_extraction',
    idParam: 'extractionId',
    notFound: 'SCN_EXTRACTION_NOT_FOUND',
    table: 'extractions',
    document: committed.document,
    id,
    payload: (document, nonce = 'n1') => extractionPayload(document.scan?.extractions[id] as never, document.uid ?? '', nonce),
  };
}

describe.each([
  ['accept_registration', registrationGate],
  ['accept_asbuilt_extraction', extractionGate],
])('%s', (_name, build) => {
  const gate = build();
  const { command, document: doc, id } = gate;
  const accept = (document: CadDocument, confirmation: unknown, signing: HumanSignaturePort | null = port()): CadDocument =>
    execute(document, command, { [gate.idParam]: id, confirmation }, withPort(signing)).document;
  const run = (document: CadDocument, params: Record<string, unknown>, signing: HumanSignaturePort | null): CommandResult =>
    execute(document, command, { [gate.idParam]: id, ...params }, withPort(signing));
  const status = (document: CadDocument): unknown => document.scan?.[gate.table][id]?.status;
  const confirmation = signedFor(gate.payload(doc));
  const signed = accept(doc, confirmation);

  it('the document starts un-accepted with a uid', () => {
    expect(status(doc)).not.toBe('accepted');
    expect(doc.uid).toMatch(/^[0-9a-f]{32}$/);
  });

  it('accepts once with the verified signer; the history and the saved file hold no signature', () => {
    const signing = port();
    const result = run(doc, { confirmation }, signing);
    expect(result.rejected, result.summary).toBeUndefined();
    expect(result.affected).toEqual([id]);
    expect(result.document.scan?.[gate.table][id]).toMatchObject({
      status: 'accepted',
      acceptedBy: { signer: 'pat', signatureId: 'sig-1' },
    });
    expect(result.document.scan?.acceptanceLedger).toEqual([
      expect.objectContaining({ act: command, targetId: id, signer: 'pat', documentUid: doc.uid, signature: confirmation }),
    ]);
    expect(signing.spentCount()).toBe(1);
    expect(result.document.featureHistory.at(-1)?.params).toMatchObject({ [gate.idParam]: id, confirmation: { verified: true } });
    expect(JSON.stringify(result.document.featureHistory)).not.toContain(SECRET);
    expect(JSON.stringify(deserializeDocument(serializeDocument(result.document)).featureHistory)).not.toContain(SECRET);
    // the same signature is single-use: a retry is refused and burns nothing more
    const retry = run(result.document, { confirmation }, signing);
    expect(retry.error?.code).toBe('SCN_HUMAN_GATE');
    expect(signing.spentCount()).toBe(1);
    expectPure(doc, () => run(doc, { confirmation }, port()));
  });

  it('every refusal leaves the signature unspent (the spend comes last)', () => {
    const signing = port();
    const { uid, ...bare } = doc;
    void uid;
    const bareSigned = execute(bare, command, { [gate.idParam]: id, confirmation: signedFor(gate.payload(bare)) }, withPort(signing));
    expect(bareSigned.error?.code).toBe('SCN_DOCUMENT_UNIDENTIFIED');
    expect(bareSigned.document).toBe(bare);
    const refusals = [
      execute(doc, command, { [gate.idParam]: 'nope-1.1', confirmation }, withPort(signing)),
      run(doc, { confirmation: signedFor('0'.repeat(64)) }, signing),
      run(doc, { confirmation: { ...confirmation, secret: 'forged' } }, signing),
    ];
    expect(refusals.map((result) => result.error?.code)).toEqual([gate.notFound, 'SCN_HUMAN_GATE', 'SCN_HUMAN_GATE']);
    expect(refusals.every((result) => result.document === doc)).toBe(true);
    expect(signing.spentCount()).toBe(0);
    expect(run(doc, { confirmation }, signing).rejected).not.toBe(true);
    expect(signing.spentCount()).toBe(1);
  });

  it('binds a signer-chosen nonce: no nonce is refused, and after an undo the act is signed again with a new nonce (the same bytes stay spent)', () => {
    const signing = port();
    const noNonce = { secret: SECRET, payload: gate.payload(doc, '') };
    expect(run(doc, { confirmation: noNonce }, signing).error?.code).toBe('SCN_HUMAN_GATE');
    expect(signing.spentCount()).toBe(0);
    expect(run(doc, { confirmation }, signing).rejected).not.toBe(true);
    // undo: the document before the acceptance; the identical signature is dead, a new nonce is a new signature
    expect(run(doc, { confirmation }, signing).error?.code).toBe('SCN_HUMAN_GATE');
    const again = run(doc, { confirmation: signedFor(gate.payload(doc, 'n2'), 'n2') }, signing);
    expect(again.rejected, again.summary).not.toBe(true);
    expect(status(again.document)).toBe('accepted');
    expect(signing.spentCount()).toBe(2);
  });

  it('scan_acceptance_payload returns exactly the payload the gate verifies, and refuses an unknown id', () => {
    const asked = execute(doc, 'scan_acceptance_payload', { act: command, id, nonce: 'n7' });
    expect((asked.data as { payloadSha256: string }).payloadSha256).toBe(gate.payload(doc, 'n7'));
    expect(execute(doc, 'scan_acceptance_payload', { act: command, id: 'nope-1.1', nonce: 'n7' }).error?.code).toBe(gate.notFound);
    const { uid, ...bare } = doc;
    void uid;
    expect(execute(bare, 'scan_acceptance_payload', { act: command, id, nonce: 'n7' }).error?.code).toBe('SCN_DOCUMENT_UNIDENTIFIED');
  });

  it('check_point_clouds re-verifies an accepted status: a planted one is a fail item, no port is a warning, a signed one is clean', () => {
    const codes = (document: CadDocument, signing: HumanSignaturePort | null): { severity: string; code: string }[] =>
      (execute(document, 'check_point_clouds', {}, withPort(signing)).data as { items: { severity: string; code: string }[] }).items
        .filter((entry) => /^SCN_(ACCEPTANCE|REGISTRATION_UNVERIFIED|REVIEW_REQUIRED)/.test(entry.code))
        .map(({ severity, code }) => ({ severity, code }));
    const pending = ['SCN_REGISTRATION_UNVERIFIED', 'SCN_REVIEW_REQUIRED'];
    expect(
      codes(doc, port())
        .map((entry) => entry.code)
        .some((code) => pending.includes(code)),
    ).toBe(true);
    expect(codes(signed, port()).map((entry) => entry.code)).toEqual([]);
    expect(codes(signed, null)).toEqual([{ severity: 'warn', code: 'SCN_ACCEPTANCE_UNVERIFIABLE' }]);
    const planted = {
      ...doc,
      scan: { ...doc.scan, [gate.table]: { ...doc.scan?.[gate.table], [id]: { ...doc.scan?.[gate.table][id], status: 'accepted' } } },
    } as CadDocument;
    const found = codes(planted, port());
    expect(found).toContainEqual({ severity: 'fail', code: 'SCN_ACCEPTANCE_UNBACKED' });
    expect(found.some((entry) => pending.includes(entry.code))).toBe(true);
    const forged = {
      ...signed,
      scan: { ...signed.scan, acceptanceLedger: [{ ...signed.scan?.acceptanceLedger?.[0], signature: signedFor('0'.repeat(64)) }] },
    } as unknown as CadDocument;
    expect(codes(forged, port())).toContainEqual({ severity: 'fail', code: 'SCN_ACCEPTANCE_UNBACKED' });
  });

  it('an agent without a signature is refused, with or without a port, and a recorded confirmation outside a replay is no signature', () => {
    const signing = port();
    for (const result of [
      run(doc, {}, signing),
      run(doc, { confirmation: true }, signing),
      run(doc, { confirmation: { verified: true } }, signing),
      run(doc, { confirmation }, null),
      execute(doc, command, { [gate.idParam]: id }),
    ]) {
      expect(result.error?.code).toBe('SCN_HUMAN_GATE');
      expect(result.document).toBe(doc);
    }
    expect(signing.spentCount()).toBe(0);
    expect(status(accept(doc, { verified: true }))).not.toBe('accepted');
  });

  it('replay_history keeps the acceptance without spending again; a saved and reloaded document too', () => {
    const signing = port();
    const once = accept(doc, confirmation, signing);
    const replayed = execute(once, 'replay_history', {}, withPort(signing)).document;
    expect(status(replayed)).toBe('accepted');
    expect(replayed.scan?.acceptanceLedger).toEqual(once.scan?.acceptanceLedger);
    expect(signing.spentCount()).toBe(1);
    expect(status(execute(once, 'replay_history', {}, withPort(port())).document)).toBe('accepted');
    expect(status(execute(once, 'replay_history', {}, withPort(null)).document)).toBe('accepted');
    const reloaded = deserializeDocument(serializeDocument(signed));
    expect(status(execute(reloaded, 'replay_history', {}, withPort(null)).document)).toBe('accepted');
  });

  it('a forged, altered or planted ledger entry does not make a recorded step stick; so does a missing one', () => {
    const entry = signed.scan?.acceptanceLedger?.[0];
    const replayWith = (patch: Record<string, unknown>): unknown =>
      status(
        execute(
          { ...signed, scan: { ...signed.scan, acceptanceLedger: [{ ...entry, ...patch }] } } as CadDocument,
          'replay_history',
          {},
          withPort(port()),
        ).document,
      );
    expect(replayWith({})).toBe('accepted');
    expect(replayWith({ signature: signedFor('0'.repeat(64)) })).not.toBe('accepted');
    expect(replayWith({ signature: { ...confirmation, secret: 'forged' } })).not.toBe('accepted');
    expect(replayWith({ signature: 'raw' })).not.toBe('accepted');
    expect(replayWith({ signer: 'mallory' })).not.toBe('accepted');
    expect(replayWith({ payload: '1'.repeat(64) })).not.toBe('accepted');
    expect(replayWith({ targetId: 'someone-else' })).not.toBe('accepted');
    const { acceptanceLedger, ...scan } = signed.scan ?? { clouds: {}, cloudOrder: [], registrations: {}, extractions: {}, crops: {} };
    void acceptanceLedger;
    expect(status(execute({ ...signed, scan }, 'replay_history', {}, withPort(port())).document)).not.toBe('accepted');
  });

  it('a copy with another uid loses the acceptance on replay, and a signature for this document is refused in it', () => {
    const copy: CadDocument = { ...signed, uid: 'f'.repeat(32) };
    expect(status(execute(copy, 'replay_history', {}, withPort(port())).document)).not.toBe('accepted');
    expectBoundToDocument(
      doc,
      (document, given, ctx) => execute(document, command, { [gate.idParam]: id, confirmation: { ...given, secret: SECRET } }, ctx),
      'SCN_HUMAN_GATE',
      'n1',
      (replayed) => status(replayed) === 'accepted',
    );
  });

  it('load validation rejects a malformed ledger', () => {
    const load = (edit: (scan: Record<string, unknown>) => void): string => {
      const file = JSON.parse(serializeDocument(signed)) as { document: { scan: Record<string, unknown> } };
      edit(file.document.scan);
      return execute(createEmptyDocument(), 'load_document', { json: JSON.stringify(file) }).summary;
    };
    const ledger = (scan: Record<string, unknown>): Record<string, unknown>[] => scan['acceptanceLedger'] as Record<string, unknown>[];
    expect(load(() => undefined)).toMatch(/^Loaded document/);
    expect(load((scan) => (scan['acceptanceLedger'] = 'x'))).toMatch(/acceptanceLedger must be a list/);
    expect(load((scan) => (scan['acceptanceLedger'] = [3]))).toMatch(/acceptanceLedger\[0\] is malformed/);
    expect(load((scan) => (ledger(scan)[0]!['act'] = 'accept_anything'))).toMatch(/act must be/);
    expect(load((scan) => delete ledger(scan)[0]!['targetId'])).toMatch(/targetId must be text/);
    expect(load((scan) => (ledger(scan)[0]!['documentUid'] = 3))).toMatch(/documentUid must be text/);
    expect(load((scan) => (ledger(scan)[0]!['signature'] = 'raw'))).toMatch(/signature must be a signature object with a nonce/);
    expect(load((scan) => delete (ledger(scan)[0]!['signature'] as Record<string, unknown>)['nonce'])).toMatch(/with a nonce/);
  });
});
