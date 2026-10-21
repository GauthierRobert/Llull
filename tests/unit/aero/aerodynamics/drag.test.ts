import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import refs from '../../../../docs/aerospace/10-aerodynamics/validation/data/airfoil_wing_references.json';
import { data, expectRefusal, ok } from '../../../helpers/commandAssertions';

interface Area {
  frontalAreaM2: number;
  uncertaintyM2: number;
  wettedAreaM2: number;
  lengthM: number;
}
interface Drag {
  dragN: number;
  powerW: number;
  dynamicPressurePa: number;
  pressureDragN: number;
  area: { cdA: number; frontalAreaM2?: number };
  friction?: { cf: number; dragN: number };
  reynolds?: number;
  warnings: string[];
  air: { densityKgM3: number; defaulted: boolean };
}

const empty = createEmptyDocument();

describe('frontal_area + compute_aero_drag (VC-AER-02..05)', () => {
  it('box 1000 x 600 x 400 mm: exact frontal area along each axis, wetted area, length', () => {
    const box = ok(empty, 'add_box', { size: [1000, 600, 400] });
    const id = box.affected[0] as string;
    const x = data<Area>(box.document, 'frontal_area', { entityIds: [id] });
    expect(Math.abs(x.frontalAreaM2 - 0.24)).toBeLessThan(x.uncertaintyM2 + 1e-9);
    expect(x.lengthM).toBeCloseTo(1, 9);
    expect(x.wettedAreaM2).toBeCloseTo(2 * (0.6 + 0.4 + 0.24), 9);
    const z = data<Area>(box.document, 'frontal_area', { entityIds: [id], flowDirection: [0, 0, -2], resolution: 1000 });
    expect(z.frontalAreaM2).toBeCloseTo(0.6, 3);
  });

  it('sphere r 0.5 m: πr² within the tessellation bound and the silhouette uncertainty', () => {
    const doc = { ...empty, units: 'm' as const };
    const sphere = ok(doc, 'add_sphere', { radius: 0.5 });
    const area = data<Area>(sphere.document, 'frontal_area', { entityIds: sphere.affected, resolution: 800 });
    const exact = Math.PI * 0.25;
    expect(area.frontalAreaM2).toBeLessThan(exact * 1.001);
    expect(area.frontalAreaM2).toBeGreaterThan(exact * 0.985);
    const drag = data<Drag>(sphere.document, 'compute_aero_drag', {
      speed: 10,
      cd: refs.bluff_bodies.sphereSubcriticalCd,
      entityIds: sphere.affected,
    });
    expect(Math.abs(drag.dragN / (0.5 * 1.225 * 100 * 0.47 * (drag.area.frontalAreaM2 as number)) - 1)).toBeLessThan(1e-6);
  });

  it('overlapping solids count once', () => {
    const one = ok(empty, 'add_box', { size: [100, 100, 100] });
    const two = ok(one.document, 'add_box', { size: [100, 100, 100], position: [500, 0, 0] });
    const area = data<Area>(two.document, 'frontal_area', { entityIds: [...one.affected, ...two.affected] });
    expect(area.frontalAreaM2).toBeCloseTo(0.01, 5);
  });

  it('compute_aero_drag: D = ½ρV²CdA, P = DV, flat plate Cd 1.28, km/h, altitude, skin friction (Blasius / Prandtl-Schlichting / ITTC)', () => {
    const plate = data<Drag>(empty, 'compute_aero_drag', {
      speed: 36,
      speedUnit: 'km/h',
      cd: refs.bluff_bodies.flatPlateNormalCd,
      referenceAreaM2: 1,
    });
    expect(Math.abs(plate.dragN / (0.5 * 1.225 * 100 * 1.28) - 1)).toBeLessThan(1e-6);
    expect(plate.powerW / plate.dragN).toBeCloseTo(10, 6);
    expect(plate.air.defaulted).toBe(true);
    const high = data<Drag>(empty, 'compute_aero_drag', { speed: 10, cdA: 1, altitudeM: 10000 });
    expect(high.air.densityKgM3).toBeCloseTo(0.41351, 4);
    for (const check of refs.skin_friction.checkValues)
      for (const model of ['laminar_blasius', 'turbulent_prandtl_schlichting', 'ittc_1957'] as const) {
        const length = check.re * (1.7894e-5 / (1.225 * 50));
        const friction = data<Drag>(empty, 'compute_aero_drag', {
          speed: 50,
          cdA: 0.1,
          frictionModel: model,
          wettedAreaM2: 2,
          lengthM: length,
        });
        expect(Math.abs((friction.friction?.cf as number) - check[model]) / check[model]).toBeLessThan(refs.skin_friction.acceptance.rel);
        expect(friction.dragN).toBeCloseTo(friction.pressureDragN + (friction.friction?.dragN as number), 6);
      }
    const power = data<Drag>(empty, 'compute_aero_drag', {
      speed: 10,
      cdA: 0.1,
      frictionModel: 'turbulent_power_law',
      wettedAreaM2: 1,
      lengthM: 0.1,
    });
    expect(power.friction?.cf).toBeCloseTo(0.074 / (power.reynolds as number) ** 0.2, 9);
    expect(power.warnings.join(' ')).toContain('outside');
    const fast = data<Drag>(empty, 'compute_aero_drag', { speed: 200, cdA: 0.1 });
    expect(fast.warnings.join(' ')).toContain('Mach');
  });

  it('refuses conflicting or invalid inputs', () => {
    expect(execute(empty, 'compute_aero_drag', { cdA: 1 }).error?.code).toBe('CMD_INVALID_PARAMS');
    expectRefusal(
      empty,
      'compute_aero_drag',
      { speed: 0.0015, cdA: 1, frictionModel: 'ittc_1957', wettedAreaM2: 1, lengthM: 1 },
      'AER_PARAM_INVALID',
      'lengthM',
    );
    expectRefusal(empty, 'compute_aero_drag', { speed: 10 }, 'AER_AREA_SOURCE_CONFLICT');
    expectRefusal(empty, 'compute_aero_drag', { speed: 10, cdA: 1, cd: 1 }, 'AER_AREA_SOURCE_CONFLICT');
    expectRefusal(empty, 'compute_aero_drag', { speed: 10, cdA: 1, referenceAreaM2: 1 }, 'AER_AREA_SOURCE_CONFLICT');
    expectRefusal(empty, 'compute_aero_drag', { speed: 10, cdA: -1 }, 'AER_PARAM_INVALID');
    expectRefusal(empty, 'compute_aero_drag', { speed: -1, cdA: 1 }, 'AER_PARAM_INVALID');
    expectRefusal(empty, 'compute_aero_drag', { speed: 10, cd: 1, entityIds: ['ghost'] }, 'AER_ENTITY_NOT_FOUND');
    expectRefusal(empty, 'compute_aero_drag', { speed: 10, cd: 1, entityIds: ['x'], flowDirection: [0, 0, 0] }, 'AER_PARAM_INVALID');
    expectRefusal(empty, 'compute_aero_drag', { speed: 10, cdA: 1, frictionModel: 'ittc_1957' }, 'AER_PARAM_INVALID', 'frictionModel');
    expectRefusal(empty, 'compute_aero_drag', { speed: 10, cdA: 1, densityKgM3: -1 }, 'AER_PARAM_INVALID');
    expectRefusal(empty, 'frontal_area', { entityIds: ['ghost'] }, 'AER_ENTITY_NOT_FOUND');
    expectRefusal(empty, 'frontal_area', { entityIds: ['ghost'], resolution: 10 }, 'AER_PARAM_INVALID');
    const line = ok(empty, 'draw_polyline', {
      points: [
        [0, 0],
        [1, 1],
      ],
    });
    expectRefusal(line.document, 'frontal_area', { entityIds: line.affected }, 'AER_NO_GEOMETRY');
  });
});
