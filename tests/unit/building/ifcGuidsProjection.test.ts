/**
 * The `ifcGuids` / `entitiesOfIfcGuid` projections of the building plugin, called directly: elements `export_ifc` writes no product for yield none,
 * an entity listed by two elements carries both, a document without a building or in another unit has no routed parts.
 */
import { describe, expect, it } from 'vitest';
import { documentProjection } from '@core/plugins/host';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { globalIdFor } from '@aec/building/exchange/ifcSeeds';
import { apply } from '../../helpers/commandAssertions';
import { scDat02Document } from '../plant/data/dataFixtures';

const guidsOf = (doc: CadDocument, entityId: string, schema: 'IFC4' | 'IFC4X3_ADD2' = 'IFC4'): readonly string[] =>
  documentProjection('ifcGuids')?.(doc, entityId, schema) ?? [];
const entitiesOf = (doc: CadDocument, guid: string): readonly string[] => documentProjection('entitiesOfIfcGuid')?.(doc, guid) ?? [];

/** `doc` with the element `id` replaced by `{ ...element, ...changes }` (a hostile or degenerate element the commands would refuse to build). */
function patched(doc: CadDocument, id: string, changes: Record<string, unknown>): CadDocument {
  const building = doc.building;
  if (building === undefined) throw new Error('no building');
  const element = building.elements[id];
  return {
    ...doc,
    building: { ...building, elements: { ...building.elements, [id]: { ...element, ...changes } } },
  } as unknown as CadDocument;
}

function withElement(doc: CadDocument, element: Record<string, unknown>): CadDocument {
  const building = doc.building;
  if (building === undefined) throw new Error('no building');
  const id = element['id'] as string;
  return {
    ...doc,
    building: { ...building, elements: { ...building.elements, [id]: element }, elementOrder: [...building.elementOrder, id] },
  } as unknown as CadDocument;
}

function framed(): { doc: CadDocument; member: string; plate: string; memberEntity: string; plateEntity: string } {
  let doc = apply(createEmptyDocument(), 'add_steel_member', { profile: 'HEA300', role: 'column', start: [0, 0, 0], end: [0, 0, 4000] });
  doc = apply(doc, 'add_base_plates', {});
  const elements = Object.values(doc.building?.elements ?? {});
  const member = elements.find((element) => element.category === 'member');
  const plate = elements.find((element) => element.category === 'plate');
  if (member === undefined || plate === undefined) throw new Error('fixture');
  return {
    doc,
    member: member.id,
    plate: plate.id,
    memberEntity: member.entityIds[0] as string,
    plateEntity: plate.entityIds[0] as string,
  };
}

