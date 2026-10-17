import { describe, expect, it } from 'vitest';
import { combineMassProperties, meshMassProperties, type MassProperties } from '@core/geometry/massProperties';
import { resolveMassProperties } from '@core/geometry/resolveMassProperties';
import { solidTriangles } from '@core/geometry/solidTriangles';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument, type Entity } from '@core/model/types';

const entityMassProperties = (
  e: Entity,
  doc: Pick<CadDocument, 'components'>,
  densityOf: (solid: Entity) => number,
): MassProperties | null => resolveMassProperties(doc, e, densityOf, {})?.properties ?? null;

function solid(command: string, params: Record<string, unknown>): Entity {
  const result = execute(createEmptyDocument(), command, params);
  const id = result.affected[0];
  if (id === undefined) throw new Error(result.summary);
  return result.document.entities[id] as Entity;
}

const relative = (actual: number, expected: number): number => Math.abs(actual - expected) / Math.abs(expected);

describe('meshMassProperties', () => {
  it('is exact for a box: m = ρabc, Ixx = m(b²+c²)/12, centred', () => {
    const box = solid('add_box', { size: [2, 3, 4], position: [1, 2, 3] });
    const props = meshMassProperties(solidTriangles(box), 5);
    if (!props) throw new Error('no props');
    expect(props.mass).toBeCloseTo(5 * 24, 9);
    expect(props.centerOfMass[0]).toBeCloseTo(1, 9);
    expect(props.centerOfMass[1]).toBeCloseTo(2, 9);
    expect(props.centerOfMass[2]).toBeCloseTo(3, 9);
    const m = 120;
    expect(props.inertia[0]).toBeCloseTo((m * (9 + 16)) / 12, 8);
    expect(props.inertia[1]).toBeCloseTo((m * (4 + 16)) / 12, 8);
    expect(props.inertia[2]).toBeCloseTo((m * (4 + 9)) / 12, 8);
    for (const product of props.inertia.slice(3)) expect(Math.abs(product)).toBeLessThan(1e-9);
  });

  it('tessellated curved solids stay within 5 % of the closed forms (why primitives use exact formulas)', () => {
    const cylinder = meshMassProperties(solidTriangles(solid('add_cylinder', { radius: 1, height: 2 })), 1);
    const sphere = meshMassProperties(solidTriangles(solid('add_sphere', { radius: 2 })), 1);
    expect(relative(cylinder?.mass ?? 0, Math.PI * 2)).toBeLessThan(0.05);
    expect(relative(sphere?.mass ?? 0, (4 / 3) * Math.PI * 8)).toBeLessThan(0.05);
  });

  it('accepts inward winding and rejects empty meshes', () => {
    const box = solid('add_box', { size: [1, 1, 1] });
    const flipped = solidTriangles(box).map(([a, b, c]) => [a, c, b] as const);
    expect(meshMassProperties(flipped, 1)?.mass).toBeCloseTo(1, 9);
    expect(meshMassProperties(flipped, 1)?.inertia[0]).toBeCloseTo(1 / 6, 9);
    expect(meshMassProperties([], 1)).toBeNull();
  });

  it('combines parts with the parallel-axis theorem (two unit cubes 2 apart: Iyy = 2(1/6) + 2·1·1²)', () => {
    const left = meshMassProperties(solidTriangles(solid('add_box', { size: [1, 1, 1], position: [-1, 0, 0] })), 1);
    const right = meshMassProperties(solidTriangles(solid('add_box', { size: [1, 1, 1], position: [1, 0, 0] })), 1);
    if (!left || !right) throw new Error('no props');
    const both = combineMassProperties([left, right]);
    expect(both?.mass).toBeCloseTo(2, 9);
    expect(both?.centerOfMass[0]).toBeCloseTo(0, 9);
    expect(both?.inertia[0]).toBeCloseTo(2 / 6, 9);
    expect(both?.inertia[1]).toBeCloseTo(2 / 6 + 2, 9);
    expect(combineMassProperties([])).toBeNull();
  });
});

describe('entityMassProperties', () => {
  const noComponents = { components: {} };
  const unit = (): number => 1;

  it('uses the exact cylinder formulas, rotated into world axes (axis along X: Ixx = mr²/2)', () => {
    const cylinder = solid('add_cylinder', { radius: 1, height: 2, axis: [1, 0, 0], position: [5, 0, 0] });
    const props = entityMassProperties(cylinder, noComponents, unit);
    const mass = Math.PI * 2;
    expect(props?.mass).toBeCloseTo(mass, 12);
    expect(props?.centerOfMass[0]).toBeCloseTo(5, 12);
    expect(props?.inertia[0]).toBeCloseTo(mass / 2, 9);
    expect(props?.inertia[1]).toBeCloseTo((mass * 7) / 12, 9);
    expect(props?.inertia[2]).toBeCloseTo((mass * 7) / 12, 9);
  });

  it('a rotated box keeps its trace (rotation-invariant) and gains products of inertia', () => {
    const box = solid('add_box', { size: [4, 1, 1] });
    const turned = { ...box, rotation: [0, 0, Math.PI / 4] } as Entity;
    const props = entityMassProperties(turned, noComponents, unit);
    if (!props) throw new Error('no props');
    // m = 4: Ixx = 4·2/12, Iyy = Izz = 4·17/12 → trace = 12
    expect(props.inertia[0] + props.inertia[1] + props.inertia[2]).toBeCloseTo(12, 9);
    expect(Math.abs(props.inertia[3])).toBeGreaterThan(0.1);
    expect(entityMassProperties(solid('add_sphere', { radius: 1 }), noComponents, () => 3)?.mass).toBeCloseTo(4 * Math.PI, 9);
  });

  it('integrates free-form solids from their mesh and skips 2D shapes and dangling instances', () => {
    const loft = solid('loft_sections', {
      sections: [
        { center: [0, 0, 0], radius: 1 },
        { center: [0, 0, 2], radius: 1 },
      ],
    });
    const props = entityMassProperties(loft, noComponents, unit);
    expect(relative(props?.mass ?? 0, Math.PI * 2)).toBeLessThan(0.05);
    expect(entityMassProperties(solid('draw_arc', { center: [0, 0], radius: 1 }), noComponents, unit)).toBeNull();
    const dangling = { id: 'inst', kind: 'instance', componentId: 'missing' } as unknown as Entity;
    expect(entityMassProperties(dangling, noComponents, unit)).toBeNull();
  });
});
