/** Plant 01 PSC M3: `add_pipe_run` with a spec (VC-PSC-15), `assign_pipe_spec`, the `approve_pipe_spec` human gate (VC-PSC-16), consumers of `spec.wallMm`. */

import { describe, expect, it, vi } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { HumanSignaturePort } from '@core/model/analysis';
import { humanGatePayload } from '@core/model/humanGate';
import { withDocumentUid } from '@core/model/documentUid';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { sha256Hex } from '@lib/sha256';
import { pipeWallMm, pipeWeightPerMetre } from '@aec/industrial/piping/pipeWeight';
import { elementsOf, getBuilding } from '@aec/building/model';
import type { PipeElement } from '@aec/building/types';
import { canonicalSpecText } from '@aec/plant/spec/file';
import { latestSpec } from '@aec/plant/spec/store';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { expectBoundToDocument } from '../../../helpers/documentBinding';
import { importedDoc, mixSpec, smallSpec, type Json } from './specFixture';

const AT = '2026-11-02T09:30:00Z';
const base = (): CadDocument => apply(importedDoc(), 'add_level', { name: 'Grade', elevation: 0 });
const ROUTE = [
  [0, 0, 3000],
  [6000, 0, 3000],
  [6000, 4000, 3000],
];
const LEGACY = [
  [0, 2000, 3000],
  [6000, 2000, 3000],
];
const pipeOf = (doc: CadDocument, id: string): PipeElement | undefined =>
  elementsOf(getBuilding(doc), 'pipe').find((pipe) => pipe.id === id);
const mm = (doc: CadDocument, id: string): number =>
  (pipeOf(doc, id)?.diameter ?? 0) * (doc.units === 'm' ? 1000 : doc.units === 'cm' ? 10 : 1);

/** A port whose signatures are `{ payload, nonce }` and verify only for that exact payload; `spend` refuses a second use. */
function portFor(): HumanSignaturePort & { verify: ReturnType<typeof vi.fn>; spend: ReturnType<typeof vi.fn> } {
  const spent = new Set<string>();
  const verify = vi.fn((signature: unknown, payload: string) =>
    (signature as { payload?: string }).payload === payload ? { signer: 'alice', signatureId: `sig-${payload.slice(0, 6)}` } : null,
  );
  const spend = vi.fn((signature: unknown) => !spent.has(JSON.stringify(signature)) && (spent.add(JSON.stringify(signature)), true));
  return { verify, spend };
}
const ctxWith = (humanSignature: HumanSignaturePort | null): ExecutionContext => ({ ...defaultContext(), humanSignature });

/** The signature a human would produce for approving `specId` revision as it is in `doc`. */
function signApproval(doc: CadDocument, specId: string, nonce = 'n1'): { payload: string; nonce: string } {
  const spec = latestSpec(doc, specId);
  if (spec === undefined) throw new Error('no spec');
  const contentSha256 = sha256Hex(canonicalSpecText(spec));
  const details = withDocumentUid({ revision: spec.revision, contentSha256 }, doc);
  return { payload: humanGatePayload('plant:approve_pipe_spec', [specId], details, nonce), nonce };
}

const approve = (doc: CadDocument, specId = 'CS150-A1'): CadDocument =>
  execute(doc, 'approve_pipe_spec', { specId, confirmation: signApproval(doc, specId), at: AT }, ctxWith(portFor())).document;

