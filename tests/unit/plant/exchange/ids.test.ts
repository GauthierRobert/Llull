/** Plant 08 DAT-M4: `check_ifc_requirements` (VC-DAT-10): parity with the ifctester results of the pack on its five IFC files, every facet, refusals, hostile IDS. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { data, expectRefusal } from '../../../helpers/commandAssertions';
import { PACK } from '../data/dataFixtures';
import { referenceIfc, scDat01, stamp } from './ifcFixtures';

interface Checked {
  title: string;
  schema: string;
  status: 'pass' | 'fail';
  failedSpecifications: number;
  specifications: Array<{ name: string; status: string; applicable: number; failed: number; failedGlobalIds: string[]; skipped?: string }>;
}

const doc = createEmptyDocument();
const ids = readFileSync(path.join(PACK, 'data/reference/plant-handover.ids'), 'utf8');
const check = (idsText: string, ifc: string): Checked => data<Checked>(doc, 'check_ifc_requirements', { ids: idsText, ifc });
const bsi = (name: string): string => readFileSync(path.join(PACK, 'data/bsi', name), 'utf8');

const expected = JSON.parse(readFileSync(path.join(PACK, 'data/reference/ids_results.json'), 'utf8')) as Record<
  string,
  Array<{ spec: string; status: boolean; applicable: number; failed: number }>
>;
const files: Array<[string, () => string]> = [
  ['sc-dat-01-reference.ifc', () => referenceIfc('sc-dat-01-reference.ifc')],
  ['sc-dat-02-reference.ifc', () => referenceIfc('sc-dat-02-reference.ifc')],
  ['sc-dat-02-negative.ifc', () => referenceIfc('sc-dat-02-negative.ifc')],
  ['Infra-Plumbing.ifc', () => bsi('IFC4X3_ADD2_Infra-Plumbing.ifc')],
  ['Building-Hvac.ifc', () => bsi('IFC4X3_ADD2_Building-Hvac.ifc')],
];

const wrap = (specification: string, version = 'IFC4X3_ADD2'): string =>
  `<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema"><info><title>t</title></info><specifications><specification name="s" ifcVersion="${version}">${specification}</specification></specifications></ids>`;
const entity = (name: string): string => `<entity><name><simpleValue>${name}</simpleValue></name></entity>`;
const applicability = (inner: string, minOccurs = 0): string =>
  `<applicability minOccurs="${minOccurs}" maxOccurs="unbounded">${inner}</applicability>`;

describe('check_ifc_requirements: parity with ifctester (VC-DAT-10)', () => {
  it.each(files)('%s', (name, load) => {
    const result = check(ids, load());
    const reference = expected[name] ?? [];
    expect(result.specifications.map((spec) => [spec.name, spec.status === 'pass', spec.applicable, spec.failed])).toEqual(
      reference.map((spec) => [spec.spec, spec.status, spec.applicable, spec.failed]),
    );
  });

  it('the failing sample lists the 24 failing GlobalIds (capped at 100) and the status is fail', () => {
    const result = check(ids, bsi('IFC4X3_ADD2_Infra-Plumbing.ifc'));
    expect(result.status).toBe('fail');
    expect(result.failedSpecifications).toBe(1);
    expect(result.specifications[0]?.failedGlobalIds).toHaveLength(24);
  });

  it('with no ifc it checks the export of the document: 0 failures on SC-DAT-01 (exported with IFC4X3_ADD2)', () => {
    const result = data<Checked>(scDat01(), 'check_ifc_requirements', { ids });
    expect(result.schema).toBe('IFC4X3_ADD2');
    expect(result.specifications.map((spec) => [spec.status, spec.applicable])).toEqual([
      ['pass', 5],
      ['pass', 5],
      ['pass', 0],
    ]);
    void stamp;
  });
});

describe('check_ifc_requirements: facets', () => {
  const sc01 = referenceIfc('sc-dat-01-reference.ifc');

  it('entity with a predefinedType, a supertype name and a minOccurs 1 applicability that matches nothing', () => {
    const run = (inner: string, minOccurs = 0): Checked['specifications'][number] =>
      check(wrap(`${applicability(inner, minOccurs)}<requirements>${entity('IFCPIPESEGMENT')}</requirements>`), sc01)
        .specifications[0] as never;
    expect(
      run(
        `<entity><name><simpleValue>IFCPIPEFITTING</simpleValue></name><predefinedType><simpleValue>BEND</simpleValue></predefinedType></entity>`,
      ),
    ).toMatchObject({ applicable: 3, failed: 3 });
    expect(run(entity('IFCFLOWSEGMENT'))).toMatchObject({ applicable: 5, failed: 0, status: 'pass' });
    expect(run(entity('IFCCHILLER'), 1)).toMatchObject({ applicable: 0, status: 'fail' });
    expect(run(entity('IFCCHILLER'), 0)).toMatchObject({ applicable: 0, status: 'pass' });
  });

  it('attribute with an enumeration, a pattern, an absent attribute and prohibited / optional', () => {
    const attribute = (value: string, cardinality = 'required', name = 'Tag'): string =>
      `<attribute cardinality="${cardinality}"><name><simpleValue>${name}</simpleValue></name>${value}</attribute>`;
    const run = (requirement: string): Checked['specifications'][number] =>
      check(wrap(`${applicability(entity('IFCPUMP'), 1)}<requirements>${requirement}</requirements>`), sc01).specifications[0] as never;
    expect(run(attribute(''))).toMatchObject({ status: 'pass', applicable: 1 });
    expect(
      run(
        attribute(
          '<value><xs:restriction base="xs:string"><xs:enumeration value="P-101"/><xs:enumeration value="P-102"/></xs:restriction></value>',
        ),
      ),
    ).toMatchObject({ status: 'pass' });
    expect(run(attribute('<value><xs:restriction base="xs:string"><xs:pattern value="X-[0-9]+"/></xs:restriction></value>'))).toMatchObject(
      { status: 'fail', failed: 1 },
    );
    expect(run(attribute('', 'required', 'LongName'))).toMatchObject({ status: 'fail' });
    expect(run(attribute('', 'optional', 'LongName'))).toMatchObject({ status: 'pass' });
    expect(run(attribute('', 'prohibited', 'LongName'))).toMatchObject({ status: 'pass' });
    expect(run(attribute('', 'prohibited', 'Tag'))).toMatchObject({ status: 'fail' });
    expect(run(attribute('<value><simpleValue>ENDSUCTION</simpleValue></value>', 'required', 'PredefinedType'))).toMatchObject({
      status: 'pass',
    });
  });

  it('property with a value, bounds and a data type; partOf with a relation; classification absent', () => {
    const property = (inner: string, dataType = ''): string =>
      `<property ${dataType} cardinality="required"><propertySet><simpleValue>Pset_PipeSegmentTypeCommon</simpleValue></propertySet><baseName><simpleValue>NominalDiameter</simpleValue></baseName>${inner}</property>`;
    const run = (requirement: string): Checked['specifications'][number] =>
      check(wrap(`${applicability(entity('IFCPIPESEGMENT'), 1)}<requirements>${requirement}</requirements>`), sc01)
        .specifications[0] as never;
    expect(run(property(''))).toMatchObject({ status: 'pass', applicable: 5 });
    expect(
      run(
        property(
          '<value><xs:restriction base="xs:double"><xs:minInclusive value="50"/><xs:maxInclusive value="500"/></xs:restriction></value>',
        ),
      ),
    ).toMatchObject({ status: 'pass' });
    expect(run(property('<value><xs:restriction base="xs:double"><xs:maxExclusive value="50"/></xs:restriction></value>'))).toMatchObject({
      status: 'fail',
      failed: 5,
    });
    expect(run(property('', 'dataType="IFCTEXT"'))).toMatchObject({ status: 'fail' });
    expect(
      run('<partOf relation="IFCRELASSIGNSTOGROUP" cardinality="required">' + entity('IFCDISTRIBUTIONSYSTEM') + '</partOf>'),
    ).toMatchObject({ status: 'pass' });
    expect(
      run('<partOf relation="IFCRELAGGREGATES" cardinality="required">' + entity('IFCDISTRIBUTIONSYSTEM') + '</partOf>'),
    ).toMatchObject({ status: 'fail' });
    expect(
      run('<classification cardinality="required"><system><simpleValue>Uniclass</simpleValue></system></classification>'),
    ).toMatchObject({ status: 'fail' });
    expect(
      run('<classification cardinality="prohibited"><system><simpleValue>Uniclass</simpleValue></system></classification>'),
    ).toMatchObject({ status: 'pass' });
  });

  it('classification reads IfcClassificationReference through IfcRelAssociatesClassification', () => {
    const classified = sc01.replace(
      'ENDSEC;\nEND-ISO-10303-21;',
      "#90001=IFCCLASSIFICATION('NBS',$,$,'Uniclass 2015',$,$,$);\n#90002=IFCCLASSIFICATIONREFERENCE($,'Pr_65_52',$,#90001,$,$);\n#90003=IFCRELASSOCIATESCLASSIFICATION('2abcdefghijklmnopqrstu',$,$,$,(#1),#90002);\nENDSEC;\nEND-ISO-10303-21;",
    );
    const firstEntity = [...sc01.matchAll(/^#(\d+)=IFCPUMP/gm)][0]?.[1] ?? '1';
    const pumpIds = classified.replace('(#1),#90002', `(#${firstEntity}),#90002`);
    const spec = wrap(
      `${applicability(entity('IFCPUMP'), 1)}<requirements><classification cardinality="required"><system><simpleValue>Uniclass 2015</simpleValue></system><value><xs:restriction base="xs:string"><xs:pattern value="Pr_[0-9_]+"/></xs:restriction></value></classification></requirements>`,
    );
    expect(check(spec, pumpIds).specifications[0]).toMatchObject({ status: 'pass', applicable: 1 });
    expect(check(spec, sc01).specifications[0]).toMatchObject({ status: 'fail' });
  });

  it('a specification for another IFC version is skipped with the reason', () => {
    const result = check(wrap(`${applicability(entity('IFCPUMP'), 1)}<requirements>${entity('IFCPUMP')}</requirements>`, 'IFC2X3'), sc01);
    expect(result.specifications[0]).toMatchObject({ status: 'pass', applicable: 0, skipped: expect.stringContaining('IFC2X3') });
  });
});

describe('check_ifc_requirements: refusals and hostile input', () => {
  const sc01 = referenceIfc('sc-dat-01-reference.ifc');
  const run = (idsText: string, ifc: string = sc01): { name: string; params: { ids: string; ifc: string } } => ({
    name: 'check_ifc_requirements',
    params: { ids: idsText, ifc },
  });
  const refuse = (idsText: string, code: string, ifc: string = sc01, path = 'ids'): void => {
    const { name, params } = run(idsText, ifc);
    expectRefusal(doc, name, params, code, path);
  };

  it.each([
    ['not xml', 'hello', 'DAT_IDS_PARSE'],
    ['another root', '<foo/>', 'DAT_IDS_PARSE'],
    ['a DTD (no external entities are ever resolved)', '<!DOCTYPE ids [<!ENTITY x SYSTEM "file:///etc/passwd">]><ids/>', 'DAT_IDS_PARSE'],
    ['no specification', '<ids><specifications/></ids>', 'DAT_IDS_PARSE'],
    ['a specification without applicability', wrap('<requirements/>'), 'DAT_IDS_PARSE'],
    [
      'the material facet',
      wrap(`${applicability(entity('IFCPUMP'))}<requirements><material cardinality="required"/></requirements>`),
      'DAT_IDS_UNSUPPORTED_FACET',
    ],
    [
      'xs:length',
      wrap(
        `${applicability(entity('IFCPUMP'))}<requirements><attribute><name><simpleValue>Tag</simpleValue></name><value><xs:restriction base="xs:string"><xs:length value="3"/></xs:restriction></value></attribute></requirements>`,
      ),
      'DAT_IDS_UNSUPPORTED_FACET',
    ],
    [
      'a catastrophic pattern',
      wrap(
        `${applicability(entity('IFCPUMP'))}<requirements><attribute><name><simpleValue>Tag</simpleValue></name><value><xs:restriction base="xs:string"><xs:pattern value="(a+)+$"/></xs:restriction></value></attribute></requirements>`,
      ),
      'DAT_IDS_UNSUPPORTED_FACET',
    ],
    [
      'an invalid pattern',
      wrap(
        `${applicability(entity('IFCPUMP'))}<requirements><attribute><name><simpleValue>Tag</simpleValue></name><value><xs:restriction base="xs:string"><xs:pattern value="(["/></xs:restriction></value></attribute></requirements>`,
      ),
      'DAT_IDS_PARSE',
    ],
    [
      'a bound that is not a number',
      wrap(
        `${applicability(entity('IFCPUMP'))}<requirements><attribute><name><simpleValue>Tag</simpleValue></name><value><xs:restriction base="xs:string"><xs:minInclusive value="abc"/></xs:restriction></value></attribute></requirements>`,
      ),
      'DAT_IDS_PARSE',
    ],
    [
      'a bad cardinality',
      wrap(
        `${applicability(entity('IFCPUMP'))}<requirements><attribute cardinality="maybe"><name><simpleValue>Tag</simpleValue></name></attribute></requirements>`,
      ),
      'DAT_IDS_PARSE',
    ],
    ['an unknown facet', wrap(`${applicability(entity('IFCPUMP'))}<requirements><geometry/></requirements>`), 'DAT_IDS_UNSUPPORTED_FACET'],
  ])('refuses %s', (_name, idsText, code) => refuse(idsText, code));

  it('refuses an IFC that is not an IFC STEP file', () => {
    refuse(ids, 'DAT_IFC_PARSE', 'nonsense', 'ifc');
  });

  it('a long value against a plain pattern stays fast (values over 1000 characters never match)', () => {
    const pattern = wrap(
      `${applicability(entity('IFCPUMP'), 0)}<requirements><attribute><name><simpleValue>Tag</simpleValue></name><value><xs:restriction base="xs:string"><xs:pattern value="[A-Z]+-[0-9]+"/></xs:restriction></value></attribute></requirements>`,
    );
    const long = sc01.replace(/(#\d+=IFCPUMP\('[^']*',[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,)'[^']*'/, `$1'${'A'.repeat(500_000)}'`);
    const started = performance.now();
    expect(check(pattern, long).specifications[0]).toMatchObject({ status: 'fail', failed: 1 });
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it('is pure', () => {
    const before = JSON.stringify(doc);
    check(ids, sc01);
    expect(JSON.stringify(doc)).toBe(before);
    void stamp;
  });
});
