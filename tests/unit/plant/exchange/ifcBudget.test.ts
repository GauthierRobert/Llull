/**
 * Plant 08 DAT-M3, §8 budget: `export_ifc` IFC4X3_ADD2 with ports stays linear in the products (the spec target is 2 000 lines / 20 000 products / 40 000 ports
 * in 15 s; the test uses a smaller scene and generous bounds so a loaded machine does not fail it).
 */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { readStep } from '@lib/stepRead';
import { getPlantData, withPlantData, type PlantObject } from '@aec/plant/data/model';
import { addPipe, libraryDocument } from '../data/dataFixtures';
import { stamp } from './ifcFixtures';

/** `lines` classified pipes of three points (two segments and a bend each), cloned straight into the building slice. */
function plantOfLines(lines: number): CadDocument {
  const one = addPipe(libraryDocument(), {
    points: [
      [0, 0, 400],
      [2000, 0, 400],
      [2000, 1000, 400],
    ],
    dn: 100,
  });
  const building = one.doc.building as NonNullable<CadDocument['building']>;
  const template = building.elements[one.id];
  if (template?.category !== 'pipe') throw new Error('no pipe');
  const ids = Array.from({ length: lines }, (_unused, k) => `pipe-bulk-${k}`);
  const elements = Object.fromEntries(
    ids.map((id, k) => [id, { ...template, id, mark: `M${k}`, points: template.points.map(([x, y, z]) => [x, y + k * 10, z]) }]),
  );
  const cloned = {
    ...one.doc,
    building: { ...building, elements: { ...building.elements, ...elements }, elementOrder: [...building.elementOrder, ...ids] },
  } as CadDocument;
  const data = getPlantData(cloned);
  const unit = data.hierarchyOrder.find((id) => data.hierarchy[id]?.code === 'U10') as string;
  const objects = ids.map(
    (id, k): PlantObject => ({
      id: `plantobj-bulk.${k}`,
      className: 'ProcessLine',
      hierarchyId: unit,
      target: { kind: 'buildingElement', id },
      tagFields: { seq: 1000 + k },
      tag: `100-P-${1000 + k}-A1A`,
      properties: { nominalSize: 100, fluidCode: 'P', spec: 'A1A' },
    }),
  );
  return withPlantData(cloned, {
    ...data,
    objects: { ...data.objects, ...Object.fromEntries(objects.map((object) => [object.id, object])) },
    objectOrder: [...data.objectOrder, ...objects.map((object) => object.id)],
  });
}

const timed = (doc: CadDocument): { ms: number; ifc: string; products: number } => {
  const started = performance.now();
  const result = execute(doc, 'export_ifc', { timestamp: stamp, schema: 'IFC4X3_ADD2' });
  const data = result.data as { ifc: string; counts: Record<string, number> };
  return {
    ms: performance.now() - started,
    ifc: data.ifc,
    products: (data.counts['IfcPipeSegment'] ?? 0) + (data.counts['IfcPipeFitting'] ?? 0),
  };
};

describe('export_ifc IFC4X3_ADD2 budget', () => {
  const small = plantOfLines(150);
  const large = plantOfLines(600);

  it('writes 601 lines (1 803 products, 3 606 ports) in a few seconds and stays linear', () => {
    const baseline = timed(small);
    const result = timed(large);
    expect(baseline.products).toBe(453);
    expect(result.products).toBe(1803);
    expect(result.ms).toBeLessThan(15_000);
    expect(result.ms / Math.max(baseline.ms, 10)).toBeLessThan(16);
    const file = readStep(result.ifc);
    expect(file.errors).toEqual([]);
    expect([...file.entities.values()].filter((entity) => entity.type === 'IFCDISTRIBUTIONPORT')).toHaveLength(3606);
  });
});