describe('add_pipe_run with a spec (VC-PSC-15)', () => {
  const routed = execute(base(), 'add_pipe_run', { points: ROUTE, spec: 'CS150-A1', nps: 2.5, line: 'P-1001', service: 'naphtha' });
  const legacy = execute(routed.document, 'add_pipe_run', { points: LEGACY, dn: 65, line: 'U-2001' });

  it('takes OD, wall and schedule from the spec pipe (73.0 mm Sch 40), stores the binding and reports them in data', () => {
    expect(routed.error).toBeUndefined();
    const id = routed.affected[0] as string;
    expect(routed.data).toMatchObject({
      specId: 'CS150-A1',
      revision: 1,
      nps: '2-1/2',
      schedule: '40',
      outsideDiameterMm: 73,
      wallMm: 5.16,
      verified: true,
    });
    expect(mm(routed.document, id)).toBeCloseTo(73, 6);
    expect(pipeOf(routed.document, id)).toMatchObject({
      dn: 65,
      spec: { specId: 'CS150-A1', revision: 1, nps: '2-1/2', schedule: '40', odMm: 73, wallMm: 5.16, dimensionalStandard: 'ASME' },
    });
    expect(routed.summary).toContain('PSC_SPEC_NOT_APPROVED');
  });

  it('keeps the legacy dn: 65 pipe on the EN 10220 table (76.1 mm) without a binding', () => {
    const id = legacy.affected[0] as string;
    expect(mm(legacy.document, id)).toBeCloseTo(76.1, 6);
    expect(pipeOf(legacy.document, id)?.spec).toBeUndefined();
  });

  it('feeds pipe_section_properties the spec wall (8.633 kg/m) and the document check flags only the legacy pipe', () => {
    const id = routed.affected[0] as string;
    expect(data<{ wallMm: number; massKgPerM?: number }>(legacy.document, 'pipe_section_properties', { pipeId: id })).toMatchObject({
      wallMm: 5.16,
    });
    const checked = data<{ issues: Array<{ code: string; ids: string[] }> }>(legacy.document, 'check_pipe_spec', {
      specId: 'CS150-A1',
      scope: 'document',
    });
    expect(checked.issues.find((issue) => issue.code === 'PSC_PIPE_NO_SPEC')?.ids).toEqual([legacy.affected[0]]);
    expect(checked.issues.some((issue) => issue.code === 'PSC_PIPE_SPEC_MISMATCH')).toBe(false);
  });

  it('uses the newest approved revision once the spec is approved (no draft warning)', () => {
    const approved = approve(base());
    const result = execute(approved, 'add_pipe_run', { points: ROUTE, spec: 'CS150-A1', dn: 65 });
    expect(result.data).toMatchObject({ revision: 1, outsideDiameterMm: 73 });
    expect(result.summary).not.toContain('PSC_SPEC_NOT_APPROVED');
  });

  it('refuses with PSC codes: no size, unknown spec, size outside the spec, a diameter that contradicts the spec, nps without spec', () => {
    expectRefusal(base(), 'add_pipe_run', { points: ROUTE, spec: 'CS150-A1' }, 'PSC_SIZE_UNKNOWN');
    expectRefusal(base(), 'add_pipe_run', { points: ROUTE, spec: 'NOPE', nps: 2 }, 'PSC_SPEC_UNKNOWN');
    expectRefusal(base(), 'add_pipe_run', { points: ROUTE, spec: 'CS150-A1', nps: 30 }, 'PSC_SIZE_OUT_OF_RANGE');
    expectRefusal(base(), 'add_pipe_run', { points: ROUTE, spec: 'CS150-A1', nps: 2.5, diameter: 76.1 }, 'PSC_PIPE_SPEC_MISMATCH');
    const bare = execute(base(), 'add_pipe_run', { points: ROUTE, nps: 2.5 });
    expect(bare.affected).toEqual([]);
    expect(bare.summary).toContain('nps needs spec');
    const both = execute(base(), 'add_pipe_run', { points: ROUTE, spec: 'CS150-A1', nps: 2.5, dn: 65 });
    expect(both.affected).toEqual([]);
  });

  it('accepts a diameter equal to the spec OD, and is pure', () => {
    const doc = base();
    const result = execute(doc, 'add_pipe_run', { points: ROUTE, spec: 'CS150-A1', nps: 2.5, diameter: 73 });
    expect(result.data).toMatchObject({ outsideDiameterMm: 73 });
    expectPure(doc, () => execute(doc, 'add_pipe_run', { points: ROUTE, spec: 'CS150-A1', nps: 2.5 }));
  });
});

