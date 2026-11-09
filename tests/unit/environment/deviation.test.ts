import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { HumanSignaturePort } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { environmentPlugin } from '@cae/index';
import { spaceEnvironmentErrors } from '@cae/environment/model';
import { signingContext } from '../../helpers/signedPlantDoc';
import { run, withMaterial, withPanel, emptyMm } from './fixtures';

interface Item {
  key: string;
  material: string;
  quantity: string;
  status: string;
  fingerprint: string;
  deviation?: { decision: string; signer: string; signatureId: string };
  staleDeviation?: true;
  unconfirmedDeviation?: string;
}
interface Check {
  status: string;
  items: Item[];
  counts: { accepted: number };
  findings: { code: string; message: string }[];
}

const KEY = 'outgassing:syn_water|TML';

/** syn_water (TML 1.2 %) fails the NASA profile on TML; syn_low passes. */
function failing(): CadDocument {
  let doc = withMaterial(emptyMm(), 'syn_water', { TML: 1.2, CVCM: 0.02, WVR: 0.4 });
  doc = withPanel(doc, 'syn_water').document;
  doc = withPanel(withMaterial(doc, 'syn_low', { TML: 0.95, CVCM: 0.05, WVR: 0.3 }), 'syn_low').document;
  return doc;
}

const check = (doc: CadDocument, ctx = signingContext): Check =>
  execute(doc, 'check_space_environment', { profile: 'nasa_gsfc_screening' }, ctx).data as Check;

const approve = (doc: CadDocument, extra: Record<string, unknown> = {}, ctx = signingContext): ReturnType<typeof execute> =>
  execute(
    doc,
    'approve_environment_deviation',
    {
      itemKey: KEY,
      decision: 'accepted',
      justification: 'deviation DEV-17 approved by the contamination board',
      profile: 'nasa_gsfc_screening',
      ...extra,
    },
    ctx,
  );

