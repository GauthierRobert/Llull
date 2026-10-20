/** 09 PLM M6 (VC-PLM-14, S3 step 4): as-built records per serial, the comparison with the baseline, and the manufacturing BOM. */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import { plmDocument } from '@plm/document';
import { T } from './fixtures';
import { baselinedAssembly } from './m6Fixtures';
import { agentContext, run, runRaw } from './scenarioRunner';

const DEVIATION = { partNumber: 'LL-1003', installedRevision: 'B', authority: 'RFV-0012 (request for variance, use-as-is)' };
const S3_STEP_4 = {
  serial: 'SN-0007',
  partNumber: 'LL-3000',
  asDesignedBaseline: 'BL-PBL-0003',
  deviations: [DEVIATION],
  at: T,
  by: 'u-9',
};

const code = (doc: CadDocument, command: string, params: unknown): string | undefined => run(doc, command, params).error?.code;
const serialize = (doc: CadDocument): unknown => JSON.parse(JSON.stringify(doc.plm));

describe('record_as_built (S3 step 4)', () => {
  it('records the deviation against the baseline, sealed, under the signer, and as_built_vs_as_designed reports it', () => {
    const doc = baselinedAssembly();
    const result = run(doc, 'record_as_built', S3_STEP_4);
    expect(result.rejected).toBeUndefined();
    expect(result.affected).toEqual([]);
    const record = result.document.plm?.asBuilt?.['SN-0007'];
    expect(record?.deviations).toEqual([DEVIATION]);
    expect(record?.by).toBe('u-9');
    expect(record?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const diff = run(result.document, 'as_built_vs_as_designed', { serial: 'SN-0007' });
    expect(diff.data).toMatchObject({
      conforming: false,
      sealOk: true,
      differences: [{ partNumber: 'LL-1003', asDesigned: 'C', asBuilt: 'B', authority: 'RFV-0012 (request for variance, use-as-is)' }],
    });
    expect(diff.document).toBe(result.document);
  });

  it('records a unit built to the baseline (no deviations) as conforming', () => {
    const result = run(baselinedAssembly(), 'record_as_built', { ...S3_STEP_4, serial: 'SN-0008', deviations: [] });
    expect(run(result.document, 'as_built_vs_as_designed', { serial: 'SN-0008' }).data).toMatchObject({
      conforming: true,
      differences: [],
    });
  });

  it('is pure: the input document is not modified', () => {
    const doc = baselinedAssembly();
    const before = serialize(doc);
    run(doc, 'record_as_built', S3_STEP_4);
    expect(serialize(doc)).toEqual(before);
  });

  it('is a human act: an agent without a trusted signature gets PLM_HUMAN_GATE, and so does a signature over other params', () => {
    const doc = baselinedAssembly();
    const refused = run(doc, 'record_as_built', S3_STEP_4, agentContext());
    expect(refused.error?.code).toBe('PLM_HUMAN_GATE');
    expect(refused.document.plm?.asBuilt).toBeUndefined();
    const confirmation = run(doc, 'plm_act_payload', { command: 'record_as_built', params: S3_STEP_4, nonce: 'nonce-abcdefgh' }).data as {
      payloadSha256: string;
    };
    const forged = runRaw(doc, 'record_as_built', {
      ...S3_STEP_4,
      deviations: [],
      confirmation: { alg: 'Ed25519', signature: confirmation.payloadSha256, nonce: 'nonce-abcdefgh', as: 'u-9' },
    });
    expect(forged.error?.code).toBe('PLM_HUMAN_GATE');
  });

  it('refuses bad input without changing the document', () => {
    const doc = baselinedAssembly();
    expect(code(doc, 'record_as_built', { ...S3_STEP_4, serial: 'bad serial!' })).toBe('PLM_PARAM_INVALID');
    expect(code(doc, 'record_as_built', { ...S3_STEP_4, partNumber: 'LL-9999' })).toBe('PLM_PARAM_INVALID');
    expect(code(doc, 'record_as_built', { ...S3_STEP_4, asDesignedBaseline: 'BL-NONE' })).toBe('PLM_BASELINE_UNKNOWN');
    expect(code(doc, 'record_as_built', { ...S3_STEP_4, mbom: 'MBOM-9' })).toBe('PLM_PARAM_INVALID');
    expect(code(doc, 'record_as_built', { ...S3_STEP_4, deviations: [{ ...DEVIATION, partNumber: 'LL-7777' }] })).toBe('PLM_PARAM_INVALID');
    expect(code(doc, 'record_as_built', { ...S3_STEP_4, deviations: [{ ...DEVIATION, installedRevision: 'C' }] })).toBe(
      'PLM_PARAM_INVALID',
    );
    expect(code(doc, 'record_as_built', { ...S3_STEP_4, deviations: [{ ...DEVIATION, installedRevision: 'b!' }] })).toBe(
      'PLM_PARAM_INVALID',
    );
    expect(code(doc, 'record_as_built', { ...S3_STEP_4, deviations: [{ ...DEVIATION, authority: '  ' }] })).toBe('PLM_PARAM_INVALID');
    expect(code(doc, 'record_as_built', { ...S3_STEP_4, deviations: [DEVIATION, DEVIATION] })).toBe('PLM_PARAM_INVALID');
    expect(code(createEmptyDocument(), 'record_as_built', S3_STEP_4)).toBe('PLM_NOT_MANAGED');
  });

  it('never edits a record: a second record for the serial is refused', () => {
    const once = run(baselinedAssembly(), 'record_as_built', S3_STEP_4).document;
    const again = run(once, 'record_as_built', { ...S3_STEP_4, deviations: [] });
    expect(again.error?.code).toBe('PLM_ID_EXISTS');
    expect(again.document).toBe(once);
  });

  it('refuses a baseline that no longer hashes to its recorded hash', () => {
    const doc = baselinedAssembly();
    const baseline = doc.plm?.baselines?.['BL-PBL-0003'];
    if (doc.plm === undefined || baseline === undefined) throw new Error('fixture');
    const tampered: CadDocument = {
      ...doc,
      plm: { ...doc.plm, baselines: { 'BL-PBL-0003': { ...baseline, members: baseline.members.slice(1) } } },
    };
    expect(code(tampered, 'record_as_built', S3_STEP_4)).toBe('PLM_INTEGRITY_MISMATCH');
  });

  it('is found on load when edited by hand: the seal no longer matches', () => {
    const doc = run(baselinedAssembly(), 'record_as_built', S3_STEP_4).document;
    const saved = JSON.parse(JSON.stringify(doc.plm)) as { asBuilt: Record<string, { deviations: { authority: string }[] }> };
    expect(plmDocument.validate({ plm: saved })).toEqual([]);
    (saved.asBuilt['SN-0007'] as { deviations: { authority: string }[] }).deviations[0]!.authority = 'verbal OK';
    expect(plmDocument.validate({ plm: saved })[0]).toContain('plm.asBuilt.SN-0007 does not hash to its seal');
    const compared = run(
      { ...doc, plm: { ...doc.plm!, asBuilt: { 'SN-0007': { ...doc.plm!.asBuilt!['SN-0007']!, by: 'someone' } } } },
      'as_built_vs_as_designed',
      { serial: 'SN-0007' },
    );
    expect(compared.data).toMatchObject({ sealOk: false });
    expect(compared.summary).toContain('seal');
  });
});

describe('as_built_vs_as_designed', () => {
  it('refuses an unknown serial and an unmanaged document', () => {
    expect(code(baselinedAssembly(), 'as_built_vs_as_designed', { serial: 'SN-1' })).toBe('PLM_SERIAL_UNKNOWN');
    expect(code(createEmptyDocument(), 'as_built_vs_as_designed', { serial: 'SN-1' })).toBe('PLM_NOT_MANAGED');
  });
});

describe('manufacturing BOM', () => {
  const MBOM = {
    id: 'MBOM-A',
    name: 'Hinge plant 2',
    baseline: 'BL-PBL-0003',
    omit: [{ partNumber: 'LL-1002', reason: 'pin is bought pre-installed in the fitting kit' }],
    quantities: [{ partNumber: 'LL-1003', quantity: 4, reason: 'bush kit of 2 per hinge half' }],
    add: [{ partNumber: 'CONS-LOCTITE', name: 'Thread locker', quantity: 0.05, kind: 'consumable', reason: 'assembly' }],
    at: T,
    by: 'u-2',
  };

  it('derives the EBOM of the baseline, applies omissions, quantity changes and manufacturing-only lines, and seals it', () => {
    const result = run(baselinedAssembly(), 'create_mbom', MBOM);
    expect(result.rejected).toBeUndefined();
    const mbom = result.document.plm?.mbom?.['MBOM-A'];
    expect(mbom?.lines.map((line) => [line.partNumber, line.quantity, line.origin])).toEqual([
      ['CONS-LOCTITE', 0.05, 'manufacturing'],
      ['LL-1001', 2, 'ebom'],
      ['LL-1003', 4, 'ebom-quantity'],
    ]);
    expect(mbom?.omitted).toEqual([{ partNumber: 'LL-1002', reason: 'pin is bought pre-installed in the fitting kit' }]);
    const read = run(result.document, 'manufacturing_bom', { id: 'MBOM-A' });
    expect(read.data).toMatchObject({
      sealOk: true,
      differences: { quantityChanged: [{ partNumber: 'LL-1003', ebom: 2, mbom: 4 }], manufacturingOnly: [{ partNumber: 'CONS-LOCTITE' }] },
    });
    expect((read.data as { totalQuantity: number }).totalQuantity).toBeCloseTo(6.05);
    expect(run(result.document, 'manufacturing_bom', {}).data).toMatchObject({
      mboms: [{ id: 'MBOM-A', baseline: 'BL-PBL-0003', lines: 3 }],
    });
  });

  it('can be named by record_as_built when it comes from the same baseline', () => {
    const doc = run(baselinedAssembly(), 'create_mbom', MBOM).document;
    const recorded = run(doc, 'record_as_built', { ...S3_STEP_4, mbom: 'MBOM-A' });
    expect(recorded.document.plm?.asBuilt?.['SN-0007']?.mbom).toBe('MBOM-A');
    const other = run(doc, 'create_baseline', { id: 'BL-2', name: 'second', kind: 'product' }).document;
    expect(code(other, 'record_as_built', { ...S3_STEP_4, asDesignedBaseline: 'BL-2', mbom: 'MBOM-A' })).toBe('PLM_PARAM_INVALID');
  });

  it('numbers the MBOM when no id is given and is sealed against hand edits on load', () => {
    const doc = run(baselinedAssembly(), 'create_mbom', { name: 'plain', baseline: 'BL-PBL-0003' }).document;
    expect(Object.keys(doc.plm?.mbom ?? {})).toEqual(['MBOM-0001']);
    expect(doc.plm?.mbom?.['MBOM-0001']?.lines).toHaveLength(3);
    const saved = JSON.parse(JSON.stringify(doc.plm)) as { mbom: Record<string, { lines: { quantity: number }[] }> };
    saved.mbom['MBOM-0001']!.lines[0]!.quantity = 99;
    expect(plmDocument.validate({ plm: saved })[0]).toContain('plm.mbom.MBOM-0001 does not hash to its seal');
  });

  it('refuses bad input: unknown baseline, duplicate id, parts outside the EBOM, missing reasons, overlaps', () => {
    const doc = baselinedAssembly();
    const made = run(doc, 'create_mbom', MBOM).document;
    expect(code(doc, 'create_mbom', { ...MBOM, baseline: 'BL-NONE' })).toBe('PLM_BASELINE_UNKNOWN');
    expect(code(made, 'create_mbom', MBOM)).toBe('PLM_ID_EXISTS');
    expect(code(doc, 'create_mbom', { ...MBOM, name: ' ' })).toBe('PLM_PARAM_INVALID');
    expect(code(doc, 'create_mbom', { ...MBOM, omit: [{ partNumber: 'LL-9', reason: 'x' }] })).toBe('PLM_PARAM_INVALID');
    expect(code(doc, 'create_mbom', { ...MBOM, omit: [{ partNumber: 'LL-1002', reason: ' ' }] })).toBe('PLM_PARAM_INVALID');
    expect(code(doc, 'create_mbom', { ...MBOM, quantities: [{ partNumber: 'LL-1002', quantity: 3, reason: 'x' }] })).toBe(
      'PLM_PARAM_INVALID',
    );
    expect(code(doc, 'create_mbom', { ...MBOM, quantities: [{ partNumber: 'LL-1003', quantity: 3, reason: '' }] })).toBe(
      'PLM_PARAM_INVALID',
    );
    expect(code(doc, 'create_mbom', { ...MBOM, add: [{ ...MBOM.add[0], partNumber: 'LL-1001' }] })).toBe('PLM_PARAM_INVALID');
    expect(code(doc, 'create_mbom', { ...MBOM, add: [{ ...MBOM.add[0], partNumber: 'bad pn!' }] })).toBe('PLM_PARAM_INVALID');
    expect(code(doc, 'create_mbom', { ...MBOM, add: [{ ...MBOM.add[0], reason: ' ' }] })).toBe('PLM_PARAM_INVALID');
    expect(code(doc, 'create_mbom', { ...MBOM, quantities: [{ partNumber: 'LL-1002', quantity: 1, reason: 'x' }] })).toBe(
      'PLM_PARAM_INVALID',
    );
    expect(code(doc, 'create_mbom', { ...MBOM, quantities: [...MBOM.quantities, ...MBOM.quantities] })).toBe('PLM_PARAM_INVALID');
    expect(code(createEmptyDocument(), 'create_mbom', MBOM)).toBe('PLM_NOT_MANAGED');
    expect(code(doc, 'manufacturing_bom', { id: 'MBOM-X' })).toBe('PLM_MBOM_UNKNOWN');
    expect(code(createEmptyDocument(), 'manufacturing_bom', {})).toBe('PLM_NOT_MANAGED');
  });

  it('is pure and an agent may create one (no human act)', () => {
    const doc = baselinedAssembly();
    const before = serialize(doc);
    const result = run(doc, 'create_mbom', MBOM, agentContext());
    expect(result.rejected).toBeUndefined();
    expect(serialize(doc)).toEqual(before);
  });
});
