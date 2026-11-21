import { afterEach, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { setGeometryKernel, type StepOccurrence } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument, type InstanceEntity } from '@core/model/types';
import { expandInstance } from '@core/geometry/instanceExpansion';
import { fakeKernel, TETRA, type FakeShape } from '../helpers/fakeKernel';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';
import { add } from '../helpers/addEntity';

afterEach(() => setGeometryKernel(null));

const boxDoc = (
  position: [number, number, number] = [3, 0, 0],
  rotation: [number, number, number] = [0, 0, 0.4],
): { doc: CadDocument; id: string } => add(createEmptyDocument(), 'add_box', { size: [2, 1, 1], position, rotation });

const worldPose = (doc: CadDocument, id: string): { position: number[]; rotation: number[] } => {
  const instance = doc.entities[id] as InstanceEntity;
  const [child] = expandInstance(instance, doc.components[instance.componentId]!);
  return { position: [...child!.position], rotation: [...child!.rotation] };
};
const close = (a: readonly number[], b: readonly number[]): void => b.forEach((v, i) => expect(a[i]).toBeCloseTo(v, 9));

describe('array_* as instances', () => {
  it('array_linear: one component, count instances, source becomes instance 0', () => {
    const { doc, id } = boxDoc();
    const r = execute(doc, 'array_linear', { id, count: 4, offset: [10, 0, 0], as: 'instances' });
    expect(r.affected).toHaveLength(4);
    expect(Object.keys(r.document.components)).toHaveLength(1);
    const [compId] = Object.keys(r.document.components);
    expect(r.document.entities[id]).toBeUndefined();
    expect(r.document.order).toHaveLength(4);
    r.affected.forEach((instanceId, k) => {
      expect((r.document.entities[instanceId] as InstanceEntity).componentId).toBe(compId);
      close(worldPose(r.document, instanceId).position, [3 + 10 * k, 0, 0]);
      expect(r.document.order).toContain(instanceId);
    });
    expect(r.document.entities[r.affected[1]!]?.patternSourceId).toBe(r.affected[0]);
    expect(r.summary).toMatch(/as instances: 4 instance\(s\)/);
  });

  it('array_polar instances land exactly where copies mode puts its copies (z axis and tilted axis)', () => {
    for (const axis of [undefined, [1, 1, 0]]) {
      const { doc, id } = boxDoc([4, 1, 2], [0.2, 0.3, 0.4]);
      const params = { id, count: 5, center: [1, -1, 0.5], angle: Math.PI * 1.5, ...(axis ? { axis } : {}) };
      const copies = execute(doc, 'array_polar', params);
      const inst = execute(doc, 'array_polar', { ...params, as: 'instances' });
      expect(inst.affected).toHaveLength(5);
      copies.affected.forEach((copyId, i) => {
        const copy = copies.document.entities[copyId]!;
        const pose = worldPose(inst.document, inst.affected[i + 1]!);
        close(pose.position, copy.position);
        close(pose.rotation, copy.rotation);
      });
    }
  });

  it('an instance source keeps its component and stays instance 0', () => {
    const { doc, id } = boxDoc();
    const first = execute(doc, 'array_linear', { id, count: 2, offset: [0, 5, 0], as: 'instances' });
    const seed = first.affected[1]!;
    const r = execute(first.document, 'array_polar', { id: seed, count: 3, center: [0, 0, 0], as: 'instances' });
    expect(r.affected).toHaveLength(2);
    expect(Object.keys(r.document.components)).toHaveLength(1);
    expect(r.document.entities[seed]).toBeDefined();
    expect(r.summary).toMatch(/is instance 0/);
  });

  it('is pure and deterministic, and copies stays the default', () => {
    const { doc, id } = boxDoc();
    const params = { id, count: 3, offset: [1, 0, 0], as: 'instances' };
    expectPure(doc, () => execute(doc, 'array_linear', params));
    expect(execute(doc, 'array_linear', params).affected).toEqual(execute(doc, 'array_linear', params).affected);
    const plain = execute(doc, 'array_linear', { id, count: 3, offset: [1, 0, 0] });
    expect(Object.keys(plain.document.components)).toHaveLength(0);
  });

  it('refuses a 2D source with ARRAY_SOURCE_NOT_SOLID and a missing component', () => {
    const { doc, id } = add(createEmptyDocument(), 'draw_rectangle', { width: 2, height: 1 });
    const r = execute(doc, 'array_linear', { id, count: 3, offset: [1, 0, 0], as: 'instances' });
    expectNoOp(r, doc, 'ARRAY_SOURCE_NOT_SOLID');
    expect(r.error?.code).toBe('ARRAY_SOURCE_NOT_SOLID');
    const polar = execute(doc, 'array_polar', { id, count: 3, center: [0, 0, 0], as: 'instances' });
    expect(polar.error?.code).toBe('ARRAY_SOURCE_NOT_SOLID');
    const solid = boxDoc();
    const made = execute(solid.doc, 'array_linear', { id: solid.id, count: 2, offset: [1, 0, 0], as: 'instances' });
    const orphan = { ...made.document, components: {} };
    expectNoOp(
      execute(orphan, 'array_linear', { id: made.affected[1], count: 2, offset: [1, 0, 0], as: 'instances' }),
      orphan,
      'not found',
    );
  });

  it('mass of the instanced pattern equals the copies pattern', () => {
    const { doc, id } = boxDoc();
    const p = { id, count: 3, offset: [10, 0, 0] };
    const inst = execute(doc, 'array_linear', { ...p, as: 'instances' });
    const copies = execute(doc, 'array_linear', p);
    const volume = (d: CadDocument, ids: readonly string[]): number =>
      ids.reduce((sum, i) => sum + ((execute(d, 'mass_properties', { entityId: i }).data as { volume: number }).volume ?? 0), 0);
    expect(volume(inst.document, inst.affected)).toBeCloseTo(volume(copies.document, [id, ...copies.affected]), 9);
  });
});