describe('approve_environment_deviation: the human gate (FR-ENV-13, VC-ENV-14)', () => {
  it.each([
    ['no signing port (an agent)', { ...defaultContext(), humanSignature: null }, { confirmation: { nonce: 'n' } }],
    ['a port but no confirmation', signingContext, {}],
    ['a bare true from an agent', signingContext, { confirmation: true }],
    ['a signature without a nonce', signingContext, { confirmation: { signature: 'x' } }],
  ])('%s -> ENV_HUMAN_GATE and the document is unchanged', (_label, ctx, extra) => {
    const doc = failing();
    const result = approve(doc, extra, ctx);
    expect(result.error?.code).toBe('ENV_HUMAN_GATE');
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });

  it('a signature the port rejects is ENV_HUMAN_GATE and is not spent', () => {
    let spent = 0;
    const port: HumanSignaturePort = { verify: () => null, spend: () => (spent++, true) };
    const result = approve(failing(), { confirmation: { nonce: 'n' } }, { ...defaultContext(), humanSignature: port });
    expect(result.error?.code).toBe('ENV_HUMAN_GATE');
    expect(spent).toBe(0);
  });

  it('records the decision with signer, fingerprint and uid; the item keeps its status, the overall status ignores it', () => {
    const doc = failing();
    expect(check(doc).status).toBe('fail');
    const result = approve(doc, { confirmation: { nonce: 'n1' } });
    expect(result.error).toBeUndefined();
    expect(result.affected).toEqual([KEY]);
    expect(result.document.spaceEnvironment?.deviations?.[KEY]).toMatchObject({
      decision: 'accepted',
      signer: 'alice',
      signatureId: 'sig-1',
      documentUid: doc.uid,
    });
    const after = check(result.document);
    expect(after.items.find((item) => item.key === KEY)).toMatchObject({
      status: 'fail',
      deviation: { decision: 'accepted', signer: 'alice' },
    });
    expect(after.status).toBe('pass');
    expect(after.counts.accepted).toBe(1);
  });

  it('with the only failing limit accepted the overall status is pass', () => {
    const doc = failing();
    const items = check(doc).items.filter((item) => item.status === 'fail');
    expect(items.map((item) => item.key)).toEqual([KEY]);
    expect(check(approve(doc, { confirmation: { nonce: 'n1' } }).document).status).toBe('pass');
  });

  it('a rejected decision does not clear the item', () => {
    const rejected = approve(failing(), { confirmation: { nonce: 'n1' }, decision: 'rejected' });
    expect(rejected.error).toBeUndefined();
    expect(check(rejected.document)).toMatchObject({ status: 'fail', counts: { accepted: 0 } });
  });

  it('the signed payload binds the item, decision, justification, finding and document', () => {
    const doc = failing();
    const payloads: string[] = [];
    const recording: HumanSignaturePort = { verify: (_signature, payload) => (payloads.push(payload), null) };
    const ctx = { ...defaultContext(), humanSignature: recording };
    approve(doc, { confirmation: { nonce: 'n' } }, ctx);
    approve(doc, { confirmation: { nonce: 'n' }, decision: 'rejected' }, ctx);
    approve(doc, { confirmation: { nonce: 'n' }, justification: 'another reason' }, ctx);
    approve(doc, { confirmation: { nonce: 'm' } }, ctx);
    approve(
      run(doc, 'set_material_property', {
        material: 'syn_water',
        property: 'TML',
        value: 1.5,
        unit: '%',
        basis: 'company',
        source: { citation: 's' },
        replace: true,
        id: 'TML.company',
      }).document,
      { confirmation: { nonce: 'n' } },
      ctx,
    );
    expect(payloads.length).toBeGreaterThanOrEqual(4);
    expect(new Set(payloads).size).toBe(payloads.length);
    const strict: HumanSignaturePort = {
      verify: (_signature, payload) => (payload === payloads[0] ? { signer: 'bob', signatureId: 's9' } : null),
    };
    const strictCtx = { ...defaultContext(), humanSignature: strict };
    expect(approve(doc, { confirmation: { nonce: 'n' } }, strictCtx).document.spaceEnvironment?.deviations?.[KEY]?.signer).toBe('bob');
    expect(approve(doc, { confirmation: { nonce: 'n' }, justification: 'tampered' }, strictCtx).error?.code).toBe('ENV_HUMAN_GATE');
  });

  it('refuses an unknown key, a passing item, a blank justification, an unknown profile and a document without uid', () => {
    const doc = failing();
    const confirmation = { nonce: 'n' };
    expect(approve(doc, { confirmation, itemKey: 'outgassing:nothing|TML' }).error?.code).toBe('ENV_ITEM_NOT_FOUND');
    expect(approve(doc, { confirmation, itemKey: 'outgassing:syn_low|TML' }).error?.code).toBe('ENV_ITEM_NOT_ACCEPTABLE');
    expect(approve(doc, { confirmation, justification: '  ' }).error?.code).toBe('ENV_PARAM_INVALID');
    expect(approve(doc, { confirmation, profile: 'nasa' }).error?.code).toBe('ENV_PROFILE_UNKNOWN');
    expect(approve({ ...doc, uid: undefined } as never, { confirmation }).error?.code).toBe('ENV_DOCUMENT_UNIDENTIFIED');
    for (const refused of [approve(doc, { confirmation, itemKey: 'x' })]) expect(refused.document).toBe(doc);
  });

  it('a data-missing (unknown) item can be decided; the deviation then covers it', () => {
    let doc = withMaterial(emptyMm(), 'bare', { CVCM: 0.05 });
    doc = withPanel(doc, 'bare').document;
    const result = approve(doc, { confirmation: { nonce: 'n' }, itemKey: 'outgassing:bare|TML' });
    expect(result.error).toBeUndefined();
    expect(check(result.document).items.find((item) => item.key === 'outgassing:bare|TML')?.deviation?.decision).toBe('accepted');
  });

  it('survives a history replay (the recorded step carries no signature)', () => {
    const accepted = approve(failing(), { confirmation: { nonce: 'n1' } }).document;
    const replayed = execute(accepted, 'replay_history', {}, signingContext);
    expect(replayed.error).toBeUndefined();
    expect(replayed.document.spaceEnvironment?.deviations?.[KEY]).toMatchObject({ decision: 'accepted', signer: 'alice' });
  });

  it('a replay never invents a deviation: with the kept record gone the recorded step is refused', () => {
    const accepted = approve(failing(), { confirmation: { nonce: 'n1' } }).document;
    const stripped = { ...accepted, spaceEnvironment: { ...accepted.spaceEnvironment, deviations: {} } };
    const replayed = execute(stripped, 'replay_history', {}, signingContext);
    expect(replayed.document.spaceEnvironment?.deviations?.[KEY]).toBeUndefined();
  });

  it('a recorded confirmation outside a replay is no signature', () => {
    const doc = failing();
    expect(
      approve(doc, { confirmation: { verified: true } }, { ...signingContext, humanSignature: { verify: () => null } }).error?.code,
    ).toBe('ENV_HUMAN_GATE');
    expect(approve(doc, { confirmation: { verified: true } }, { ...defaultContext(), humanSignature: null }).error?.code).toBe(
      'ENV_HUMAN_GATE',
    );
  });
});

