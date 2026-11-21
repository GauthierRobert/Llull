/**
 * Plant 08 DAT-VIS-FU2 / FU3: every IfcGuid a BCF export writes (ifcSchema IFC4 and IFC4X3_ADD2) is a GlobalId in the IFC text of THAT schema; pipes, moment
 * connections and routed pipe parts carry one per IFC product, only what export_ifc does not write (grid) carries none. Also: `export_bcf_viewpoint`,
 * and a Coloring in 3.0 and 2.1, carry IfcGuid once per viewpoint.
 */
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { globalIdFor } from '@aec/building/exchange/ifcSeeds';
import { documentProjection } from '@core/plugins/host';
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
  const first = Object.values(building.elements)[0];
  const level = first !== undefined && 'levelId' in first ? first.levelId : 'level-1';
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
      [1000, 1000, 0],
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
  const routed = Object.values(doc.plant?.piping?.entityIds ?? {}).flat();
  return apply(doc, 'create_review_issue', { title: 'All', viewpointIds: ['vp-1'], entityIds: [...owned, ...routed] });
}

type Schema = 'IFC4' | 'IFC4X3_ADD2';

const viewpointXml = (doc: CadDocument, version: '3.0' | '2.1', ifcSchema: Schema = 'IFC4'): string => {
  const exported = data<{ base64: string }>(doc, 'export_bcf', { snapshots: false, version, ifcSchema });
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

/** Entity id -> its IfcGuid values (empty when the component carries none), from the selection of the first viewpoint. */
const guidsByEntity = (doc: CadDocument, schema: Schema): Map<string, string[]> => {
  const byEntity = new Map<string, string[]>();
  for (const component of selectionOf(viewpointXml(doc, '3.0', schema))) {
    const id = xmlText(xmlChildren(component, 'AuthoringToolId')[0] as XmlElement);
    const guid = xmlAttr(component, 'IfcGuid');
    byEntity.set(id, [...(byEntity.get(id) ?? []), ...(guid === undefined ? [] : [guid])]);
  }
  return byEntity;
};

describe('BCF IfcGuid against the IFC export', () => {
  const doc = plantWithFrame();
  const byEntity = guidsByEntity(doc, 'IFC4');
  const categoryOf = (entityId: string): string | undefined =>
    Object.values(doc.building?.elements ?? {}).find((element) => element.entityIds.includes(entityId))?.category;
  const routedIds = Object.values(doc.plant?.piping?.entityIds ?? {}).flat();

  it.each(['IFC4', 'IFC4X3_ADD2'] as const)('every IfcGuid is a GlobalId in the %s text, one per IFC product', (schema) => {
    const ifc = data<{ ifc: string }>(doc, 'export_ifc', { timestamp: '2026-01-01T00:00:00', schema }).ifc;
    const present = globalIds(ifc);
    const table = guidsByEntity(doc, schema);
    const guids = [...table.values()].flat();
    expect(guids.length).toBeGreaterThan(8);
    for (const guid of guids) expect(present.has(guid), `${guid} in ${schema}`).toBe(true);
    const categories = new Map<string, number>();
    for (const [entityId, list] of table)
      categories.set(categoryOf(entityId) ?? '?', Math.max(categories.get(categoryOf(entityId) ?? '?') ?? 0, list.length));
    expect(categories.get('equipment')).toBe(1);
    expect(categories.get('connection')).toBeGreaterThanOrEqual(2);
    expect(categories.get('grid')).toBe(0);
    expect(categories.get('pipe')).toBe(schema === 'IFC4' ? 1 : 3);
    const routed = routedIds.filter((id) => (table.get(id) ?? []).length > 0);
    expect(routed.length).toBeGreaterThan(0);
  });

  it('only what export_ifc does not write is VIS_BCF_GUID_UNMAPPED', () => {
    const unmapped = data<{ warnings: Array<{ code: string; ids: string[] }> }>(doc, 'export_bcf', { snapshots: false }).warnings;
    const ids = unmapped.find((warning) => warning.code === 'VIS_BCF_GUID_UNMAPPED')?.ids ?? [];
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => (byEntity.get(id) ?? []).length === 0)).toBe(true);
    expect(ids.every((id) => categoryOf(id) === 'grid')).toBe(true);
    expect([...byEntity].filter(([id, list]) => list.length === 0 && !ids.includes(id))).toEqual([]);
  });

  it('export_bcf_viewpoint writes the IfcGuid of an equipment entity', () => {
    const equipment = [...byEntity].find(([entityId]) => categoryOf(entityId) === 'equipment');
    expect(equipment?.[1]).toHaveLength(1);
    const exported = data<{ visualizationInfo: string }>(doc, 'export_bcf_viewpoint', { id: 'vp-1' });
    expect(selectionOf(exported.visualizationInfo).some((component) => xmlAttr(component, 'IfcGuid') === equipment?.[1][0])).toBe(true);
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
    expect(members(colours[0] as XmlElement).map((component) => xmlAttr(component, 'IfcGuid'))).toEqual(byEntity.get(equipmentId));
    expect(members(colours[1] as XmlElement)).toHaveLength(0);
  });
});

