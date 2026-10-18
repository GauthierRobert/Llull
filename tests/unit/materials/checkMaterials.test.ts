import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { CadDocument } from '@core/model/types';
import { boxOf, call, dataOf, libraryFile, mmDocument, SOURCE, step } from './support';

const PACK = 'docs/aerospace/08-materials-standards-libraries/validation/expected_results.json';
interface Vc22Row {
  densitySource: string;
  massG: number;
  massKg?: number;
  massLb?: number;
  unverified: boolean;
  unverifiedReasons: string[];
}
const pack = JSON.parse(readFileSync(PACK, 'utf8')) as {
  agentFirst: { id: string; expected: Vc22Row[]; check_materials?: { code: string; severity: string } }[];
};
const vc22 = pack.agentFirst.find((entry) => entry.id === 'VC-MAT-22');
const rows = vc22?.expected ?? [];

const record = (id: string): Record<string, unknown> => ({
  id,
  designation: '7075',
  specs: [],
  licence: 'company-proprietary',
  exportMarking: { regime: 'none' },
});
const density = (material: string, value: number, unit: string, basis: string): Record<string, unknown> => ({
  material,
  source: SOURCE,
  property: 'density',
  value,
  unit,
  basis,
});
const items = (
  doc: CadDocument,
  params: Record<string, unknown> = {},
): { code: string; severity: string; ids: string[]; message: string; remediation: string }[] =>
  dataOf(call(doc, 'check_materials', params))['items'] as {
    code: string;
    severity: string;
    ids: string[];
    message: string;
    remediation: string;
  }[];
const near = (actual: unknown, expected: number): boolean => Math.abs((actual as number) / expected - 1) < 1e-6;

describe('VC-MAT-22: unverified values reach mass_properties and check_materials', () => {
  const check = (doc: CadDocument, id: string, row: Vc22Row, source: string): void => {
    const data = dataOf(call(doc, 'mass_properties', { entityId: id }));
    expect(near(data['massG'], row.massG)).toBe(true);
    if (row.massKg !== undefined) expect(near(data['massKg'], row.massKg)).toBe(true);
    if (row.massLb !== undefined) expect(near(data['massLb'], row.massLb)).toBe(true);
    expect(data).toMatchObject({ unverified: true, unverifiedReasons: row.unverifiedReasons });
    expect(String(data['densitySource'])).toContain(source);
    const result = call(doc, 'check_materials', {});
    expect(dataOf(result)['status']).toBe('warn');
    expect(items(doc)[0]).toMatchObject({ code: vc22?.check_materials?.code, severity: vc22?.check_materials?.severity });
    expect(items(doc)[0]?.remediation).not.toBe('');
  };

  it('(a) the typical density', () => {
    let doc = step(mmDocument(), 'define_material_record', record('aa7075_t6'));
    doc = step(doc, 'set_material_property', { ...density('aa7075_t6', 2.81, 'g/cm^3', 'typical'), id: 'density_typical_matweb' });
    const { doc: withBox, id } = boxOf(doc, 'aa7075_t6');
    check(withBox, id, rows[0] as Vc22Row, 'density_typical_matweb');
    expect(items(withBox)[0]?.ids).toEqual(['aa7075_t6/density_typical_matweb']);
  });

  it('(b) the supplier density', () => {
    let doc = step(mmDocument(), 'define_material_record', record('aa7075_t6'));
    doc = step(doc, 'set_material_property', {
      ...density('aa7075_t6', 0.101, 'lb/in^3', 'supplier_unstated'),
      id: 'density_ams4045_supplier',
    });
    const { doc: withBox, id } = boxOf(doc, 'aa7075_t6');
    check(withBox, id, rows[1] as Vc22Row, 'density_ams4045_supplier');
  });

  it('(c) a legacy material', () => {
    const doc = step(mmDocument(), 'create_material', { name: 'steel', density: 0.00785, color: '#aaaaaa', metalness: 1, roughness: 0.4 });
    const added = call(doc, 'add_box', { size: [10, 10, 10] });
    const withBox = step(added.document, 'assign_material', { materialName: 'steel', entityIds: [added.affected[0] ?? ''] });
    check(withBox, added.affected[0] ?? '', rows[2] as Vc22Row, "material 'steel' density (given without a source");
    expect(items(withBox)[0]?.message).toContain('bare number');
  });
});