describe('stored deviations are re-verified, never trusted (a record in the slice proves nothing)', () => {
  /** A port that verifies only the signature minted for the genuine payload. */
  function strictFor(doc: CadDocument): { ctx: ReturnType<typeof defaultContext>; accepted: CadDocument } {
    const payloads: string[] = [];
    const recording = { ...defaultContext(), humanSignature: { verify: (_s: unknown, payload: string) => (payloads.push(payload), null) } };
    approve(doc, { confirmation: { nonce: 'n' } }, recording);
    const strict: HumanSignaturePort = {
      verify: (signature, payload) =>
        (signature as { sig?: string }).sig === 'genuine' && payload === payloads[0] ? { signer: 'alice', signatureId: 'sig-1' } : null,
    };
    const ctx = { ...defaultContext(), humanSignature: strict };
    return { ctx, accepted: approve(doc, { confirmation: { nonce: 'n', sig: 'genuine' } }, ctx).document };
  }

  const forge = (doc: CadDocument, signature: unknown): CadDocument => {
    const real = approve(doc, { confirmation: { nonce: 'n' } }).document;
    const entry = real.spaceEnvironment?.deviations?.[KEY];
    if (entry === undefined) throw new Error('fixture');
    return { ...real, spaceEnvironment: { ...real.spaceEnvironment, deviations: { [KEY]: { ...entry, signature } } } };
  };

  it('a genuine deviation counts with a port that verifies it', () => {
    const { ctx, accepted } = strictFor(failing());
    expect(check(accepted, ctx)).toMatchObject({ status: 'pass', counts: { accepted: 1 } });
    expect(check(accepted, ctx).items.find((item) => item.key === KEY)?.deviation?.decision).toBe('accepted');
  });

  it('a fabricated deviation (junk signature) does not clear the item: it stays in the status and is not counted', () => {
    const doc = failing();
    const { ctx } = strictFor(doc);
    const result = check(forge(doc, { nonce: 'n', sig: 'junk' }), ctx);
    expect(result.status).toBe('fail');
    expect(result.counts.accepted).toBe(0);
    const item = result.items.find((candidate) => candidate.key === KEY);
    expect(item).toMatchObject({ status: 'fail', unconfirmedDeviation: 'invalid' });
    expect(item?.deviation).toBeUndefined();
  });

  it('without a signing port a deviation cannot be confirmed and the item stays in the status', () => {
    const accepted = approve(failing(), { confirmation: { nonce: 'n' } }).document;
    const result = check(accepted, { ...defaultContext(), humanSignature: null });
    expect(result.status).toBe('fail');
    expect(result.items.find((item) => item.key === KEY)?.unconfirmedDeviation).toBe('noport');
    expect(result.counts.accepted).toBe(0);
  });

  it('a deviation copied into a document with another uid is foreign: still fail and not counted', () => {
    const { ctx, accepted } = strictFor(failing());
    const result = check({ ...accepted, uid: 'f'.repeat(32) }, ctx);
    expect(result.status).toBe('fail');
    expect(result.items.find((item) => item.key === KEY)?.unconfirmedDeviation).toBe('foreign');
    expect(result.counts.accepted).toBe(0);
  });

  it('a deviation without a recorded uid is unbound', () => {
    const real = approve(failing(), { confirmation: { nonce: 'n' } }).document;
    const entry = real.spaceEnvironment?.deviations?.[KEY];
    if (entry === undefined) throw new Error('fixture');
    const unbound = { ...real, spaceEnvironment: { ...real.spaceEnvironment, deviations: { [KEY]: { ...entry, documentUid: '' } } } };
    expect(check(unbound).items.find((item) => item.key === KEY)?.unconfirmedDeviation).toBe('unbound');
  });

  it('a deviation ends when the finding changes: the stale record is flagged and the item fails again', () => {
    const accepted = approve(failing(), { confirmation: { nonce: 'n' } }).document;
    const changed = run(accepted, 'set_material_property', {
      material: 'syn_water',
      property: 'TML',
      value: 1.6,
      unit: '%',
      basis: 'company',
      source: { citation: 'a new test report' },
      id: 'TML.company',
      replace: true,
    }).document;
    const result = check(changed);
    expect(result.status).toBe('fail');
    expect(result.items.find((item) => item.key === KEY)).toMatchObject({ staleDeviation: true });
    expect(result.counts.accepted).toBe(0);
  });

  it.each([
    ['null', null],
    ['a string', 'ok'],
    ['an array', [1, 2, 3]],
    ['an empty object', {}],
    ['a prototype-shaped object', { nonce: 'n', constructor: { prototype: {} } }],
    ['a huge nonce', { nonce: 'x'.repeat(100_000) }],
  ])('a hostile signature (%s) never improves a status: no port and strict port both keep fail', (_label, signature) => {
    const doc = failing();
    const { ctx } = strictFor(doc);
    const forged = forge(doc, signature);
    for (const context of [ctx, { ...defaultContext(), humanSignature: null }]) {
      const result = check(forged, context);
      expect(result.status).toBe('fail');
      expect(result.counts.accepted).toBe(0);
    }
  });

  it('a port that throws on a hostile signature has not confirmed it', () => {
    const doc = failing();
    const throwing: HumanSignaturePort = {
      verify: () => {
        throw new Error('hostile');
      },
    };
    const result = check(forge(doc, { nonce: 'n' }), { ...defaultContext(), humanSignature: throwing });
    expect(result.status).toBe('fail');
    expect(result.items.find((item) => item.key === KEY)?.unconfirmedDeviation).toBe('invalid');
  });
});