describe('ifcGuids projection: degenerate elements', () => {
  it('a member with a zero-length axis, an unknown profile, or a level outside levelOrder has no GlobalId', () => {
    const { doc, member, memberEntity } = framed();
    expect(guidsOf(doc, memberEntity)).toHaveLength(1);
    expect(guidsOf(patched(doc, member, { end: [0, 0, 0] }), memberEntity)).toEqual([]);
    expect(guidsOf(patched(doc, member, { profile: 'NOPE999' }), memberEntity)).toEqual([]);
    expect(guidsOf(patched(doc, member, { levelId: 'ghost' }), memberEntity)).toEqual([]);
  });

  it('a plate without its member or level has none; with both it has the plate and its anchor group', () => {
    const { doc, plate, plateEntity } = framed();
    expect(guidsOf(doc, plateEntity)).toHaveLength(2);
    expect(guidsOf(patched(doc, plate, { memberId: 'nobody' }), plateEntity)).toEqual([]);
    expect(guidsOf(patched(doc, plate, { levelId: 'ghost' }), plateEntity)).toEqual([]);
  });

  it('a pipe with fewer than two distinct points, a tray with a zero-length run and a collinear panel have none', () => {
    const { doc } = framed();
    const level = Object.keys(doc.building?.levels ?? {})[0] as string;
    const base = { levelId: level, mark: 'X', label: 'x', entityIds: ['e-pipe'], material: 'steel' };
    let next = withElement(doc, { ...base, id: 'pipe-x', category: 'pipe', points: [[0, 0, 0]], diameter: 100, service: 's' });
    next = withElement(next, {
      ...base,
      id: 'pipe-y',
      category: 'pipe',
      entityIds: ['e-pipe-y'],
      points: [
        [1, 1, 1],
        [1, 1, 1],
      ],
      diameter: 100,
      service: 's',
    });
    next = withElement(next, {
      ...base,
      id: 'tray-x',
      category: 'tray',
      entityIds: ['e-tray'],
      points: [
        [0, 0, 0],
        [0, 0, 0],
      ],
      width: 300,
      height: 60,
      system: 'p',
    });
    next = withElement(next, {
      ...base,
      id: 'panel-x',
      category: 'panel',
      entityIds: ['e-panel'],
      corners: [
        [0, 0, 0],
        [1000, 0, 0],
        [2000, 0, 0],
      ],
      thickness: 80,
      role: 'wall',
    });
    for (const entity of ['e-pipe', 'e-pipe-y', 'e-tray', 'e-panel']) {
      expect(guidsOf(next, entity, 'IFC4')).toEqual([]);
      expect(guidsOf(next, entity, 'IFC4X3_ADD2')).toEqual([]);
    }
  });

  it('an unknown category, a door with no host wall and a pipe support with no carrier have none', () => {
    const { doc } = framed();
    const level = Object.keys(doc.building?.levels ?? {})[0] as string;
    const base = { levelId: level, mark: 'X', label: 'x' };
    let next = withElement(doc, { ...base, id: 'thing-1', category: 'wat', entityIds: ['e-thing'] });
    next = withElement(next, {
      ...base,
      id: 'door-x',
      category: 'door',
      hostId: 'wall-404',
      entityIds: ['e-door'],
      offset: 1,
      width: 900,
      height: 2100,
    });
    next = withElement(next, {
      ...base,
      id: 'support-x',
      category: 'pipeSupport',
      entityIds: ['e-support'],
      position: [0, 0],
      memberId: null,
    });
    for (const entity of ['e-thing', 'e-door', 'e-support']) expect(guidsOf(next, entity)).toEqual([]);
  });

  it('a slab writes one opening product per opening', () => {
    const { doc } = framed();
    const level = Object.keys(doc.building?.levels ?? {})[0] as string;
    const slab = {
      levelId: level,
      mark: 'S',
      label: 's',
      id: 'slab-x',
      category: 'slab',
      entityIds: ['e-slab'],
      boundary: [
        [0, 0],
        [5000, 0],
        [5000, 5000],
      ],
      thickness: 200,
      offset: 0,
      role: 'floor',
      openings: [
        [
          [1, 1],
          [2, 1],
          [2, 2],
        ],
        [
          [3, 3],
          [4, 3],
          [4, 4],
        ],
      ],
    };
    expect(guidsOf(withElement(doc, slab), 'e-slab')).toHaveLength(3);
  });
});

describe('ifcGuids projection: ownership, documents without a building, units', () => {
  it('an entity listed by two elements carries the GlobalIds of both', () => {
    const { doc, memberEntity, member, plate } = framed();
    const shared = patched(doc, plate, { entityIds: [memberEntity] });
    expect(new Set(guidsOf(shared, memberEntity))).toEqual(
      new Set([
        globalIdFor(doc.building?.uid, member),
        globalIdFor(doc.building?.uid, plate),
        globalIdFor(doc.building?.uid, `${plate}:bolts`),
      ]),
    );
  });

  it('the inverse finds the entity of a GlobalId of either schema and nothing for a foreign one', () => {
    const { doc, memberEntity, member } = framed();
    expect(entitiesOf(doc, globalIdFor(doc.building?.uid, member))).toEqual([memberEntity]);
    expect(entitiesOf(doc, 'ZZZZZZZZZZZZZZZZZZZZZZ')).toEqual([]);
  });

  it('a document without a building has no GlobalIds and resolves none', () => {
    const { building: _dropped, ...doc } = apply(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
    expect(guidsOf(doc, doc.order[0] ?? '')).toEqual([]);
    expect(entitiesOf(doc, 'ZZZZZZZZZZZZZZZZZZZZZZ')).toEqual([]);
  });

  it('routed parts carry their part GlobalId in an mm document and none in another unit', () => {
    const doc = scDat02Document();
    const routed = Object.values(doc.plant?.piping?.entityIds ?? {}).flat();
    const withGuid = routed.filter((id) => guidsOf(doc, id).length > 0);
    expect(withGuid.length).toBeGreaterThan(0);
    const metres = { ...doc, units: 'm' } as CadDocument;
    for (const id of routed) expect(guidsOf(metres, id)).toEqual([]);
  });
});

describe('globalIdFor', () => {
  it('salts the seed with the building uid, and with "llull" when there is none', () => {
    expect(globalIdFor('uid-a', 'wall-1')).not.toBe(globalIdFor('uid-b', 'wall-1'));
    expect(globalIdFor(undefined, 'wall-1')).toBe(globalIdFor('llull', 'wall-1'));
    expect(globalIdFor('uid-a', 'wall-1')).toMatch(/^[0-9A-Za-z_$]{22}$/);
  });
});
