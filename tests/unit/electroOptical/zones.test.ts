import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { electroOpticalErrors } from '@cae/electroOptical/model';
import { run } from './fixtures';

const ZONING = { citation: 'zoning drawing ZD-001 (test input)', locator: 'sheet 2' };

/** Two boxes: a CFRP panel (record productForm 'laminate') and an aluminium fitting. */
function panelAndFitting(): { doc: CadDocument; panel: string; fitting: string } {
  let doc = createEmptyDocument();
  for (const [id, productForm] of [
    ['cfrp_t300', 'laminate'],
    ['al_fitting', 'plate'],
  ] as const)
    doc = run(doc, 'define_material_record', {
      id,
      designation: 'test',
      productForm,
      specs: [],
      licence: 'company-proprietary',
      exportMarking: { regime: 'none' },
    });
  const a = execute(doc, 'add_box', { size: [100, 100, 2] });
  const b = execute(a.document, 'add_box', { size: [10, 10, 10], position: [0, 0, 6] });
  const panel = a.affected[0] ?? '';
  const fitting = b.affected[0] ?? '';
  doc = run(b.document, 'assign_material', { materialName: 'cfrp_t300', entityIds: [panel] });
  doc = run(doc, 'assign_material', { materialName: 'al_fitting', entityIds: [fitting] });
  return { doc, panel, fitting };
}

interface ZoneRow {
  labelId: string;
  entityId: string;
  zone: string;
  bondPaths: string[];
  composite: boolean;
  code: string | null;
}
const zonesOf = (doc: CadDocument): ZoneRow[] => (execute(doc, 'check_bonding', {}).data as { zones: ZoneRow[] }).zones;

describe('set_lightning_zone / remove_lightning_zone', () => {
  it('labels a solid with a step-scoped id and its source', () => {
    const { doc, panel } = panelAndFitting();
    const result = execute(doc, 'set_lightning_zone', { entityId: panel, zone: '2A', source: ZONING });
    expect(result.error).toBeUndefined();
    const id = result.affected[0] ?? '';
    expect(id).toMatch(/^lz-/);
    expect(result.document.electroOptical?.zones?.[id]).toEqual({ id, entityId: panel, zone: '2A', source: ZONING });
    expect(result.summary).toContain('zone 2A');
  });

  it('setting again replaces the label and keeps its id', () => {
    const { doc, panel } = panelAndFitting();
    const first = execute(doc, 'set_lightning_zone', { entityId: panel, zone: '2A', source: ZONING });
    const second = execute(first.document, 'set_lightning_zone', { entityId: panel, zone: '1B', source: ZONING });
    expect(second.affected).toEqual(first.affected);
    expect(Object.values(second.document.electroOptical?.zones ?? {}).map((label) => label.zone)).toEqual(['1B']);
    expect(second.summary).toContain('was 2A');
  });

  it('is pure', () => {
    const { doc, panel } = panelAndFitting();
    const before = structuredClone(doc);
    execute(doc, 'set_lightning_zone', { entityId: panel, zone: '3', source: ZONING });
    expect(doc).toEqual(before);
  });

  it.each([
    ['an unknown solid', { entityId: 'ghost', zone: '1A', source: ZONING }, 'EOP_ENTITY_NOT_FOUND'],
    ['a blank source', { entityId: '$panel', zone: '1A', source: { citation: '  ' } }, 'EOP_ZONE_SOURCE_REQUIRED'],
  ])('refuses %s', (_label, params, code) => {
    const { doc, panel } = panelAndFitting();
    const result = execute(doc, 'set_lightning_zone', { ...params, entityId: params.entityId === '$panel' ? panel : params.entityId });
    expect(result.error?.code).toBe(code);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });

  it('rejects a zone outside ARP5414A and a missing source at validation', () => {
    const { doc, panel } = panelAndFitting();
    expect(execute(doc, 'set_lightning_zone', { entityId: panel, zone: '4', source: ZONING }).summary).toContain('invalid params');
    expect(execute(doc, 'set_lightning_zone', { entityId: panel, zone: '1A' }).summary).toContain('invalid params');
  });

  it('remove_lightning_zone removes the label; a solid without one is refused', () => {
    const { doc, panel, fitting } = panelAndFitting();
    const labelled = run(doc, 'set_lightning_zone', { entityId: panel, zone: '1C', source: ZONING });
    const removed = execute(labelled, 'remove_lightning_zone', { entityId: panel });
    expect(removed.error).toBeUndefined();
    expect(removed.document.electroOptical?.zones).toEqual({});
    const refused = execute(labelled, 'remove_lightning_zone', { entityId: fitting });
    expect(refused.error?.code).toBe('EOP_ZONE_NOT_FOUND');
    expect(refused.document).toBe(labelled);
  });

  it('a labelled solid cannot be deleted while its label exists', () => {
    const { doc, panel } = panelAndFitting();
    const labelled = run(doc, 'set_lightning_zone', { entityId: panel, zone: '2B', source: ZONING });
    const deleted = execute(labelled, 'delete_entities', { ids: [panel] });
    expect(deleted.document.entities[panel]).toBeDefined();
    expect(deleted.summary).toContain('remove_lightning_zone');
  });
});

