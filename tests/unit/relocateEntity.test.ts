import { afterEach, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument, type Entity, type InstanceEntity } from '@core/model/types';
import { expandInstance } from '@core/geometry/instanceExpansion';
import { fakeKernel, TETRA } from '../helpers/fakeKernel';
import { add } from '../helpers/addEntity';
import { groupedBoxes } from '../helpers/groupedBoxes';

afterEach(() => setGeometryKernel(null));

/** Two grouped boxes; the first is selected, animated, classed and has import provenance. */
function lifecycleDoc(): { doc: CadDocument; ids: [string, string]; groupId: string } {
  const { doc: grouped, ids } = groupedBoxes('Pair');
  const groupId = Object.keys(grouped.groups)[0] as string;
  let doc = execute(grouped, 'assign_material_class', { classId: 'galvanized_steel', entityIds: [ids[0]] }).document;
  doc = execute(doc, 'animate', { targetId: ids[0], mode: 'spin', speed: 1 }).document;
  doc = { ...doc, selection: [ids[0]], exchange: { provenance: { [ids[0]]: { format: 'step' } } } } as unknown as CadDocument;
  return { doc, ids, groupId };
}

function expectSurvives(doc: CadDocument, from: string, to: string, groupId: string): void {
  expect(doc.groups[groupId]?.memberIds).toContain(to);
  expect(doc.groups[groupId]?.memberIds).not.toContain(from);
  expect(doc.selection).toEqual([to]);
  expect(Object.values(doc.animations).map((a) => a.targetId)).toEqual([to]);
  expect(doc.display?.materialClassOf?.[to]).toBe('galvanized_steel');
  expect(doc.display?.materialClassOf?.[from]).toBeUndefined();
  expect(Object.keys(doc.exchange?.provenance ?? {})).toEqual([to]);
}

describe('relocating an entity is not deleting it', () => {
  it('array as instances: group, selection, animation, class and provenance follow instance 0', () => {
    const { doc, ids, groupId } = lifecycleDoc();
    const r = execute(doc, 'array_linear', { id: ids[0], count: 3, offset: [5, 0, 0], as: 'instances' });
    expect(r.affected).toHaveLength(3);
    expectSurvives(r.document, ids[0], r.affected[0] as string, groupId);
    expect(r.document.groups[groupId]?.memberIds).toHaveLength(2);
  });

  it('create_component: the same five survive on the instance', () => {
    const { doc, ids, groupId } = lifecycleDoc();
    const r = execute(doc, 'create_component', { name: 'Part', entityIds: [ids[0]] });
    expectSurvives(r.document, ids[0], r.affected[0] as string, groupId);
  });

  it('create_component of every group member dissolves the group and retargets its animation, and says so', () => {
    const { doc, ids, groupId } = lifecycleDoc();
    const animated = execute(doc, 'animate', { targetId: groupId, mode: 'spin', speed: 2 }).document;
    const r = execute(animated, 'create_component', { name: 'Both', entityIds: ids });
    const instance = r.affected[0] as string;
    expect(r.document.groups[groupId]).toBeUndefined();
    expect(Object.values(r.document.animations).every((a) => a.targetId === instance)).toBe(true);
    expect(Object.keys(r.document.animations)).toHaveLength(2);
    expect(r.summary).toContain(`Group(s) [${groupId}]`);
    expect(r.document.selection).toEqual([instance]);
  });
});

describe('array as instances: named source and instance source with rotation, scale', () => {
  it('keeps the source name on instance 0', () => {
    const { doc, id } = add(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
    const named = execute(doc, 'set_entity_name', { id, name: 'Rib' }).document;
    const r = execute(named, 'array_linear', { id, count: 2, offset: [3, 0, 0], as: 'instances' });
    expect(r.document.entities[r.affected[0] as string]?.name).toBe('Rib');
  });

  it('polar about [1,1,0] of a rotated, scaled instance equals polar copies of that instance', () => {
    const box = add(createEmptyDocument(), 'add_box', { size: [2, 1, 1], position: [1, 0, 0], rotation: [0.2, 0.1, 0.3] });
    const made = execute(box.doc, 'create_component', { name: 'C', entityIds: [box.id] });
    const placed = execute(made.document, 'insert_instance', {
      componentId: Object.keys(made.document.components)[0],
      position: [4, 2, 1],
      rotation: [0.5, -0.3, 0.9],
      scale: [2, 0.5, 3],
    });
    const seed = placed.affected[0] as string;
    const componentId = (placed.document.entities[seed] as InstanceEntity).componentId;
    const params = { id: seed, count: 4, center: [1, 1, 0], axis: [1, 1, 0], angle: Math.PI };
    const copies = execute(placed.document, 'array_polar', params);
    const inst = execute(placed.document, 'array_polar', { ...params, as: 'instances' });
    expect(inst.affected).toHaveLength(3);
    copies.affected.forEach((copyId, i) => {
      const a = expandInstance(copies.document.entities[copyId] as InstanceEntity, copies.document.components[componentId]!);
      const b = expandInstance(
        inst.document.entities[inst.affected[i] as string] as InstanceEntity,
        inst.document.components[componentId]!,
      );
      const pa = a[0] as Entity;
      const pb = b[0] as Entity;
      expect(pb.kind).toBe(pa.kind);
      if (pa.kind === 'mesh' && pb.kind === 'mesh') {
        pa.mesh.positions.forEach((v, k) => expect(pb.mesh.positions[k]).toBeCloseTo(v, 6));
      } else {
        pa.position.forEach((v, k) => expect(pb.position[k]).toBeCloseTo(v, 6));
        pa.rotation.forEach((v, k) => expect(pb.rotation[k]).toBeCloseTo(v, 6));
      }
    });
  });
});

describe('boolean on instances: orphaned component and triangle-only operands', () => {
  it('names a component left with no instance', () => {
    const plate = add(createEmptyDocument(), 'add_box', { size: [20, 20, 2] });
    const tool = add(plate.doc, 'add_box', { size: [1, 1, 5], position: [3, 3, 0] });
    const made = execute(tool.doc, 'create_component', { name: 'Tool', entityIds: [tool.id] });
    const kernel = fakeKernel({ boolean: TETRA });
    const r = execute(made.document, 'boolean', { op: 'subtract', a: plate.id, b: made.affected[0] }, { ...defaultContext(), kernel });
    expect(r.affected).toHaveLength(1);
    expect(r.summary).toMatch(/Component comp-\S+ now has no instances \(kept in the document\)/);
    expect(Object.keys(r.document.components)).toHaveLength(1);
  });

  it('refuses by name an instance of imported-mesh solids that auto would send to the mesh engine', () => {
    const plate = add(createEmptyDocument(), 'add_box', { size: [20, 20, 2] });
    const meshSolid = { ...plate.doc.entities[plate.id], id: 'tri', kind: 'mesh', mesh: TETRA } as unknown as Entity;
    const withMesh: CadDocument = { ...plate.doc, entities: { ...plate.doc.entities, tri: meshSolid }, order: [...plate.doc.order, 'tri'] };
    const made = execute(withMesh, 'create_component', { name: 'Scan', entityIds: ['tri'] });
    const meshPlate = { ...made.document.entities[plate.id], kind: 'mesh', mesh: TETRA } as unknown as Entity;
    const doc = { ...made.document, entities: { ...made.document.entities, [plate.id]: meshPlate } };
    const r = execute(doc, 'boolean', { op: 'union', a: plate.id, b: made.affected[0] });
    expect(r.affected).toEqual([]);
    expect(r.summary).toContain('run explode_instance first');
  });
});