describe('approve_pipe_spec human gate (VC-PSC-16)', () => {
  const doc = base();
  const params = { specId: 'CS150-A1', at: AT };

  it('a signature made for one document does not verify in a copy of it (GATE-UID)', () => {
    expectBoundToDocument(
      doc,
      (document, confirmation, ctx) => execute(document, 'approve_pipe_spec', { ...params, confirmation }, ctx),
      'PSC_HUMAN_GATE',
    );
  });

  it('an agent (no confirmation, true, no port, a signature that does not verify, no nonce) gets PSC_HUMAN_GATE and the spec stays draft', () => {
    for (const [confirmation, ctx] of [
      [undefined, ctxWith(portFor())],
      [true, ctxWith(portFor())],
      [signApproval(doc, 'CS150-A1'), ctxWith(null)],
      [{ payload: 'wrong', nonce: 'n' }, ctxWith(portFor())],
      [{ payload: signApproval(doc, 'CS150-A1').payload }, ctxWith(portFor())],
    ] as const) {
      const result = execute(doc, 'approve_pipe_spec', { ...params, confirmation }, ctx);
      expect(result.error?.code, result.summary).toBe('PSC_HUMAN_GATE');
      expect(result.document).toBe(doc);
      expect(latestSpec(result.document, 'CS150-A1')?.status).toBe('draft');
    }
  });

  it('a verified signature approves: status, approval block, summary and data; check no longer warns PSC_SPEC_NOT_APPROVED', () => {
    const result = execute(doc, 'approve_pipe_spec', { ...params, confirmation: signApproval(doc, 'CS150-A1') }, ctxWith(portFor()));
    expect(result.error).toBeUndefined();
    expect(latestSpec(result.document, 'CS150-A1')).toMatchObject({ status: 'approved', approval: { signer: 'alice', at: AT } });
    expect(result.data).toMatchObject({
      specId: 'CS150-A1',
      revision: 1,
      status: 'approved',
      signer: 'alice',
      superseded: [],
      stalePipes: [],
    });
    const checked = data<{ issues: Array<{ code: string }> }>(result.document, 'check_pipe_spec', { specId: 'CS150-A1' });
    expect(checked.issues.map((issue) => issue.code)).not.toContain('PSC_SPEC_NOT_APPROVED');
    const again = execute(result.document, 'approve_pipe_spec', { ...params, confirmation: true }, ctxWith(portFor()));
    expect(again.data).toMatchObject({ unchanged: true });
  });

  it('the signature is bound to the content: a spec edited after signing no longer verifies', () => {
    const signature = signApproval(doc, 'CS150-A1');
    const edited = apply(doc, 'edit_pipe_spec', {
      specId: 'CS150-A1',
      ops: [{ op: 'setHeader', fields: { title: 'edited after signing' } }],
    });
    expectRefusalWith(edited, { ...params, confirmation: signature }, 'PSC_HUMAN_GATE');
  });

  it('a signature is spent once: the same signature on the same unchanged draft is refused the second time', () => {
    const port = portFor();
    const signature = signApproval(doc, 'CS150-A1');
    const first = execute(doc, 'approve_pipe_spec', { ...params, confirmation: signature }, ctxWith(port));
    expect(first.error).toBeUndefined();
    const second = execute(doc, 'approve_pipe_spec', { ...params, confirmation: signature }, ctxWith(port));
    expect(second.error?.code, second.summary).toBe('PSC_HUMAN_GATE');
    expect(second.document).toBe(doc);
    expect(port.verify).toHaveBeenCalledTimes(2);
    expect(port.spend).toHaveBeenCalledTimes(2);
  });

  it('a spec with fail findings is refused PSC_SPEC_CHECK_FAILED before any signature is verified or spent', () => {
    const failing = apply(importedDoc(smallSpec({ catalogs: ['no-such-catalogue'] }) as Json), 'edit_pipe_spec', {
      specId: 'SMALL',
      ops: [{ op: 'setHeader', fields: { title: 't' } }],
    });
    const port = portFor();
    const result = execute(
      failing,
      'approve_pipe_spec',
      { specId: 'SMALL', at: AT, confirmation: signApproval(failing, 'SMALL') },
      ctxWith(port),
    );
    expect(result.error?.code).toBe('PSC_SPEC_CHECK_FAILED');
    expect(port.verify).not.toHaveBeenCalled();
  });

  it('refuses an unknown spec or revision, and a superseded revision; is pure', () => {
    expectRefusal(doc, 'approve_pipe_spec', { ...params, specId: 'NOPE' }, 'PSC_SPEC_UNKNOWN');
    expectRefusal(doc, 'approve_pipe_spec', { ...params, revision: 7 }, 'PSC_SPEC_UNKNOWN');
    const r1 = approve(doc);
    const r2 = apply(r1, 'edit_pipe_spec', { specId: 'CS150-A1', ops: [{ op: 'setHeader', fields: { title: 'rev 2' } }] });
    const both = approve(r2);
    expect(getRevisions(both)).toEqual([
      ['1', 'superseded'],
      ['2', 'approved'],
    ]);
    expectRefusal(both, 'approve_pipe_spec', { ...params, revision: 1 }, 'PSC_SPEC_INVALID');
    expectPure(doc, () =>
      execute(doc, 'approve_pipe_spec', { ...params, confirmation: signApproval(doc, 'CS150-A1') }, ctxWith(portFor())),
    );
  });

  it('rejects params without a UTC time stamp', () => {
    const result = execute(doc, 'approve_pipe_spec', { specId: 'CS150-A1', at: 'yesterday' });
    expect(result.summary).toContain('invalid params');
  });
});