describe('check_bonding zone rows (EOP_LIGHTNING_ZONE_NO_PATH)', () => {
  it('warns for a composite solid in a zone that no bond path names, without changing the status', () => {
    const { doc, panel, fitting } = panelAndFitting();
    let next = run(doc, 'set_lightning_zone', { entityId: panel, zone: '2A', source: ZONING });
    next = run(next, 'set_lightning_zone', { entityId: fitting, zone: '3', source: ZONING });
    const result = execute(next, 'check_bonding', {});
    const rows = (result.data as { zones: ZoneRow[]; status: string }).zones;
    expect(rows.map((row) => [row.entityId, row.zone, row.composite, row.code])).toEqual([
      [panel, '2A', true, 'EOP_LIGHTNING_ZONE_NO_PATH'],
      [fitting, '3', false, null],
    ]);
    expect((result.data as { status: string }).status).toBe('pass');
    expect(result.summary).toContain(`EOP_LIGHTNING_ZONE_NO_PATH: ${panel} zone 2A`);
  });

  it('a bond path naming the composite solid (endpoint or joint interface) clears the warning', () => {
    const { doc, panel, fitting } = panelAndFitting();
    let next = run(doc, 'set_lightning_zone', { entityId: panel, zone: '1A', source: ZONING });
    next = run(next, 'define_bond_path', {
      name: 'foil to fitting',
      from: fitting,
      to: fitting,
      elements: [
        { kind: 'joint', resistance: { value: 1, unit: 'mohm' }, source: { citation: 'test input' }, interfaces: [panel, fitting] },
      ],
    });
    const [row] = zonesOf(next);
    expect(row?.code).toBeNull();
    expect(row?.bondPaths).toHaveLength(1);
  });

  it('lists no zones when pathIds narrows the check, and none without labels', () => {
    const { doc, panel } = panelAndFitting();
    expect(zonesOf(doc)).toEqual([]);
    const next = run(doc, 'set_lightning_zone', { entityId: panel, zone: '2A', source: ZONING });
    expect((execute(next, 'check_bonding', { pathIds: [] }).data as { zones: ZoneRow[] }).zones).toEqual([]);
  });

  it('a file without zones loads; bad zone labels are refused at load', () => {
    const { doc, panel } = panelAndFitting();
    const labelled = run(doc, 'set_lightning_zone', { entityId: panel, zone: '2A', source: ZONING });
    const slice = labelled.electroOptical as unknown as Record<string, unknown>;
    expect(electroOpticalErrors({ electroOptical: slice })).toEqual([]);
    expect(electroOpticalErrors({ electroOptical: { coatings: {}, bondPaths: {}, dispositions: {} } })).toEqual([]);
    const zones = slice['zones'] as Record<string, Record<string, unknown>>;
    const [key, label] = Object.entries(zones)[0] ?? ['', {}];
    const bad = (patch: Record<string, unknown>): string[] => electroOpticalErrors({ electroOptical: { ...slice, zones: patch } });
    expect(bad({ [key]: { ...label, zone: '4' } })).not.toEqual([]);
    expect(bad({ [key]: { ...label, id: 'other' } })).not.toEqual([]);
    expect(bad({ [key]: label, 'lz-9.9': { ...label, id: 'lz-9.9' } }).join(' ')).toContain('more than one zone label');
    expect(bad({ [key]: { ...label, source: { citation: '' } } })).not.toEqual([]);
  });

  it('a path endpoint names the solid; a solid without a material, or with a plain material, is not composite', () => {
    const { doc, panel, fitting } = panelAndFitting();
    let next = run(doc, 'add_box', { size: [5, 5, 5], position: [50, 50, 50] });
    const bare = next.order[next.order.length - 1] ?? '';
    next = run(next, 'create_material', { name: 'plain', density: 1000, color: '#888888', metalness: 0, roughness: 0.5 });
    next = run(next, 'assign_material', { materialName: 'plain', entityIds: [fitting] });
    for (const entityId of [panel, fitting, bare]) next = run(next, 'set_lightning_zone', { entityId, zone: '2B', source: ZONING });
    next = run(next, 'define_bond_path', {
      name: 'skin to fitting',
      from: panel,
      to: fitting,
      elements: [{ kind: 'joint', resistance: { value: 1, unit: 'mohm' }, source: { citation: 'test input' } }],
    });
    const rows = zonesOf(next);
    expect(rows.map((row) => [row.entityId, row.composite, row.code, row.bondPaths.length])).toEqual([
      [panel, true, null, 1],
      [fitting, false, null, 1],
      [bare, false, null, 0],
    ]);
  });
});
