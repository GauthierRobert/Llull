import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { EquipmentElement } from '@core/model/building';
import { buildPlanDrawing } from '@aec/planDrawing';
import { buildingErrors } from '@aec/validate';
import type { IfcExport } from '@aec/ifcBuild';

interface ScheduleTable {
  columns: string[];
  rows: unknown[][];
}

function add(doc: CadDocument, params: Record<string, unknown>): CadDocument {
  const result = execute(doc, 'add_equipment', {
    name: 'Vessel',
    location: [10, 20],
    clearance: 500,
    ...params,
  });
  expect(result.affected.length, result.summary).toBeGreaterThan(0);
  return result.document;
}

function equipment(doc: CadDocument, id: string): EquipmentElement {
  return doc.building?.elements[id] as EquipmentElement;
}

/** Vertices of the single mesh entity in the document. */
function vertices(doc: CadDocument): number[][] {
  const entity = Object.values(doc.entities).find((candidate) => candidate.kind === 'mesh') as
    | MeshSolidEntity
    | undefined;
  expect(entity).toBeDefined();
  const positions = entity!.mesh.positions;
  const points: number[][] = [];
  for (let i = 0; i < positions.length; i += 3) {
    points.push([positions[i]!, positions[i + 1]!, positions[i + 2]!]);
  }
  return points;
}