function expectRefusalWith(doc: CadDocument, params: Record<string, unknown>, code: string): void {
  const result = execute(doc, 'approve_pipe_spec', params, ctxWith(portFor()));
  expect(result.error?.code, result.summary).toBe(code);
  expect(result.document).toBe(doc);
}
const getRevisions = (doc: CadDocument): string[][] =>
  (doc.plant?.spec?.specs['CS150-A1'] ?? []).map((spec) => [String(spec.revision), spec.status]);

describe('assign_pipe_spec and the revision sweep', () => {
  const legacy = execute(base(), 'add_pipe_run', { points: ROUTE, dn: 65, line: 'P-1001' });
  const id = legacy.affected[0] as string;

  it('migrates a legacy pipe: OD 76.1 -> 73.0, binding stored, the OD mismatch cleared', () => {
    const forced = withBinding(legacy.document, id, 76.1);
    expect(codesOf(forced)).toContain('PSC_PIPE_SPEC_MISMATCH');
    const result = execute(legacy.document, 'assign_pipe_spec', { pipeId: id, specId: 'CS150-A1' });
    expect(result.error, result.summary).toBeUndefined();
    expect(result.affected).toContain(id);
    expect(result.data).toMatchObject({
      specId: 'CS150-A1',
      pipes: [{ pipeId: id, nps: '2-1/2', schedule: '40', outsideDiameterMm: 73, wallMm: 5.16 }],
      warnings: [{ code: 'PSC_SPEC_NOT_APPROVED' }],
    });
    expect(mm(result.document, id)).toBeCloseTo(73, 6);
    expect(pipeOf(result.document, id)).toMatchObject({ dn: 65, spec: { odMm: 73, wallMm: 5.16 } });
    expect(codesOf(result.document)).not.toContain('PSC_PIPE_SPEC_MISMATCH');
    expect(codesOf(result.document)).not.toContain('PSC_PIPE_NO_SPEC');
  });

  it('selects by line number, takes nps / dn, and a schedule that agrees with the spec', () => {
    const second = execute(legacy.document, 'add_pipe_run', { points: LEGACY, dn: 100, line: 'P-1001' });
    const result = execute(second.document, 'assign_pipe_spec', { line: 'P-1001', specId: 'CS150-A1', nps: 4, schedule: '40' });
    expect(result.data).toMatchObject({ pipes: [{ nps: '4', schedule: '40' }, { nps: '4' }] });
    expect(elementsOf(getBuilding(result.document), 'pipe').map((pipe) => pipe.spec?.nps)).toEqual(['4', '4']);
    const byDn = execute(legacy.document, 'assign_pipe_spec', { pipeId: id, specId: 'CS150-A1', dn: 100 });
    expect(byDn.data).toMatchObject({ pipes: [{ nps: '4', outsideDiameterMm: 114.3 }] });
  });

  it('the sweep: approving revision 2 makes bound pipes stale, assign_pipe_spec without a size moves them', () => {
    const assigned = execute(approve(legacy.document), 'assign_pipe_spec', { pipeId: id, specId: 'CS150-A1' }).document;
    const r2 = apply(assigned, 'edit_pipe_spec', { specId: 'CS150-A1', ops: [{ op: 'setHeader', fields: { title: 'rev 2' } }] });
    const signature = signApproval(r2, 'CS150-A1');
    const approved = execute(r2, 'approve_pipe_spec', { specId: 'CS150-A1', confirmation: signature, at: AT }, ctxWith(portFor()));
    expect(approved.data).toMatchObject({ revision: 2, superseded: [1], stalePipes: [id] });
    expect(codesOf(approved.document)).toContain('PSC_SPEC_REVISION_STALE');
    const swept = execute(approved.document, 'assign_pipe_spec', { pipeId: id, specId: 'CS150-A1' });
    expect(pipeOf(swept.document, id)?.spec?.revision).toBe(2);
    expect(codesOf(swept.document)).not.toContain('PSC_SPEC_REVISION_STALE');
    expect(swept.data).not.toHaveProperty('warnings');
  });

  it('keeps the current size when none is given, and the binding survives save and load', () => {
    const assigned = execute(legacy.document, 'assign_pipe_spec', { pipeId: id, specId: 'CS150-A1', nps: 3 }).document;
    const again = execute(assigned, 'assign_pipe_spec', { pipeId: id, specId: 'CS150-A1' });
    expect(pipeOf(again.document, id)?.spec?.nps).toBe('3');
    const loaded = deserializeDocument(serializeDocument(approve(again.document)));
    expect(pipeOf(loaded, id)?.spec).toMatchObject({ specId: 'CS150-A1', nps: '3' });
    expect(latestSpec(loaded, 'CS150-A1')?.status).toBe('approved');
  });

  it('refuses coded and changes nothing: pipe selection, size, spec, schedule; a bad pipe in a line stops the whole line', () => {
    const doc = legacy.document;
    expectRefusal(doc, 'assign_pipe_spec', { specId: 'CS150-A1', nps: 2 }, 'PSC_PIPE_UNKNOWN');
    expectRefusal(doc, 'assign_pipe_spec', { pipeId: id, line: 'P-1001', specId: 'CS150-A1' }, 'PSC_PIPE_UNKNOWN');
    expectRefusal(doc, 'assign_pipe_spec', { pipeId: 'pipe-99', specId: 'CS150-A1' }, 'PSC_PIPE_UNKNOWN');
    expectRefusal(doc, 'assign_pipe_spec', { line: 'NOPE', specId: 'CS150-A1' }, 'PSC_PIPE_UNKNOWN');
    expectRefusal(doc, 'assign_pipe_spec', { pipeId: id, specId: 'NOPE' }, 'PSC_SPEC_UNKNOWN');
    expectRefusal(doc, 'assign_pipe_spec', { pipeId: id, specId: 'CS150-A1', nps: 2, dn: 50 }, 'PSC_SIZE_UNKNOWN');
    expectRefusal(doc, 'assign_pipe_spec', { pipeId: id, specId: 'CS150-A1', nps: 40 }, 'PSC_SIZE_OUT_OF_RANGE');
    expectRefusal(doc, 'assign_pipe_spec', { pipeId: id, specId: 'CS150-A1', nps: 2, schedule: '80' }, 'PSC_SCHEDULE_UNKNOWN');
    const noSize = execute(doc, 'add_pipe_run', { points: LEGACY, diameter: 90, line: 'X-1' });
    expectRefusal(noSize.document, 'assign_pipe_spec', { pipeId: noSize.affected[0], specId: 'CS150-A1' }, 'PSC_SIZE_UNKNOWN');
    const mixed = execute(doc, 'add_pipe_run', { points: LEGACY, dn: 700, diameter: 711, line: 'P-1001' });
    const refused = expectRefusal(mixed.document, 'assign_pipe_spec', { line: 'P-1001', specId: 'CS150-A1' }, 'PSC_SIZE_OUT_OF_RANGE');
    expect(refused.document).toBe(mixed.document);
  });

  it('is pure, and a bound pipe protects its spec component (PSC_SPEC_IN_USE)', () => {
    expectPure(legacy.document, () => execute(legacy.document, 'assign_pipe_spec', { pipeId: id, specId: 'CS150-A1' }));
    const assigned = execute(legacy.document, 'assign_pipe_spec', { pipeId: id, specId: 'CS150-A1' }).document;
    expectRefusal(assigned, 'edit_pipe_spec', { specId: 'CS150-A1', ops: [{ op: 'removeComponent', id: 'P-BW' }] }, 'PSC_SPEC_IN_USE');
  });
});

