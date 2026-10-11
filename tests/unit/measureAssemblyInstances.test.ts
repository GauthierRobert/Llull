import { describe, it, expect } from 'vitest';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

function assembly(scale?: number[]): { doc: CadDocument; instanceId: string; boxId: string } {
  const box = execute(createEmptyDocument(), 'add_box', { size: [2, 2, 2] });
  const sphere = execute(box.document, 'add_sphere', { radius: 1, position: [10, 0, 0] });
  const component = execute(sphere.document, 'create_component', {
    name: 'Part',
    entityIds: [box.affected[0]!, sphere.affected[0]!],
    componentId: 'comp-part',
  });
  const inserted = execute(component.document, 'insert_instance', {
    componentId: 'comp-part',
    position: [100, 0, 0],
    ...(scale ? { scale } : {}),
  });
  return { doc: inserted.document, instanceId: inserted.affected[0]!, boxId: box.affected[0]! };
}

const data = <T>(result: { data?: unknown }): T => result.data as T;

describe('measure commands on assembly instances', () => {
  it('measure_volume sums the component solids', () => {
    const { doc, instanceId } = assembly();
    const result = execute(doc, 'measure_volume', { entityId: instanceId });
    expect(data<{ volume: number }>(result).volume).toBeCloseTo(8 + (4 / 3) * Math.PI);
  });

  it('measure_volume scales with the instance scale (cubed)', () => {
    const { doc, instanceId } = assembly([2, 2, 2]);
    const result = execute(doc, 'measure_volume', { entityId: instanceId });
    expect(data<{ volume: number }>(result).volume).toBeCloseTo((8 + (4 / 3) * Math.PI) * 8);
  });

  it('mass_properties uses the density param for unassigned parts', () => {
    const { doc, instanceId } = assembly();
    const result = execute(doc, 'mass_properties', { entityId: instanceId, density: 2 });
    expect(data<{ mass: number }>(result).mass).toBeCloseTo(2 * (8 + (4 / 3) * Math.PI));
    expect(result.summary).toContain('assembly');
  });

  it('mass_properties uses an instance material when the parts have none', () => {
    const { doc, instanceId } = assembly();
    const withMaterial = execute(
      execute(doc, 'create_material', {
        name: 'steel',
        density: 5,
        color: '#b0b0b0',
        metalness: 1,
        roughness: 0.4,
      }).document,
      'assign_material',
      { materialName: 'steel', entityIds: [instanceId] },
    ).document;
    const result = execute(withMaterial, 'mass_properties', { entityId: instanceId, density: 1 });
    expect(data<{ mass: number }>(result).mass).toBeCloseTo(5 * (8 + (4 / 3) * Math.PI));
  });

  it('measure_bounding_box measures the baked instance, not the origin', () => {
    const { doc, instanceId } = assembly();
    const result = execute(doc, 'measure_bounding_box', { entityId: instanceId });
    const { min, max } = data<{ min: number[]; max: number[] }>(result);
    expect(min[0]).toBeCloseTo(99);
    expect(max[0]).toBeCloseTo(111);
  });

  it('whole-document bounding box includes instances', () => {
    const { doc } = assembly();
    const result = execute(doc, 'measure_bounding_box', {});
    expect(data<{ max: number[] }>(result).max[0]).toBeCloseTo(111);
  });

  it('an instance whose component is missing is a graceful no-op', () => {
    const { doc, instanceId } = assembly();
    const broken: CadDocument = { ...doc, components: {} };
    for (const [name, params] of [
      ['measure_volume', { entityId: instanceId }],
      ['mass_properties', { entityId: instanceId, density: 1 }],
    ] as const) {
      const result = execute(broken, name, params);
      expect(result.data).toBeUndefined();
      expect(result.affected).toEqual([]);
      expect(result.summary).toContain('missing component');
    }
  });
});
