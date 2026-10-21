/** 09 PLM M6 (VC-PLM-24): the AP242 PDM export of a revision (CAx-IF / PDM-IF usage guide entities), its independent read-back and the attribute parser. */

import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { SignatureRecord } from '@plm/types';
import type { CadDocument } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import { parseBody } from '@plm/pdm/args';
import { pdmModelOf } from '@plm/pdm/model';
import { readPdm } from '@plm/pdm/read';
import { isoOf, parseInstant, quoted, real } from '@plm/pdm/part21';
import { writePdm } from '@plm/pdm/write';
import { boxOf, step } from '../materials/support';
import { APPROVALS, T, inReview, inWork } from './fixtures';
import { baselinedAssembly, boundAssembly } from './m6Fixtures';
import { run } from './scenarioRunner';

interface Exported {
  step: string;
  state: string;
  counts: Record<string, number>;
  warnings: string[];
  selfCheck: { ok: boolean };
}

const exportPdm = (doc: CadDocument, params: Record<string, unknown> = {}): { data: Exported; step: string; summary: string } => {
  const result = run(doc, 'export_step_pdm', { organization: { id: 'CAGE-1A2B3', name: 'Acme Aero' }, ...params });
  expect(result.rejected, result.summary).toBeUndefined();
  const data = result.data as Exported;
  return { data, step: data.step, summary: result.summary };
};

/** The revision released with a date range and a serial range of effectivity, two approvals and a signature record. */
function releasedWithEffectivity(): CadDocument {
  const eco = run(inReview(), 'create_change_order', {
    id: 'ECO-0100',
    purpose: 'initial-release',
    effectivity: [
      { kind: 'date', from: '2027-01-01', to: '2027-12-31' },
      { kind: 'serial', from: 1, to: 99 },
    ],
    at: T,
    by: 'u-1',
  }).document;
  const approved = APPROVALS.reduce((next, approval) => run(next, 'record_approval', { ...approval, at: T }).document, eco);
  return run(approved, 'release_item', { changeOrder: 'ECO-0100', at: T, by: 'u-1' }).document;
}

const signed = (doc: CadDocument): CadDocument => {
  const plm = doc.plm;
  const revision = plm?.item.revisions['A'];
  if (plm === undefined || revision === undefined) throw new Error('fixture');
  const signature: SignatureRecord = {
    alg: 'Ed25519',
    keyId: 'k-1',
    publicKey: 'a'.repeat(64),
    meaning: 'release',
    signer: { userId: 'u-1', name: "J. O'Neil" },
    signedAt: '2026-11-02T09:05:00Z',
    target: { kind: 'release', ref: 'A' },
    signedSha256: 'b'.repeat(64),
    signature: 'c'.repeat(128),
  };
  return {
    ...doc,
    plm: { ...plm, item: { ...plm.item, revisions: { ...plm.item.revisions, A: { ...revision, signatures: [signature] } } } },
  };
};