function withBinding(doc: CadDocument, id: string, odMm: number): CadDocument {
  const pipe = pipeOf(doc, id);
  if (pipe === undefined) throw new Error('no pipe');
  const spec = { specId: 'CS150-A1', revision: 1, nps: '2-1/2', odMm, wallMm: 5.16, dimensionalStandard: 'ASME', verified: true };
  return {
    ...doc,
    building: { ...getBuilding(doc), elements: { ...getBuilding(doc).elements, [id]: { ...pipe, spec } } },
  } as unknown as CadDocument;
}
function codesOf(doc: CadDocument): string[] {
  return data<{ issues: Array<{ code: string }> }>(doc, 'check_pipe_spec', { specId: 'CS150-A1', scope: 'document' }).issues.map(
    (issue) => issue.code,
  );
}

describe('consumers read spec.wallMm', () => {
  const routed = execute(base(), 'add_pipe_run', { points: ROUTE, spec: 'CS150-A1', nps: 1 });
  const legacy = execute(routed.document, 'add_pipe_run', { points: LEGACY, diameter: 33.4 });
  const [specId, legacyId] = [routed.affected[0] as string, legacy.affected[0] as string];

  it('pipe_hydraulics uses the spec wall (Sch 80 NPS 1: 4.55 mm) where the legacy table gives another wall for the same OD', () => {
    const flow = { flowM3h: 10 };
    const bound = data<{ diameter: { wallMm: number; insideMm: number; wallBasis: string } }>(legacy.document, 'pipe_hydraulics', {
      pipeId: specId,
      ...flow,
    });
    const table = data<{ diameter: { wallMm: number; insideMm: number; wallBasis: string } }>(legacy.document, 'pipe_hydraulics', {
      pipeId: legacyId,
      ...flow,
    });
    expect(bound.diameter).toMatchObject({ wallMm: 4.55, wallBasis: 'pipe spec' });
    expect(bound.diameter.insideMm).toBeCloseTo(33.4 - 2 * 4.55, 2);
    expect(table.diameter.wallBasis).toBe('legacy wall table');
    expect(table.diameter.wallMm).not.toBe(4.55);
  });

  it('pipeWallMm and pipeWeightPerMetre take the binding wall over the table wall', () => {
    const element = pipeOf(routed.document, specId);
    if (element === undefined) throw new Error('no pipe');
    expect(pipeWallMm(element, 33.4)).toBe(4.55);
    expect(pipeWallMm({}, 33.4)).not.toBe(4.55);
    expect(pipeWeightPerMetre(33.4, 1000, 4.55)).toBeGreaterThan(pipeWeightPerMetre(33.4, 1000));
    expect(pipeWeightPerMetre(33.4, 1000)).toBe(pipeWeightPerMetre(33.4, 1000, pipeWallMm({}, 33.4)));
  });
});

