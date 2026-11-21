/**
 * Plant 08 DAT-VIS-FU2: every IfcGuid a BCF export writes is a GlobalId in the IFC text of BOTH schemas, and the categories whose IFC product is not seeded by the
 * element id (pipe, moment connection, grid) carry none. Also: `export_bcf_viewpoint`, and a Coloring in 3.0 and 2.1, carry IfcGuid once per viewpoint.
 */
import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { bcfVisualizationXml } from '@core/commands/exchange/bcf/bcfXml';
import { readXml, xmlAttr, xmlChildren, xmlText, type XmlElement } from '@lib/xmlRead';
import { unzip } from '@lib/zipRead';
import { readStep, stepString } from '@lib/stepRead';
import { apply, data } from '../../helpers/commandAssertions';
import { scDat02Document } from '../plant/data/dataFixtures';

const CAMERA = { projection: 'perspective', eye: [0, -8000, 3000], direction: [0, 1, -0.3], fovDeg: 50 };

/** SC-DAT-02 (pump, vessel, routed pipes) + a grid, a wall, a steel frame with its moment connections; one issue naming every building entity. */
function plantWithFrame(): CadDocument {
  let doc = scDat02Document();
  doc = apply(doc, 'add_grid_system', { xSpacings: [5000], ySpacings: [5000] });
  const add = (params: Record<string, unknown>): void => {
    doc = apply(doc, 'add_steel_member', params);
  };
  add({ profile: 'HEA300', role: 'column', start: [30000, 0, 0], end: [30000, 0, 6000] });
  add({ profile: 'HEA300', role: 'column', start: [42000, 0, 0], end: [42000, 0, 6000] });
  add({ profile: 'IPE400', role: 'rafter', start: [30000, 0, 6000], end: [36000, 0, 6600] });
  add({ profile: 'IPE400', role: 'rafter', start: [42000, 0, 6000], end: [36000, 0, 6600] });
  doc = apply(doc, 'add_moment_connections', {});
  doc = apply(doc, 'add_box', { size: [10, 10, 10] });
  const box = doc.order.at(-1) as string;
  const building = doc.building;
  if (building === undefined) throw new Error('no building');
  const level = Object.values(building.elements)[0]?.levelId ?? 'level-1';
  const pipe = {
    id: 'pipe-9',
    mark: 'PIPE9',
    label: 'pipe',
    category: 'pipe',
    levelId: level,
    entityIds: [box],
    points: [
      [0, 0, 0],
      [1000, 0, 0],
    ],
    diameter: 100,
    service: 'water',
    material: 'steel',
  };
  doc = {
    ...doc,
    building: { ...building, elements: { ...building.elements, 'pipe-9': pipe }, elementOrder: [...building.elementOrder, 'pipe-9'] },
  } as unknown as CadDocument;
  const equipment = Object.values(doc.building?.elements ?? {})
    .filter((element) => element.category === 'equipment')
    .flatMap((element) => element.entityIds);
  doc = apply(doc, 'save_viewpoint', { name: 'v', camera: CAMERA, selection: equipment });
  const owned = Object.values(doc.building?.elements ?? {}).flatMap((element) => element.entityIds);
  return apply(doc, 'create_review_issue', { title: 'All', viewpointIds: ['vp-1'], entityIds: owned });
}

const viewpointXml = (doc: CadDocument, version: '3.0' | '2.1'): string => {
  const exported = data<{ base64: string }>(doc, 'export_bcf', { snapshots: false, version });
  const entry = unzip(Buffer.from(exported.base64, 'base64')).find((item) => item.name.endsWith('.bcfv'));
  return new TextDecoder().decode(entry?.data ?? new Uint8Array());
};

const selectionOf = (xml: string): XmlElement[] => {
  const parsed = readXml(xml);
  if (!parsed.ok) throw new Error('bad xml');
  const holder = xmlChildren(parsed.root, 'Components')[0] as XmlElement;
  return xmlChildren(xmlChildren(holder, 'Selection')[0] as XmlElement, 'Component');
};