describe('BCF IfcGuid of framing products', () => {
  it.each(['IFC4', 'IFC4X3_ADD2'] as const)(
    'footing, panel, tray and base plate (plate + anchors) carry GlobalIds present in the %s text',
    (schema) => {
      let doc = createEmptyDocument();
      doc = apply(doc, 'add_steel_member', { profile: 'HEA300', role: 'column', start: [0, 0, 0], end: [0, 0, 4000] });
      doc = apply(doc, 'add_base_plates', {});
      doc = apply(doc, 'add_footing', { location: [5000, 5000] });
      doc = apply(doc, 'add_panel', {
        corners: [
          [0, 0, 0],
          [3000, 0, 0],
          [3000, 0, 3000],
        ],
      });
      doc = apply(doc, 'add_cable_tray', {
        points: [
          [0, 0, 3000],
          [2000, 0, 3000],
        ],
      });
      const ids = Object.values(doc.building?.elements ?? {}).flatMap((element) => element.entityIds);
      const project = documentProjection('ifcGuids');
      const present = globalIds(data<{ ifc: string }>(doc, 'export_ifc', { timestamp: '2026-01-01T00:00:00', schema }).ifc);
      const categories = new Set<string>();
      for (const id of ids) {
        const guids = project?.(doc, id, schema) ?? [];
        for (const guid of guids) expect(present.has(guid), `${guid} in ${schema}`).toBe(true);
        const category = Object.values(doc.building?.elements ?? {}).find((element) => element.entityIds.includes(id))?.category;
        if (guids.length > 0 && category !== undefined) categories.add(category);
      }
      expect([...categories].sort()).toEqual(['footing', 'member', 'panel', 'plate', 'tray']);
    },
  );

  it('an entity no element lists, and a foreign GlobalId, resolve to nothing', () => {
    const doc = apply(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
    expect(documentProjection('ifcGuids')?.(doc, doc.order[0] ?? '', 'IFC4')).toEqual([]);
    expect(documentProjection('entitiesOfIfcGuid')?.(doc, 'ZZZZZZZZZZZZZZZZZZZZZZ')).toEqual([]);
  });
});

/** The plant fixture plus a curved wall with a door, a straight wall with a window, a slab with an opening, a stair, an access platform (grating, railing, assembly), a steel stair and a ladder. */
function completeFixture(): CadDocument {
  let doc = plantWithFrame();
  doc = apply(doc, 'add_curved_wall', { start: [60000, 0], through: [62000, 1000], end: [64000, 0] });
  const curved = doc.order.length > 0 ? Object.keys(doc.building?.elements ?? {}).find((id) => id.startsWith('curvedWall')) : undefined;
  doc = apply(doc, 'add_door', { wallId: curved as string, offset: 1000 });
  doc = apply(doc, 'draw_walls', {
    points: [
      [60000, 5000],
      [66000, 5000],
    ],
  });
  const wall = Object.keys(doc.building?.elements ?? {}).find((id) => id.startsWith('wall-')) as string;
  doc = apply(doc, 'add_window', { wallId: wall, offset: 3000 });
  doc = apply(doc, 'add_slab', {
    boundary: [
      [60000, 8000],
      [66000, 8000],
      [66000, 12000],
      [60000, 12000],
    ],
  });
  doc = apply(doc, 'add_stair', { start: [70000, 0], angle: 0, riserCount: 18, landingAt: 9 });
  doc = apply(doc, 'add_access_platform', {
    bounds: [
      [80000, 0],
      [83000, 2000],
    ],
    topOffset: 3000,
    gratingType: '19-W-4 1-1/4x3/16',
    bearingBarDirection: [1, 0],
    railing: {},
  });
  const deck = Object.keys(doc.building?.elements ?? {}).find((id) => id.startsWith('assembly')) as string;
  doc = apply(doc, 'add_steel_stair', { start: [76520, 1000, 0], angle: 0, toSurfaceId: deck, riserMax: 180, going: 280 });
  return apply(doc, 'add_ladder', { base: [81500, -250, 0], facing: [0, 1], attachTo: deck });
}

const PRODUCT_EXCLUDED =
  /^IFC(REL|PROPERTY|DISTRIBUTIONPORT|DISTRIBUTIONSYSTEM|PROJECT|SITE|BUILDING$|BUILDINGSTOREY|FACILITY|BRIDGE|ROAD|RAILWAY|MARINE|FACILITYPART|ZONE|GROUP|MATERIAL|UNIT|SIUNIT)/;

describe('BCF IfcGuid covers every product export_ifc writes', () => {
  const doc = completeFixture();
  it.each(['IFC4', 'IFC4X3_ADD2'] as const)('every product GlobalId of the %s file is an IfcGuid of some entity', (schema) => {
    const ifc = data<{ ifc: string }>(doc, 'export_ifc', { timestamp: '2026-01-01T00:00:00', schema }).ifc;
    const project = documentProjection('ifcGuids');
    const entityIds = [
      ...Object.values(doc.building?.elements ?? {}).flatMap((element) => element.entityIds),
      ...Object.values(doc.plant?.piping?.entityIds ?? {}).flat(),
    ];
    /** An element with no entity of its own (the platform assembly) has nothing a BCF component can name: its product is exempt. */
    const entityless = Object.values(doc.building?.elements ?? {})
      .filter((element) => element.entityIds.length === 0)
      .map((element) => globalIdFor(doc.building?.uid, element.id));
    const known = new Set([...entityIds.flatMap((id) => project?.(doc, id, schema) ?? []), ...entityless]);
    const missing = [...readStep(ifc).entities.values()]
      .filter((entity) => /^IFC[A-Z0-9]+$/.test(entity.type) && !PRODUCT_EXCLUDED.test(entity.type))
      .flatMap((entity) => {
        const guid = stepString(entity.args[0] as string);
        return guid === undefined || guid.length !== 22 || known.has(guid) ? [] : [`${entity.type} ${String(entity.args[2])}`];
      });
    expect(missing).toEqual([]);
    const categories = new Set(Object.values(doc.building?.elements ?? {}).map((element) => element.category));
    for (const category of ['curvedWall', 'door', 'window', 'slab', 'stair', 'grating', 'railing', 'ladder', 'steelStair', 'assembly'])
      expect(categories.has(category as never), category).toBe(true);
  });
});
