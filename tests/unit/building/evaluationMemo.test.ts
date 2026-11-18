import { describe, expect, it } from 'vitest';
import type { CadDocument, Entity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { regenerateBuilding } from '@aec/building/evaluate/evaluateElements';
import type { BuildingElement, BuildingModel } from '@aec/building/types';
import { mapElements } from './elementEdits';
import { shoeDoc } from './pipeSupportFixtures';
import { step } from './steelFixtures';
import { xy } from '../../helpers/xy';

/** Steel frame + pipe run + shoe + base plates + wall, door and room: every memoized category kind that the fixtures cover. */
function mixedDoc(): CadDocument {
  let doc = step(shoeDoc(), 'add_pipe_support', { pipeId: 'pipe-1', at: [[3000, 2000, 3027.15]] });
  doc = step(doc, 'add_base_plates', {});
  doc = step(doc, 'draw_walls', { points: xy(8000, 0, 12000, 0), levelId: 'level-1' });
  doc = step(doc, 'add_door', { wallId: 'wall-1', offset: 2000, width: 900 });
  return step(doc, 'add_room', { name: 'Hall', boundary: xy(8000, 2000, 12000, 2000, 12000, 6000, 8000, 6000), levelId: 'level-1' });
}

const element = (doc: CadDocument, id: string): BuildingElement => {
  const found = doc.building?.elements[id];
  if (!found) throw new Error(id);
  return found;
};
const entitiesOf = (doc: CadDocument, id: string): Array<Entity | undefined> => element(doc, id).entityIds.map((key) => doc.entities[key]);
const idsOfCategory = (doc: CadDocument, category: BuildingElement['category']): string[] =>
  Object.values(doc.building?.elements ?? {})
    .filter((candidate) => candidate.category === category)
    .map((candidate) => candidate.id);

/** The document regenerated with every entity forgotten: nothing can be reused. */
function fromScratch(doc: CadDocument): CadDocument {
  const clone = JSON.parse(JSON.stringify(doc)) as CadDocument;
  return regenerateBuilding(clone, clone.building as BuildingModel);
}

function expectSameObjects(after: CadDocument, before: CadDocument, id: string): void {
  const [now, then] = [entitiesOf(after, id), entitiesOf(before, id)];
  expect(now.length).toBeGreaterThan(0);
  now.forEach((entity, index) => expect(entity).toBe(then[index]));
}

function expectRegenerated(after: CadDocument, before: CadDocument, id: string): void {
  const [now, then] = [entitiesOf(after, id), entitiesOf(before, id)];
  expect(now.length).toBeGreaterThan(0);
  now.forEach((entity, index) => expect(entity).not.toBe(then[index]));
}

describe('building regeneration reuses unaffected elements', () => {
  const doc = mixedDoc();

  it('the fixture covers members, plates, a pipe, a support, a wall, a door and a room', () => {
    for (const category of ['member', 'plate', 'pipe', 'pipeSupport', 'wall', 'door', 'room'] as const) {
      expect(idsOfCategory(doc, category).length).toBeGreaterThan(0);
    }
  });

  it('keeps the entity objects of every element except the edited member and its plate', () => {
    const result = execute(doc, 'update_steel_member', { memberId: 'member-1', profile: 'HEB240' });
    expect(result.affected.length).toBeGreaterThan(0);
    const edited = result.document;
    expectRegenerated(edited, doc, 'member-1');
    const plateOfEdited = idsOfCategory(doc, 'plate').find((id) => (element(doc, id) as { memberId: string }).memberId === 'member-1');
    expect(plateOfEdited).toBeDefined();
    expectRegenerated(edited, doc, plateOfEdited as string);
    const rest = Object.keys(doc.building?.elements ?? {}).filter((id) => id !== 'member-1' && id !== plateOfEdited);
    for (const id of rest) {
      if (element(doc, id).entityIds.length === 0) continue;
      // walls and curved walls are not memoized; the door / support / plate of other members must be reused
      if (element(doc, id).category === 'wall') continue;
      expectSameObjects(edited, doc, id);
    }
  });

  it('the regenerated document equals a from-scratch regeneration (entities, order, building)', () => {
    for (const [name, params] of [
      ['update_steel_member', { memberId: 'member-1', profile: 'HEB240' }],
      ['move_building_element', { elementIds: ['member-3'], delta: [0, 50] }],
      ['delete_building_element', { elementIds: ['member-2'] }],
      ['add_steel_member', { profile: 'IPE300', role: 'beam', start: [0, 0, 2000], end: [3000, 0, 2000], levelId: 'level-1' }],
    ] as const) {
      const result = execute(doc, name, params).document;
      expect(result).not.toBe(doc);
      const scratch = fromScratch(result);
      expect(result.entities).toEqual(scratch.entities);
      expect(Object.keys(result.entities)).toEqual(Object.keys(scratch.entities));
      expect(result.order).toEqual(scratch.order);
      expect(result.building).toEqual(scratch.building);
      expect(result.layers).toEqual(scratch.layers);
    }
  });

  it('an unchanged regeneration returns the same entity objects in the same order', () => {
    const again = regenerateBuilding(doc, doc.building as BuildingModel);
    expect(again.order).toEqual(doc.order);
    for (const id of idsOfCategory(doc, 'member')) expectSameObjects(again, doc, id);
  });
});

describe('building regeneration invalidates what an element reads', () => {
  const doc = mixedDoc();
  const model = doc.building as BuildingModel;
  const edit = (id: string, change: Record<string, unknown>): CadDocument =>
    regenerateBuilding(doc, { ...model, elements: { ...model.elements, [id]: { ...element(doc, id), ...change } as BuildingElement } });

  it('a level edit regenerates the elements on that level only', () => {
    const level = model.levels['level-1'];
    if (!level) throw new Error('level-1');
    const after = regenerateBuilding(doc, {
      ...model,
      levels: { ...model.levels, 'level-1': { ...level, elevation: level.elevation + 100 } },
    });
    expectRegenerated(after, doc, 'member-1');
    expectRegenerated(after, doc, 'wall-1');
    expectRegenerated(after, doc, idsOfCategory(doc, 'door')[0] as string);
    expectRegenerated(after, doc, idsOfCategory(doc, 'room')[0] as string);
    expectRegenerated(after, doc, idsOfCategory(doc, 'plate')[0] as string);
    expectSameObjects(after, doc, 'member-3');
    expect(after.entities).toEqual(fromScratch(after).entities);
  });

  it('a member edit regenerates its base plate', () => {
    const plate = idsOfCategory(doc, 'plate').find((id) => (element(doc, id) as { memberId: string }).memberId === 'member-2') as string;
    const member = element(doc, 'member-2') as { end: readonly [number, number, number] };
    const after = edit('member-2', { end: [member.end[0] + 40, member.end[1], member.end[2]] });
    expectRegenerated(after, doc, plate);
    expectRegenerated(after, doc, 'member-2');
    expectSameObjects(after, doc, 'member-1');
    expect(after.entities).toEqual(fromScratch(after).entities);
  });

  it('the wall a door sits in regenerates the door', () => {
    const door = idsOfCategory(doc, 'door')[0] as string;
    const after = edit('wall-1', { thickness: (element(doc, 'wall-1') as { thickness: number }).thickness + 50 });
    expectRegenerated(after, doc, door);
    expect(after.entities).toEqual(fromScratch(after).entities);
  });

  it('what a pipe support rests on regenerates it', () => {
    const support = idsOfCategory(doc, 'pipeSupport')[0] as string;
    const pipe = element(doc, 'pipe-1') as { diameter: number };
    const after = edit('pipe-1', { diameter: pipe.diameter * 1.5 });
    expectRegenerated(after, doc, support);
    expectRegenerated(after, doc, 'pipe-1');
    expect(after.entities).toEqual(fromScratch(after).entities);
  });

  it('a unit change regenerates unit-dependent geometry', () => {
    const inFeet: CadDocument = { ...doc, units: 'ft' };
    const after = regenerateBuilding(inFeet, model);
    expectRegenerated(after, doc, 'member-1');
  });

  it('an entity edited outside the evaluation is replaced, not reused', () => {
    const body = doc.entities['member-1:body'] as Entity;
    const tampered: CadDocument = { ...doc, entities: { ...doc.entities, 'member-1:body': { ...body, color: '#ff0000' } } };
    const after = regenerateBuilding(tampered, model);
    expect(after.entities['member-1:body']?.color).toBe(body.color);
  });

  it('mapElements-style rebuilt elements with equal content are still reused', () => {
    const rebuilt = mapElements(doc, (candidate) => JSON.parse(JSON.stringify(candidate)) as BuildingElement);
    const after = regenerateBuilding(rebuilt, rebuilt.building as BuildingModel);
    expectSameObjects(after, doc, 'member-1');
  });
});