describe('riser weight reads the spec wall', () => {
  const RISER = [
    [0, 0, 0],
    [0, 0, 4000],
    [3000, 0, 4000],
  ];
  const weight = (doc: CadDocument, index: number): number =>
    data<{ pipes: Array<{ risers: Array<{ weightKn: number }> }> }>(doc, 'check_pipe_supports', {}).pipes[index]?.risers[0]?.weightKn ?? 0;

  it('a Sch 80 NPS 1 riser weighs more than the legacy-table riser of the same OD', () => {
    const bound = execute(base(), 'add_pipe_run', { points: RISER, spec: 'CS150-A1', nps: 1 });
    const both = execute(bound.document, 'add_pipe_run', {
      points: RISER.map(([x, y, z]) => [x as number, 5000 + (y as number), z as number]),
      diameter: 33.4,
    });
    expect(weight(both.document, 0)).toBeGreaterThan(weight(both.document, 1));
  });
});

describe('a spec pipe without a wall', () => {
  it('is refused PSC_CATALOG_ROW_MISSING: a pipe is never bound without OD and wall', () => {
    const spec = mixSpec();
    (spec['components'] as Array<Record<string, unknown>>)[0] = {
      id: 'P',
      type: 'pipe',
      fromDn: 50,
      toDn: 100,
      standard: 'EN 10220',
      catalogRef: 'en-10220',
    };
    const bare = apply(apply(createEmptyDocument(), 'add_level', { name: 'Grade', elevation: 0 }), 'import_pipe_spec', { spec });
    expectRefusal(bare, 'add_pipe_run', { points: ROUTE, spec: 'MIX-1', dn: 50 }, 'PSC_CATALOG_ROW_MISSING');
  });
});