describe('boolean on instances (kernel boundary expansion)', () => {
  const setup = (): { doc: CadDocument; plate: string; instances: string[] } => {
    const base = add(createEmptyDocument(), 'add_box', { size: [50, 50, 5] });
    const tool = add(base.doc, 'add_cylinder', { radius: 1, height: 10, position: [5, 5, 0] });
    const arr = execute(tool.doc, 'array_linear', { id: tool.id, count: 3, offset: [10, 0, 0], as: 'instances' });
    return { doc: arr.document, plate: base.id, instances: arr.affected };
  };

  it('subtracts a list of instances in one kernel boolean', () => {
    const { doc, plate, instances } = setup();
    const kernel = fakeKernel({ boolean: TETRA });
    const r = execute(doc, 'boolean', { op: 'subtract', a: plate, b: instances }, { ...defaultContext(), kernel });
    expect(r.affected).toHaveLength(1);
    expect(r.document.entities[r.affected[0]!]?.kind).toBe('mesh');
    for (const gone of [plate, ...instances]) expect(r.document.entities[gone]).toBeUndefined();
    expect(Object.keys(r.document.components)).toHaveLength(1);
  });

  it('refuses the mesh engine, a missing component and no kernel', () => {
    const { doc, plate, instances } = setup();
    const kernel = fakeKernel({ boolean: TETRA });
    const ctx = { ...defaultContext(), kernel };
    expect(execute(doc, 'boolean', { op: 'subtract', a: plate, b: instances, engine: 'mesh' }, ctx).summary).toMatch(
      /mesh engine needs solids/,
    );
    const orphan = { ...doc, components: {} };
    const r = execute(orphan, 'boolean', { op: 'subtract', a: plate, b: instances[0] }, ctx);
    expect(r.affected).toEqual([]);
    expect(r.summary).toMatch(/no buildable solids/);
    expect(execute(doc, 'boolean', { op: 'subtract', a: plate, b: instances[0] }, { ...defaultContext(), kernel: null }).affected).toEqual(
      [],
    );
  });
});

describe('exchange of an instanced pattern', () => {
  it('export_gltf gpu writes one instanced node of count instances', () => {
    const { doc, id } = boxDoc();
    const r = execute(doc, 'array_polar', { id, count: 6, center: [0, 0, 0], as: 'instances' });
    const data = execute(r.document, 'export_gltf', { instancing: 'gpu' }).data as Record<string, unknown>;
    expect(data['instanceCount']).toBe(6);
    expect(data['instancedNodeCount']).toBe(1);
    expect(JSON.parse(data['text'] as string).extensionsUsed).toContain('EXT_mesh_gpu_instancing');
  });

  it('export_step_ap242 writes one shared part with one occurrence per instance', () => {
    const { doc, id } = boxDoc();
    const r = execute(doc, 'array_linear', { id, count: 4, offset: [5, 0, 0], as: 'instances' });
    let seen: readonly StepOccurrence<FakeShape>[] = [];
    const kernel = fakeKernel({
      assemblyStep: (occurrences) => {
        seen = occurrences;
        return 'TEXT';
      },
    });
    const out = execute(r.document, 'export_step_ap242', { includeValidationProperties: false }, { ...defaultContext(), kernel });
    expect(seen).toHaveLength(4);
    expect(new Set(seen.map((o) => o.part)).size).toBe(1);
    expect(out.summary).toContain('4 occurrence(s)');
  });
});