const globalIds = (ifc: string): Set<string> =>
  new Set([...readStep(ifc).entities.values()].flatMap((entity) => stepString(entity.args[0] as string) ?? []));

describe('BCF IfcGuid against the IFC export', () => {
  const doc = plantWithFrame();
  const components = selectionOf(viewpointXml(doc, '3.0'));
  const byEntity = new Map(
    components.map((component) => [xmlText(xmlChildren(component, 'AuthoringToolId')[0] as XmlElement), xmlAttr(component, 'IfcGuid')]),
  );
  const categoryOf = (entityId: string): string | undefined =>
    Object.values(doc.building?.elements ?? {}).find((element) => element.entityIds.includes(entityId))?.category;

  it.each(['IFC4', 'IFC4X3_ADD2'] as const)('every IfcGuid is a GlobalId in the %s text', (schema) => {
    const ifc = data<{ ifc: string }>(doc, 'export_ifc', { timestamp: '2026-01-01T00:00:00', schema }).ifc;
    const present = globalIds(ifc);
    const guids = [...byEntity.values()].filter((guid): guid is string => guid !== undefined);
    expect(guids.length).toBeGreaterThan(2);
    for (const guid of guids) expect(present.has(guid), `${guid} in ${schema}`).toBe(true);
  });

  it('categories not seeded by the element id carry no IfcGuid, the others do', () => {
    const categories = new Map<string, boolean>();
    for (const [entityId, guid] of byEntity) categories.set(categoryOf(entityId) ?? '?', guid !== undefined);
    expect(categories.get('pipe')).toBe(false);
    expect(categories.get('connection')).toBe(false);
    expect(categories.get('equipment')).toBe(true);
    expect([...categories.keys()]).toEqual(expect.arrayContaining(['pipe', 'connection', 'equipment']));
    const unmapped = data<{ warnings: Array<{ code: string; ids: string[] }> }>(doc, 'export_bcf', { snapshots: false }).warnings;
    const ids = unmapped.find((warning) => warning.code === 'VIS_BCF_GUID_UNMAPPED')?.ids ?? [];
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => byEntity.get(id) === undefined)).toBe(true);
  });

  it('export_bcf_viewpoint writes the IfcGuid of an equipment entity', () => {
    const equipment = [...byEntity].find(([entityId]) => categoryOf(entityId) === 'equipment');
    expect(equipment?.[1]).toHaveLength(22);
    const exported = data<{ visualizationInfo: string }>(doc, 'export_bcf_viewpoint', { id: 'vp-1' });
    expect(selectionOf(exported.visualizationInfo).some((component) => xmlAttr(component, 'IfcGuid') === equipment?.[1])).toBe(true);
  });

  it.each(['3.0', '2.1'] as const)('Coloring in %s carries IfcGuid once per viewpoint, the first colour winning', (version) => {
    const equipmentId = [...byEntity].find(([entityId]) => categoryOf(entityId) === 'equipment')?.[0] as string;
    const xml = bcfVisualizationXml(
      doc,
      'guid',
      { projection: 'perspective', eye: [0, 0, 0], direction: [0, 1, 0], up: [0, 0, 1], fovDeg: 50 },
      1,
      [],
      version,
      [
        { colour: 'FFFF0000', ids: [equipmentId] },
        { colour: 'FF00FF00', ids: [equipmentId] },
      ],
    );
    const parsed = readXml(xml);
    if (!parsed.ok) throw new Error('bad xml');
    const coloring = xmlChildren(xmlChildren(parsed.root, 'Components')[0] as XmlElement, 'Coloring')[0] as XmlElement;
    const colours = xmlChildren(coloring, 'Color');
    const members = (color: XmlElement): XmlElement[] =>
      version === '3.0' ? xmlChildren(xmlChildren(color, 'Components')[0] as XmlElement, 'Component') : xmlChildren(color, 'Component');
    expect(members(colours[0] as XmlElement).map((component) => xmlAttr(component, 'IfcGuid'))).toEqual([byEntity.get(equipmentId)]);
    expect(members(colours[1] as XmlElement)).toHaveLength(0);
  });
});