describe('replay and regeneration keep an approval', () => {
  const approvedThenEdited = (): CadDocument => {
    const routed = execute(base(), 'add_pipe_run', { points: ROUTE, dn: 65, line: 'P-1' });
    const approved = approve(routed.document);
    const assigned = execute(approved, 'assign_pipe_spec', { pipeId: routed.affected[0], specId: 'CS150-A1' }).document;
    const edited = apply(assigned, 'edit_pipe_spec', { specId: 'CS150-A1', ops: [{ op: 'setHeader', fields: { title: 'rev 2' } }] });
    return execute(edited, 'assign_pipe_spec', { pipeId: routed.affected[0], specId: 'CS150-A1' }).document;
  };
  const statuses = (doc: CadDocument): string[][] => getRevisions(doc);

  it('the history records confirmation { verified: true } and the step is a no-signature replay of the same approval', () => {
    const doc = approvedThenEdited();
    expect(doc.featureHistory.find((step) => step.name === 'approve_pipe_spec')?.params).toMatchObject({
      confirmation: { verified: true },
    });
    expect(statuses(doc)).toEqual([
      ['1', 'approved'],
      ['2', 'draft'],
    ]);
    const replayed = execute(doc, 'replay_history', {}).document;
    expect(statuses(replayed)).toEqual(statuses(doc));
    expect(latestSpec(replayed, 'CS150-A1')?.revision).toBe(2);
    expect(replayed.plant?.spec?.specs['CS150-A1']?.[0]?.approval).toEqual(doc.plant?.spec?.specs['CS150-A1']?.[0]?.approval);
    // the assign after the edit bound the newest approved revision (1), not the draft: replay keeps that
    const bound = elementsOf(getBuilding(replayed), 'pipe')[0]?.spec;
    expect(bound?.revision).toBe(1);
    expect(bound).toEqual(elementsOf(getBuilding(doc), 'pipe')[0]?.spec);
  });

  it('a recorded confirmation never approves content no human approved (a forged { verified: true } is refused)', () => {
    const fresh = base();
    const forged = execute(
      fresh,
      'approve_pipe_spec',
      { specId: 'CS150-A1', at: AT, confirmation: { verified: true } },
      ctxWith(portFor()),
    );
    expect(forged.error?.code).toBe('PSC_HUMAN_GATE');
    const approved = approve(fresh);
    const changed = apply(approved, 'edit_pipe_spec', { specId: 'CS150-A1', ops: [{ op: 'setHeader', fields: { title: 'new content' } }] });
    const again = execute(
      changed,
      'approve_pipe_spec',
      { specId: 'CS150-A1', at: AT, confirmation: { verified: true } },
      ctxWith(portFor()),
    );
    expect(again.error?.code).toBe('PSC_HUMAN_GATE');
  });

  it('the approval ledger is saved and loaded, and a malformed ledger is rejected on load', () => {
    const doc = approve(base());
    expect(deserializeDocument(serializeDocument(doc)).plant?.spec?.approvals).toEqual(doc.plant?.spec?.approvals);
    const broken = JSON.parse(serializeDocument(doc)) as { document: { plant: { spec: { approvals: unknown } } } };
    broken.document.plant.spec.approvals = [{ specId: 'CS150-A1' }];
    expect(() => deserializeDocument(JSON.stringify(broken))).toThrow();
  });
});