describe('export_step_pdm', () => {
  it('writes the product, version, view, structure with quantities, approvals, classification and the release of a released assembly, and reads it back identically', () => {
    const { data, step: text, summary } = exportPdm(baselinedAssembly());
    expect(data).toMatchObject({
      state: 'released',
      selfCheck: { ok: true },
      counts: { versions: 1, structureRows: 3, approvals: 2, signatures: 0 },
    });
    expect(summary).toContain('read-back identical');
    expect(text.startsWith('ISO-10303-21;\nHEADER;')).toBe(true);
    expect(text).toContain("FILE_SCHEMA(('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 3 1 4 }'));");
    for (const entity of [
      "PRODUCT('LL-3000','Hinge assembly'",
      "PRODUCT_DEFINITION_FORMATION('A'",
      "PRODUCT_DEFINITION('design','design view'",
      "PRODUCT_RELATED_PRODUCT_CATEGORY('part'",
      "PRODUCT_RELATED_PRODUCT_CATEGORY('assembly'",
      "ORGANIZATION_ROLE('id owner')",
      "ORGANIZATION('CAGE-1A2B3','Acme Aero'",
      "APPROVAL_STATUS('approved')",
      'APPROVAL(#',
      "'design-authority')",
      "'release')",
      "APPROVAL_ROLE('approver')",
      "SECURITY_CLASSIFICATION('undetermined'",
      "PERSON('u-1','u-1',$,$,$,$)",
      "PRODUCT_DEFINITION_CONTEXT('assembly definition'",
    ])
      expect(text, entity).toContain(entity);
    // One occurrence is a simple usage; two or more are the quantified complex instance of the practice.
    expect(text).toContain("NEXT_ASSEMBLY_USAGE_OCCURRENCE('LL-1002','single instance usage','',#");
    expect(text).toMatch(
      /\(ASSEMBLY_COMPONENT_USAGE\(\$\) NEXT_ASSEMBLY_USAGE_OCCURRENCE\(\) PRODUCT_DEFINITION_RELATIONSHIP\('LL-1001','quantified instance usage'/,
    );
    expect(text).toContain('COUNT_MEASURE(2.)');
    const model = readPdm(text);
    if (typeof model === 'string') throw new Error(model);
    expect(model.structure.map((row) => [row.partNumber, row.revision, row.quantity])).toEqual([
      ['LL-1001', 'B', 2],
      ['LL-1002', 'A', 1],
      ['LL-1003', 'C', 2],
    ]);
    expect(model.approvals.map((a) => [a.role, a.userId, a.at])).toEqual(APPROVALS.map((a) => [a.role, a.userId, null]));
    expect(model).toMatchObject({
      state: 'released',
      approvalStatus: 'approved',
      release: { by: 'u-1', at: T },
      category: 'assembly',
      revision: 'A',
    });
  });

  it('is deterministic and records the header name and time', () => {
    const doc = baselinedAssembly();
    expect(exportPdm(doc).step).toBe(exportPdm(doc).step);
    const header = exportPdm(doc, { fileName: 'hinge.stp', timestamp: '2027-02-01T08:00:00' }).step;
    expect(header).toContain("FILE_NAME('hinge.stp','2027-02-01T08:00:00',(''),('Acme Aero'),'llull','llull','');");
    expect(exportPdm(doc).step).toContain("'1970-01-01T00:00:00'");
  });

  it('writes date effectivity as a general validity period and serial ranges, signatures and hashes as llull properties', () => {
    const doc = signed(releasedWithEffectivity());
    const { data, step: text } = exportPdm(doc);
    expect(data.counts).toMatchObject({ dateEffectivity: 1, unitEffectivity: 1, signatures: 1 });
    expect(data.warnings.join('|')).toContain('unit_effectivity_as_property');
    expect(text).toContain("DATED_EFFECTIVITY('eff-1'");
    expect(text).toContain('APPLIED_EFFECTIVITY_ASSIGNMENT(#');
    expect(text).toContain("OBJECT_ROLE('planned period',$)");
    expect(text).toContain("PROPERTY_DEFINITION('llull unit effectivity'");
    expect(text).toContain('DESCRIPTIVE_REPRESENTATION_ITEM(\'serial\',\'["1","99"]\')');
    expect(text).toContain("PROPERTY_DEFINITION('llull release signature','Ed25519 signature (release) of release:A'");
    expect(text).toContain(`DESCRIPTIVE_REPRESENTATION_ITEM('signature','${'c'.repeat(128)}')`);
    expect(text).toContain("DESCRIPTIVE_REPRESENTATION_ITEM('state','released')");
    const model = readPdm(text);
    if (typeof model === 'string') throw new Error(model);
    expect(model.dateEffectivity).toEqual([{ from: '2027-01-01', to: '2027-12-31' }]);
    expect(model.unitEffectivity).toEqual([{ kind: 'serial', from: '1', to: '99' }]);
    expect(model.signatures[0]).toMatchObject({
      keyId: 'k-1',
      signerId: 'u-1',
      meaning: 'release',
      target: 'release:A',
      signedSha256: 'b'.repeat(64),
    });
    expect(model.integrity.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writes the version history of a revised item with a sequence relationship', () => {
    let doc = releasedWithEffectivity();
    doc = run(doc, 'create_change_order', {
      id: 'ECO-0200',
      classification: 'minor',
      classificationJustification: 'j',
      at: T,
      by: 'u-1',
    }).document;
    doc = run(doc, 'revise_item', { changeOrder: 'ECO-0200', at: T, by: 'u-1' }).document;
    const { step: text, data } = exportPdm(doc);
    expect(data.counts['versions']).toBe(2);
    expect(data.state).toBe('in_work');
    expect(data.warnings.join('|')).toContain('revision_not_released');
    expect(text).toContain("PRODUCT_DEFINITION_FORMATION_RELATIONSHIP('A-B','sequence',$,#");
    expect(text).not.toContain('APPROVAL(#');
    const model = readPdm(text);
    if (typeof model === 'string') throw new Error(model);
    expect(model).toMatchObject({
      revisions: ['A', 'B'],
      revision: 'B',
      reason: 'ECO-0200',
      approvalStatus: 'not yet approved',
      release: null,
    });
    const frozen = exportPdm(doc, { revision: 'A' });
    expect(frozen.data).toMatchObject({ state: 'released', counts: { versions: 1 } });
    expect(frozen.data.warnings.join('|')).not.toContain('revision_not_released');
  });

  it('round-trips awkward text: quotes, backslashes, non-ASCII and astral characters', () => {
    const name = 'O\'Brien \\ "Ø20" ü 日本 😀 #12 /* x */';
    const doc = run(inWork(), 'set_item_identity', { partNumber: 'LL-2001', name, itemType: 'part', at: T, by: 'u-1' }).document;
    const { step: text } = exportPdm(doc);
    expect(text).toContain("O''Brien \\\\ ");
    expect(text).toContain('\\X2\\00D8\\X0\\');
    expect(text).toContain('\\X4\\0001F600\\X0\\');
    expect(readPdm(text)).toMatchObject({ name });
  });

  it('adds the manufacturing view of an MBOM with its own lines', () => {
    const doc = run(baselinedAssembly(), 'create_mbom', {
      id: 'MBOM-A',
      name: 'Plant 2 build',
      baseline: 'BL-PBL-0003',
      omit: [{ partNumber: 'LL-1002', reason: 'kit' }],
      add: [{ partNumber: 'CONS-1', name: 'Thread locker', quantity: 0.5, kind: 'consumable', reason: 'assembly' }],
    }).document;
    const { step: text, data } = exportPdm(doc, { mbom: 'MBOM-A' });
    expect(data.counts['mbomLines']).toBe(3);
    expect(text).toContain("PRODUCT_DEFINITION_CONTEXT('part definition',#1,'manufacturing')");
    expect(text).toContain("PRODUCT_DEFINITION('manufacturing','Plant 2 build'");
    const model = readPdm(text);
    if (typeof model === 'string') throw new Error(model);
    expect(model.mbom).toEqual({
      id: 'MBOM-A',
      name: 'Plant 2 build',
      lines: [
        { partNumber: 'CONS-1', name: 'Thread locker', revision: '-', quantity: 0.5 },
        { partNumber: 'LL-1001', name: 'Fitting', revision: 'B', quantity: 2 },
        { partNumber: 'LL-1003', name: 'Bush', revision: 'C', quantity: 2 },
      ],
    });
    expect(model.structure).toHaveLength(3);
  });

  it('warns about the default organization, an unreleased revision, children without instances and components without a part number', () => {
    let doc = run(boundAssembly(), 'unbind_component_item', { partNumber: 'LL-1003' }).document;
    const pin = Object.values(doc.entities).find((entity) => entity.kind === 'instance' && entity.componentId === 'comp-pin');
    doc = run(doc, 'delete_entities', { ids: [pin?.id] }).document;
    const result = run(doc, 'export_step_pdm', {});
    const warnings = (result.data as Exported).warnings.join('|');
    expect(warnings).toContain('organization_not_set');
    expect(warnings).toContain('revision_not_released');
    expect(warnings).toContain('sub_items_not_written: LL-1002');
    expect(warnings).toContain('components_without_part_number: comp-bush');
  });

  it('is read-only: the document is returned unchanged', () => {
    const doc = baselinedAssembly();
    const before = JSON.stringify(doc.plm);
    const result = run(doc, 'export_step_pdm', {});
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(JSON.stringify(doc.plm)).toBe(before);
  });

  it('refuses an unknown revision or MBOM and an unmanaged document, with nothing exported', () => {
    const doc = baselinedAssembly();
    expect(run(doc, 'export_step_pdm', { revision: 'Z' })).toMatchObject({ rejected: true, error: { code: 'PLM_REVISION_UNKNOWN' } });
    expect(run(doc, 'export_step_pdm', { mbom: 'MBOM-X' })).toMatchObject({ rejected: true, error: { code: 'PLM_MBOM_UNKNOWN' } });
    const unmanaged = run(createEmptyDocument(), 'export_step_pdm', {});
    expect(unmanaged).toMatchObject({ rejected: true, error: { code: 'PLM_NOT_MANAGED' } });
    expect(unmanaged.data).toBeUndefined();
  });

  it('is behind the export-control gate of the materials: controlled content needs the human confirmation', () => {
    const record = { id: 'secret', designation: 'X', specs: [], licence: 'company-proprietary', exportMarking: { regime: 'ITAR' } };
    const marked = boxOf(step(createEmptyDocument(), 'define_material_record', record), 'secret').doc;
    const managed = run(marked, 'set_item_identity', {
      partNumber: 'LL-5',
      name: 'Secret',
      itemType: 'part',
      policy: { humanSignatureRequired: false },
    }).document;
    const refused = execute(managed, 'export_step_pdm', {}, { ...defaultContext(), humanSignature: null });
    expect(refused).toMatchObject({ rejected: true, error: { code: 'MAT_EXPORT_CONTROLLED' } });
    expect(refused.data).toBeUndefined();
  });
});

describe('the PDM reader and the attribute parser', () => {
  const written = (): string => exportPdm(signed(releasedWithEffectivity())).step;

  it('gives reasons for files that are not PDM exports', () => {
    expect(readPdm('')).toMatch(/no product with an id owner/);
    expect(readPdm(written().replace("ORGANIZATION_ROLE('id owner')", "ORGANIZATION_ROLE('x')"))).toMatch(/no product with an id owner/);
    expect(readPdm(written().replace(/PRODUCT_DEFINITION\('design','design view'/, "PRODUCT_DEFINITION('other','x'"))).toMatch(
      /no design view/,
    );
    expect(readPdm(written().replace("'state','released'", "'state','bogus'"))).toMatch(/no llull lifecycle state/);
    expect(readPdm(written().replace(/(APPLIED_ORGANIZATION_ASSIGNMENT\(#\d+,#\d+,)\(#\d+\)\)/, '$1())'))).toMatch(
      /does not name a product/,
    );
  });

  it('sees a tampered file: another approver, another signature byte, another quantity', () => {
    const text = written();
    const model = readPdm(text);
    if (typeof model === 'string') throw new Error(model);
    expect(readPdm(text.replace("PERSON('u-2'", "PERSON('u-9'"))).not.toEqual(model);
    expect(readPdm(text.replace('c'.repeat(128), 'd'.repeat(128)))).not.toEqual(model);
    expect(readPdm(text.replace('llull-pdm.stp', 'renamed.stp'))).toEqual(model);
  });

  it('ignores records it does not know and survives garbage', () => {
    const text = written().replace(
      'DATA;',
      "DATA;\n#9000=UNKNOWN_ENTITY('x',#1);\n#9001=((((((((((((((((((((((1))))))))))))))))))))));\n#9002=GARBAGE;\n",
    );
    expect(typeof readPdm(text)).toBe('object');
  });

  it('parses attribute lists: strings with escapes, numbers, references, enumerations, typed values, lists and complex instances', () => {
    expect(parseBody("PERSON('O''B \\\\ \\X2\\00D8\\X0\\',$,*,#12,.EXACT.,-1.5E2,(#1,#2),COUNT_MEASURE(2.))")).toEqual([
      {
        entity: 'PERSON',
        args: [
          "O'B \\ Ø",
          null,
          null,
          { ref: 12 },
          { enumeration: 'EXACT' },
          -150,
          [{ ref: 1 }, { ref: 2 }],
          { typed: 'COUNT_MEASURE', value: 2 },
        ],
      },
    ]);
    expect(parseBody('(A($) B() C(#1))')?.map((call) => call.entity)).toEqual(['A', 'B', 'C']);
    for (const bad of [
      '',
      'x',
      'A(',
      'A(1,',
      "A('x",
      'A(#)',
      'A(#1234567890123)',
      'A(1 2)',
      'A(.x y.)',
      '(A(1)',
      'A(' + '('.repeat(40) + ')'.repeat(40) + ')',
      'A(1e999999999999999999999999999999999999999999999)',
    ])
      expect(parseBody(bad), bad).toBeNull();
    expect(parseBody('A()')).toEqual([{ entity: 'A', args: [] }]);
  });

  it('formats Part 21 values and ISO instants', () => {
    expect(quoted("a'b\\c\n")).toBe("'a''b\\\\c\\X2\\000A\\X0\\'");
    expect([real(5), real(0.25), real(1e-7), real(1e21), real(-0), real(Number.NaN)]).toEqual(['5.', '0.25', '1.E-7', '1.E21', '0.', '0.']);
    expect(parseInstant('2026-11-02T09:30:05.75Z')).toEqual({ year: 2026, month: 11, day: 2, hour: 9, minute: 30, second: 5 });
    expect(isoOf(parseInstant('2026-11-02') as NonNullable<ReturnType<typeof parseInstant>>, true)).toBe('2026-11-02');
    for (const bad of ['2026-13-01', '2026-11-32', 'yesterday', '2026-11-02T25:00:00Z', '2026-11-02T10:61:00Z'])
      expect(parseInstant(bad), bad).toBeNull();
  });

  it('pdmModelOf names an unknown revision or MBOM and skips unparsable dates', () => {
    const doc = baselinedAssembly();
    const plm = doc.plm;
    if (plm === undefined) throw new Error('fixture');
    const options = { organization: { id: 'o', name: 'O' } };
    expect(pdmModelOf(doc, plm, 'Z', options)).toContain("no revision 'Z'");
    expect(pdmModelOf(doc, plm, 'A', { ...options, mbom: 'nope' })).toContain("no manufacturing BOM 'nope'");
    const revision = plm.item.revisions['A'];
    if (revision === undefined) throw new Error('fixture');
    const odd = {
      ...plm,
      item: {
        ...plm.item,
        revisions: {
          A: {
            ...revision,
            releasedEffectivity: [{ kind: 'date' as const, from: 'soon' }],
            approvals: [{ role: 'r', userId: 'u', at: 'x' }],
          },
        },
      },
    };
    const model = pdmModelOf(doc, odd, 'A', options);
    if (typeof model === 'string') throw new Error(model);
    expect(model.dateEffectivity).toEqual([]);
    expect(model.unitEffectivity).toEqual([{ kind: 'date', from: 'soon', to: null }]);
    expect(model.approvals).toEqual([{ role: 'r', userId: 'u', at: null }]);
    const text = writePdm(model, { fileName: 'f', timestamp: 't' });
    expect(readPdm(text)).toEqual(model);
  });
});