describe('check_materials', () => {
  it('passes for verified values on a clean document', () => {
    let doc = step(mmDocument(), 'define_material_record', record('m'));
    doc = step(doc, 'set_material_property', density('m', 2.81, 'g/cm^3', 'company'));
    const clean = boxOf(doc, 'm').doc;
    const result = call(clean, 'check_materials', {});
    expect(dataOf(result)).toEqual({ status: 'pass', items: [] });
    expect(result.summary).toBe('check_materials: pass — 0 finding(s).');
    expect(result.document).toBe(clean);
  });

  it('only looks at the materials in use, and at the entities asked for', () => {
    let doc = step(mmDocument(), 'define_material_record', record('typical'));
    doc = step(doc, 'set_material_property', density('typical', 2.81, 'g/cm^3', 'typical'));
    expect(items(doc)).toEqual([]);
    const { doc: used, id } = boxOf(doc, 'typical');
    const other = call(used, 'add_box', { size: [1, 1, 1] });
    expect(items(used, { entityIds: [id] })).toHaveLength(1);
    expect(items(other.document, { entityIds: [other.affected[0]] })).toEqual([]);
    const unknown = items(used, { entityIds: ['ghost'] });
    expect(unknown).toEqual([expect.objectContaining({ code: 'MAT_ENTITY_NOT_FOUND', severity: 'error', ids: ['ghost'] })]);
    expect(dataOf(call(used, 'check_materials', { entityIds: ['ghost'] }))['status']).toBe('fail');
  });

  it('flags a superseded record and an assignment to a material that does not exist', () => {
    const doc = step(mmDocument(), 'define_material_record', {
      ...record('old'),
      superseded: { by: 'MMPDS', note: 'MIL-HDBK-5J cancelled 2003' },
    });
    const { doc: used, id } = boxOf(step(doc, 'set_material_property', density('old', 2.81, 'g/cm^3', 'company')), 'old');
    expect(items(used)).toEqual([expect.objectContaining({ code: 'MAT_SOURCE_SUPERSEDED', severity: 'warning', ids: ['old'] })]);
    const { [id]: box } = used.entities;
    const dangling = { ...used, entities: { ...used.entities, [id]: { ...box, materialId: 'ghost' } } } as CadDocument;
    expect(items(dangling)).toEqual([expect.objectContaining({ code: 'MAT_RECORD_NOT_FOUND', severity: 'error', ids: [id] })]);
  });

  it('flags records of a private library that this machine does not hold, once per library', () => {
    const base = step(mmDocument(), 'import_material_library', { library: libraryFile({ id: 'mmpds' }) });
    const stub = {
      ...base,
      materialLibraries: { mmpds: { ...base.materialLibraries?.['mmpds'], storage: 'private' as const } },
      materials: {
        aa7075_t6: {
          ...base.materials['aa7075_t6'],
          density: 0,
          propertyModels: undefined,
          record: { ...base.materials['aa7075_t6']?.record, unresolved: { reason: 'provider missing' } },
        },
      },
    } as unknown as CadDocument;
    const found = items(stub);
    expect(found).toEqual([expect.objectContaining({ code: 'MAT_LIBRARY_UNRESOLVED', severity: 'warning', ids: ['mmpds', 'aa7075_t6'] })]);
    expect(found[0]?.remediation).toContain('register_material_library');
  });

  it('flags two preferred values on one key as an error', () => {
    let doc = step(mmDocument(), 'define_material_record', record('m'));
    doc = step(doc, 'set_material_property', { ...density('m', 2.81, 'g/cm^3', 'company'), id: 'a', preferred: true });
    doc = step(doc, 'set_material_property', { ...density('m', 2.82, 'g/cm^3', 'company'), id: 'b' });
    const [first, second] = doc.materials['m']?.propertyModels ?? [];
    const broken = {
      ...doc,
      materials: { ...doc.materials, m: { ...doc.materials['m'], propertyModels: [first, { ...second, preferred: true }] } },
    } as CadDocument;
    expect(items(broken)).toEqual([expect.objectContaining({ code: 'MAT_PREFERRED_CONFLICT', severity: 'error', ids: ['m/a', 'm/b'] })]);
    expect(dataOf(call(broken, 'check_materials', {}))['status']).toBe('fail');
  });

  it('reports the export-controlled content in use, including entities inside components', () => {
    let doc = step(mmDocument(), 'define_material_record', { ...record('itar'), exportMarking: { regime: 'ITAR' } });
    doc = step(doc, 'set_material_property', density('itar', 2.81, 'g/cm^3', 'company'));
    const { doc: used, id } = boxOf(doc, 'itar');
    expect(items(used)).toEqual([expect.objectContaining({ code: 'MAT_EXPORT_CONTROLLED', severity: 'warning', ids: ['itar'] })]);
    const packed = step(used, 'create_component', { name: 'part', entityIds: [id] });
    expect(Object.keys(packed.entities)).not.toContain(id);
    expect(items(packed).map((item) => item.code)).toEqual(['MAT_EXPORT_CONTROLLED']);
    expect(call(packed, 'export_stl', {}).error?.code).toBe('MAT_EXPORT_CONTROLLED');
  });

  it('warns about fastener parts built from placeholder geometry', () => {
    const doc = mmDocument();
    const withParts = {
      ...doc,
      components: {
        'comp-1': {
          id: 'comp-1',
          name: 'bolt',
          entities: {},
          order: [],
          partRef: { family: 'NAS6203-6220', partNumber: 'NAS6203-9', representative: true },
        },
        'comp-2': { id: 'comp-2', name: 'nut', entities: {}, order: [], partRef: { family: 'MS21042', partNumber: 'MS21042L3' } },
      },
      fasteners: { catalogs: {}, stacks: {} },
    } as unknown as CadDocument;
    expect(items(withParts)).toEqual([
      expect.objectContaining({ code: 'FAST_GEOMETRY_REPRESENTATIVE', severity: 'warning', ids: ['NAS6203-9'] }),
    ]);
  });

  it('is read-only', () => {
    const doc = step(mmDocument(), 'define_material_record', record('m'));
    expect(call(doc, 'check_materials', {}).document).toBe(doc);
  });
});