describe('a DN with no NPS pairing', () => {
  it('binds in the DN system and the sweep (no size) re-reads it as a DN', () => {
    const catalog = {
      format: 'llull-piping-catalog',
      schemaVersion: 1,
      id: 'user-pipes',
      licence: 'company-proprietary',
      families: [
        {
          id: 'p',
          type: 'pipe',
          standard: 'EN 10220',
          unit: 'mm',
          sizes: [{ dn: 175, outsideDiameter: 190, wall: 5, schedule: 'S', provenance: { citation: 'company table' } }],
        },
      ],
    };
    const spec = {
      format: 'llull-pipe-spec',
      schemaVersion: 1,
      id: 'CO-1',
      dimensionalStandard: 'company',
      rating: { system: 'EN 1092-1', pn: 16 },
      corrosionAllowance: { value: 1, unit: 'mm' },
      sizeRange: { fromDn: 150, toDn: 200 },
      catalogs: ['user-pipes'],
      components: [{ id: 'P', type: 'pipe', fromDn: 150, toDn: 200, catalogRef: 'p', schedule: 'S' }],
    };
    let doc = apply(createEmptyDocument(), 'add_level', { name: 'Grade', elevation: 0 });
    doc = apply(apply(doc, 'import_piping_catalog', { catalog }), 'import_pipe_spec', { spec });
    const routed = execute(doc, 'add_pipe_run', { points: ROUTE, spec: 'CO-1', dn: 175 });
    expect(routed.error, routed.summary).toBeUndefined();
    const id = routed.affected[0] as string;
    expect(pipeOf(routed.document, id)?.spec).toMatchObject({ nps: '175', sizeSystem: 'DN', odMm: 190 });
    expect(pipeOf(routed.document, id)?.dn).toBe(175);
    const swept = execute(routed.document, 'assign_pipe_spec', { pipeId: id, specId: 'CO-1' });
    expect(swept.error, swept.summary).toBeUndefined();
    expect(pipeOf(swept.document, id)?.spec).toMatchObject({ nps: '175', sizeSystem: 'DN', odMm: 190 });
    expect(
      data<{ issues: Array<{ code: string }> }>(swept.document, 'check_pipe_spec', { specId: 'CO-1', scope: 'document' }).issues.map(
        (issue) => issue.code,
      ),
    ).not.toContain('PSC_PIPE_SPEC_MISMATCH');
  });
});

describe('add_pipe_run spec parameter combinations', () => {
  it('names the problem: nps and dn together, a diameter that contradicts the spec, nps without a spec', () => {
    const both = execute(base(), 'add_pipe_run', { points: ROUTE, spec: 'CS150-A1', nps: 2.5, dn: 65 });
    expect(both.summary).toContain('nps or dn with spec, not both');
    const wrong = expectRefusal(
      base(),
      'add_pipe_run',
      { points: ROUTE, spec: 'CS150-A1', nps: 2.5, diameter: 76.1 },
      'PSC_PIPE_SPEC_MISMATCH',
    );
    expect(wrong.error?.paths).toEqual(['diameter']);
    const bare = execute(base(), 'add_pipe_run', { points: ROUTE, nps: 2.5 });
    expect(bare.summary).toContain('nps needs spec');
  });

  it('records the revision it bound, so a replay binds the same one', () => {
    const result = execute(base(), 'add_pipe_run', { points: ROUTE, spec: 'CS150-A1', nps: 2.5 });
    expect(result.document.featureHistory.at(-1)?.params).toMatchObject({ revision: 1 });
  });
});