describe('equipment shape', () => {
  it('box stays a box with no shape field', () => {
    const doc = add(createEmptyDocument(), { size: [4000, 2000, 3000] });
    expect(equipment(doc, 'equipment-1').shape).toBeUndefined();
    expect(Object.values(doc.entities).some((e) => e.kind === 'box')).toBe(true);
  });

  it('vertical vessel: normalised size, cylinder mesh, summary', () => {
    const result = execute(createEmptyDocument(), 'add_equipment', {
      name: 'DT',
      location: [10, 20],
      size: [4000, 999, 12000],
      shape: 'vertical_vessel',
    });
    expect(result.summary).toMatch(/vertical vessel Ø4000 × 12000/);
    const doc = result.document;
    expect(equipment(doc, 'equipment-1')).toMatchObject({
      shape: 'vertical_vessel',
      size: [4000, 4000, 12000],
    });
    const points = vertices(doc);
    expect(points.length).toBeGreaterThanOrEqual(64);
    for (const [x, y] of points) expect(Math.hypot(x! - 10, y! - 20)).toBeCloseTo(2000, 6);
    expect(Math.min(...points.map((p) => p[2]!))).toBeCloseTo(0, 6);
    expect(Math.max(...points.map((p) => p[2]!))).toBeCloseTo(12000, 6);
  });

  it('horizontal vessel: axis along rotated x, bottom on the level', () => {
    const result = execute(createEmptyDocument(), 'add_equipment', {
      name: 'Condenser',
      location: [10, 20],
      size: [5000, 1200, 7],
      shape: 'horizontal_vessel',
      angle: Math.PI / 2,
    });
    expect(result.summary).toMatch(/horizontal vessel Ø1200 × 5000/);
    const doc = result.document;
    expect(equipment(doc, 'equipment-1').size).toEqual([5000, 1200, 1200]);
    const points = vertices(doc);
    const [xs, ys, zs] = [0, 1, 2].map((axis) => points.map((p) => p[axis]!));
    expect(Math.max(...xs!) - Math.min(...xs!)).toBeCloseTo(1200, 6);
    expect(Math.max(...ys!) - Math.min(...ys!)).toBeCloseTo(5000, 6);
    expect(Math.min(...zs!)).toBeCloseTo(0, 6);
    expect(Math.max(...zs!)).toBeCloseTo(1200, 6);
    for (const [x, , z] of points) {
      expect(Math.hypot(x! - 10, z! - 600)).toBeCloseTo(600, 6);
    }
  });

  it('rejects an unknown shape (schema) and invalid vessel sizes (no-op)', () => {
    const base = { name: 'X', location: [0, 0] };
    const doc = createEmptyDocument();
    const unknown = execute(doc, 'add_equipment', { ...base, size: [1, 1, 1], shape: 'sphere' });
    expect(unknown.affected).toEqual([]);
    expect(unknown.summary).toMatch(/rejected: invalid params/);
    for (const [shape, size] of [
      ['vertical_vessel', [0, 5, 100]],
      ['vertical_vessel', [100, 5, 0]],
      ['horizontal_vessel', [100, 0, 5]],
    ] as const) {
      const result = execute(doc, 'add_equipment', { ...base, size, shape });
      expect(result.affected, `${shape} ${size}`).toEqual([]);
      expect(result.document).toBe(doc);
      expect(result.summary).toMatch(new RegExp(`shape ${shape}`));
    }
    const short = execute(doc, 'add_equipment', {
      ...base,
      size: [100, 50],
      shape: 'horizontal_vessel',
    });
    expect(short.document).toBe(doc);
    expect(short.summary).toMatch(/rejected: invalid params — size/);
  });

  it('is pure', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'add_equipment', {
      name: 'T',
      location: [0, 0],
      size: [1000, 1000, 2000],
      shape: 'vertical_vessel',
    });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('update_equipment with values equal to the current ones is a no-op', () => {
    const doc = add(createEmptyDocument(), { size: [3000, 2000, 5000] });
    const same = execute(doc, 'update_equipment', {
      elementId: 'equipment-1',
      size: [3000, 2000, 5000],
      shape: 'box',
    });
    expect(same.document).toBe(doc);
    expect(same.affected).toEqual([]);
    expect(same.summary).toMatch(/already has these values/);
    expect(execute(doc, 'update_equipment', { elementId: 'equipment-1' }).document).toBe(doc);
  });

  it('update_equipment changes shape, keeps id, renormalises and can return to box', () => {
    const doc = add(createEmptyDocument(), { size: [3000, 2000, 5000] });
    const vertical = execute(doc, 'update_equipment', {
      elementId: 'equipment-1',
      shape: 'vertical_vessel',
    });
    expect(vertical.summary).toMatch(/vertical vessel Ø3000 × 5000/);
    expect(equipment(vertical.document, 'equipment-1')).toMatchObject({
      shape: 'vertical_vessel',
      size: [3000, 3000, 5000],
    });
    const horizontal = execute(vertical.document, 'update_equipment', {
      currentMark: 'EQ1',
      shape: 'horizontal_vessel',
      size: [6000, 1500, 0],
    });
    expect(equipment(horizontal.document, 'equipment-1').size).toEqual([6000, 1500, 1500]);
    expect(horizontal.summary).toMatch(/horizontal vessel Ø1500 × 6000/);
    const back = execute(horizontal.document, 'update_equipment', {
      elementId: 'equipment-1',
      shape: 'box',
      size: [6000, 1500, 1500],
    });
    expect(equipment(back.document, 'equipment-1').shape).toBeUndefined();
    const bad = execute(horizontal.document, 'update_equipment', {
      elementId: 'equipment-1',
      size: [6000, -1, 1],
    });
    expect(bad.affected).toEqual([]);
    expect(bad.summary).toMatch(/shape horizontal_vessel/);
    expect(
      execute(doc, 'update_equipment', { elementId: 'equipment-1', shape: 'cone' }).affected,
    ).toEqual([]);
  });

  it('plan: vertical vessel is a circle with a centre mark and tag, horizontal a rectangle', () => {
    let doc = add(createEmptyDocument(), {
      size: [4000, 0, 12000],
      shape: 'vertical_vessel',
      mark: 'DT1',
    });
    doc = add(doc, {
      location: [30, 20],
      size: [5000, 1200, 0],
      shape: 'horizontal_vessel',
      mark: 'CD1',
    });
    const plan = buildPlanDrawing(doc, undefined)!;
    const onLayer = plan.primitives.filter((p) => p.layer === 'Q-EQPM');
    const radii = onLayer.flatMap((p) => (p.type === 'circle' ? [p.radius] : []));
    expect(radii.sort((a, b) => a - b)).toEqual([2000, 2500]);
    expect(onLayer.filter((p) => p.type === 'line')).toHaveLength(2);
    expect(onLayer.filter((p) => p.type === 'polygon')).toHaveLength(2);
    expect(onLayer.some((p) => p.type === 'text' && p.content.startsWith('DT1'))).toBe(true);
    expect(onLayer.some((p) => p.type === 'text' && p.content.startsWith('CD1'))).toBe(true);
  });

  it('IFC: vessels are extruded circle profiles, boxes stay rectangles, Shape property', () => {
    let doc = add(createEmptyDocument(), { size: [4000, 0, 12000], shape: 'vertical_vessel' });
    doc = add(doc, { size: [5000, 1200, 0], shape: 'horizontal_vessel', location: [30, 20] });
    const ifc = (execute(doc, 'export_ifc', {}).data as IfcExport).ifc;
    expect(ifc.match(/IFCCIRCLEPROFILEDEF/g)).toHaveLength(2);
    expect(ifc).not.toMatch(/IFCRECTANGLEPROFILEDEF/);
    expect(ifc).toMatch(/IFCLABEL\('vertical_vessel'\)/);
    expect(ifc).toMatch(/IFCLABEL\('horizontal_vessel'\)/);
    const boxIfc = (
      execute(add(createEmptyDocument(), { size: [1, 1, 1] }), 'export_ifc', {}).data as IfcExport
    ).ifc;
    expect(boxIfc).toMatch(/IFCRECTANGLEPROFILEDEF/);
    expect(boxIfc).toMatch(/IFCLABEL\('box'\)/);
  });

  it('schedule has a Shape column; validation rejects a bad stored shape', () => {
    const doc = add(createEmptyDocument(), { size: [1000, 0, 2000], shape: 'vertical_vessel' });
    const table = execute(doc, 'building_schedule', { kind: 'equipment' }).data as ScheduleTable;
    expect(table.columns.at(-1)).toBe('Shape');
    expect(table.rows[0]!.at(-1)).toBe('vertical_vessel');
    const broken = {
      ...doc,
      building: {
        ...doc.building!,
        elements: {
          ...doc.building!.elements,
          'equipment-1': { ...equipment(doc, 'equipment-1'), shape: 'blob' },
        },
      },
    } as unknown as CadDocument;
    expect(buildingErrors(broken.building).join('\n')).toMatch(/shape must be one of/);
  });
});