describe('deviations slice validation and the corrosion service-environment warning', () => {
  const rawWith = (deviations: unknown): Record<string, unknown> => ({ spaceEnvironment: { deviations } });
  const entry = {
    itemKey: KEY,
    decision: 'accepted',
    justification: 'j',
    fingerprint: 'a'.repeat(64),
    signer: 's',
    signatureId: 'i',
    signature: { nonce: 'n' },
    documentUid: 'u',
  };

  it('accepts a well-formed deviation and refuses a key mismatch, a bad fingerprint and a reserved key', () => {
    expect(spaceEnvironmentErrors(rawWith({ [KEY]: entry }))).toEqual([]);
    expect(spaceEnvironmentErrors(rawWith({ other: entry })).join(' ')).toContain('must equal its key');
    expect(spaceEnvironmentErrors(rawWith({ [KEY]: { ...entry, fingerprint: 'zz' } })).length).toBeGreaterThan(0);
    expect(spaceEnvironmentErrors(rawWith({ [KEY]: { ...entry, decision: 'maybe' } })).length).toBeGreaterThan(0);
    expect(spaceEnvironmentErrors(rawWith({ constructor: { ...entry, itemKey: 'constructor' } })).length).toBeGreaterThan(0);
    expect(spaceEnvironmentErrors(rawWith({ [KEY]: { ...entry, extra: 1 } })).length).toBeGreaterThan(0);
  });

  it('the plugin registers the sixth command', () => {
    expect(environmentPlugin.commands.map((command) => command.name)).toContain('approve_environment_deviation');
  });

  const withExposure = (rh: number): CadDocument =>
    run(failing(), 'set_mission_environment', {
      humidityExposure: {
        relativeHumidity: rh,
        temperature: { value: 20, unit: 'degC' },
        duration: { value: 7, unit: 'd' },
        faces: 'both',
        source: 'storage specification',
      },
    }).document;
  const withService = (doc: CadDocument, environment: string, scheme = 'anodic_index'): CadDocument =>
    run(doc, 'set_service_environment', { scheme, environment }).document;
  const codes = (doc: CadDocument): string[] => check(doc).findings.map((finding) => finding.code);

  it('warns ENV_SERVICE_ENVIRONMENT_MISMATCH when the corrosion environment and the humidity exposure disagree', () => {
    expect(codes(withService(withExposure(85), 'controlled'))).toContain('ENV_SERVICE_ENVIRONMENT_MISMATCH');
    expect(codes(withService(withExposure(30), 'harsh'))).toContain('ENV_SERVICE_ENVIRONMENT_MISMATCH');
    expect(codes(withService(withExposure(30), 'artificial_seawater', 'mil_std_889d'))).toContain('ENV_SERVICE_ENVIRONMENT_MISMATCH');
    const message = check(withService(withExposure(85), 'controlled')).findings.find(
      (f) => f.code === 'ENV_SERVICE_ENVIRONMENT_MISMATCH',
    )?.message;
    expect(message).toContain('85 % RH');
  });

  it('is silent when they agree, with a normal environment, without an exposure or without a corrosion environment', () => {
    expect(codes(withService(withExposure(30), 'controlled'))).not.toContain('ENV_SERVICE_ENVIRONMENT_MISMATCH');
    expect(codes(withService(withExposure(85), 'harsh'))).not.toContain('ENV_SERVICE_ENVIRONMENT_MISMATCH');
    expect(codes(withService(withExposure(85), 'normal'))).not.toContain('ENV_SERVICE_ENVIRONMENT_MISMATCH');
    expect(codes(withService(failing(), 'controlled'))).not.toContain('ENV_SERVICE_ENVIRONMENT_MISMATCH');
    expect(codes(withExposure(85))).not.toContain('ENV_SERVICE_ENVIRONMENT_MISMATCH');
  });
});
