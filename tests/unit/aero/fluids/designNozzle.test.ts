import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import contour from '../../../../docs/aerospace/11-fluid-dynamics-propulsion/validation/data/nozzle_contour_references.json';
import { raoAngles } from '@aero/fluids/designNozzleCommand';
import { data, expectRefusal, ok } from '../../../helpers/commandAssertions';

interface Design {
  id: string;
  exitRadius: number;
  chamberRadius: number;
  expansionRatioCheck: number;
  divergentLength: number;
  referenceConeLength15: number;
  contour: Array<{ axial: number; radius: number; angleDeg: number }>;
  defaulted: string[];
}

const doc = createEmptyDocument();

function design(params: Record<string, unknown>): { doc: CadDocument; result: Design } {
  const run = ok(doc, 'design_nozzle', { includeContour: true, ...params });
  return { doc: run.document, result: run.data as Design };
}

describe('design_nozzle (VC-FLD-20..22)', () => {
  it('80 % Rao bell at ε 25: exit radius, chart angles, length 0.8 of the 15° cone, throat at radius R_t, monotone after the throat', () => {
    const { doc: next, result } = design({ throatRadius: 50, expansionRatio: 25, wallThickness: 4 });
    expect(next.entities[result.id]?.kind).toBe('revolution');
    expect(result.expansionRatioCheck).toBeCloseTo(25, 9);
    expect(result.exitRadius).toBeCloseTo(250, 9);
    expect(result.chamberRadius).toBeCloseTo(50 * Math.sqrt(3), 7);
    expect(result.divergentLength / result.referenceConeLength15).toBeCloseTo(0.8, 9);
    const throat = result.contour.reduce((min, point) => (point.radius < min.radius ? point : min));
    expect(throat.radius).toBeCloseTo(50, 9);
    expect(throat.axial).toBeCloseTo(0, 9);
    const divergent = result.contour.filter((point) => point.axial > 0);
    divergent
      .slice(1)
      .forEach((point, index) => expect(point.radius).toBeGreaterThanOrEqual((divergent[index] as Design['contour'][0]).radius));
    const chart = contour.rao80Angles.points.find((point) => point.eps === 24.97) as { thetaN: number };
    expect(Math.abs(divergent.reduce((max, point) => Math.max(max, point.angleDeg), 0) - chart.thetaN)).toBeLessThan(0.2);
    expect((result.contour.at(-1) as Design['contour'][0]).angleDeg).toBeCloseTo(8.78, 1);
    const second = contour.rao80Angles.secondSource.exitAngleDegAtEps25.bell80;
    expect(Math.abs((result.contour.at(-1) as Design['contour'][0]).angleDeg - second)).toBeLessThan(0.5);
    expect(result.defaulted.join(' ')).toContain('Huzel');
  });

  it('chart lookup interpolates between the digitised points and is held at the ends', () => {
    expect(raoAngles(9.93)?.entranceDeg).toBeCloseTo(25.21, 9);
    expect(raoAngles(5)?.entranceDeg).toBeCloseTo(22.57, 9);
    expect(raoAngles(50.2)?.exitDeg).toBeCloseTo(7.72, 9);
    expect(raoAngles(4)).toBeNull();
  });

  it('conical 15° nozzle: straight divergent at the half angle; the wall volume matches the revolved section', () => {
    const { doc: next, result } = design({
      throatRadius: 20,
      expansionRatio: 9,
      shape: 'conical',
      wallThickness: 2,
      chamberLength: 30,
      contractionRatio: 4,
      position: [0, 0, 100],
    });
    const last = result.contour.at(-1) as Design['contour'][0];
    expect(last.radius).toBeCloseTo(60, 9);
    expect(last.angleDeg).toBeCloseTo(15, 9);
    expect(result.contour[0]?.radius).toBeCloseTo(40, 9);
    const inner = result.contour.map((point): [number, number] => [point.radius, point.axial]);
    const outer = result.contour.map((point): [number, number] => {
      const angle = (point.angleDeg * Math.PI) / 180;
      return [point.radius + 2 * Math.cos(angle), point.axial - 2 * Math.sin(angle)];
    });
    const section = [...inner, ...outer.reverse()];
    let area = 0;
    let moment = 0;
    section.forEach(([r1, z1], index) => {
      const [r2, z2] = section[(index + 1) % section.length] as [number, number];
      const cross = r1 * z2 - r2 * z1;
      area += cross / 2;
      moment += ((r1 + r2) * cross) / 6;
    });
    const pappus = 2 * Math.PI * Math.abs(moment);
    const mass = data<{ volume: number }>(next, 'mass_properties', { entityId: result.id });
    expect(Math.abs(mass.volume / pappus - 1)).toBeLessThan(2e-3);
    expect(Math.abs(area)).toBeGreaterThan(0);
  });

  it('bell with explicit angles and length fraction; refusals', () => {
    const { result } = design({
      throatRadius: 10,
      expansionRatio: 100,
      lengthFraction: 0.9,
      entranceAngleDeg: 35,
      exitAngleDeg: 6,
      wallThickness: 1,
    });
    expect(result.divergentLength / result.referenceConeLength15).toBeCloseTo(0.9, 9);
    expectRefusal(
      doc,
      'design_nozzle',
      { throatRadius: 10, expansionRatio: 100, wallThickness: 1 },
      'FLD_PARAM_INVALID',
      'entranceAngleDeg',
    );
    expectRefusal(doc, 'design_nozzle', { throatRadius: 0, expansionRatio: 10, wallThickness: 1 }, 'FLD_PARAM_INVALID', 'throatRadius');
    expectRefusal(doc, 'design_nozzle', { throatRadius: 10, expansionRatio: 10, wallThickness: 5 }, 'FLD_PARAM_INVALID', 'wallThickness');
    expectRefusal(
      doc,
      'design_nozzle',
      { throatRadius: 10, expansionRatio: 10, wallThickness: 1, convergentHalfAngleDeg: 80 },
      'FLD_PARAM_INVALID',
    );
    expectRefusal(
      doc,
      'design_nozzle',
      { throatRadius: 10, expansionRatio: 10, wallThickness: 1, shape: 'conical', halfAngleDeg: 40 },
      'FLD_PARAM_INVALID',
    );
    expectRefusal(
      doc,
      'design_nozzle',
      { throatRadius: 10, expansionRatio: 10, wallThickness: 1, lengthFraction: 0.3 },
      'FLD_PARAM_INVALID',
    );
    expectRefusal(
      doc,
      'design_nozzle',
      { throatRadius: 10, expansionRatio: 10, wallThickness: 1, entranceAngleDeg: 5, exitAngleDeg: 10 },
      'FLD_PARAM_INVALID',
    );
    expectRefusal(
      doc,
      'design_nozzle',
      { throatRadius: 10, expansionRatio: 10, wallThickness: 1, contractionRatio: 1.5, convergentHalfAngleDeg: 60 },
      'FLD_CONTOUR_INVALID',
    );
    expectRefusal(
      doc,
      'design_nozzle',
      { throatRadius: 10, expansionRatio: 10, wallThickness: 1, entranceAngleDeg: 59, exitAngleDeg: 58 },
      'FLD_CONTOUR_INVALID',
    );
  });

  it('is pure', () => {
    const before = structuredClone(doc);
    design({ throatRadius: 50, expansionRatio: 25, wallThickness: 4 });
    expect(doc).toEqual(before);
  });
});

describe('rocket_delta_v (VC-FLD-30)', () => {
  it('Tsiolkovsky: Δv = Isp g0 ln(m0/mf), burn time, inverse for a target Δv', () => {
    const result = data<{ deltaVMS: number; burnTimeS: number; massFlowKgS: number }>(doc, 'rocket_delta_v', {
      ispS: 450,
      initialMassKg: 1000,
      propellantMassKg: 800,
      thrustN: 1e5,
    });
    expect(result.deltaVMS).toBeCloseTo(450 * 9.80665 * Math.log(5), 6);
    expect(result.massFlowKgS).toBeCloseTo(1e5 / (450 * 9.80665), 6);
    expect(result.burnTimeS).toBeCloseTo(800 / (1e5 / (450 * 9.80665)), 6);
    const inverse = data<{ propellantMassKg: number }>(doc, 'rocket_delta_v', {
      ispS: 450,
      initialMassKg: 1000,
      targetDeltaVMS: result.deltaVMS,
    });
    expect(inverse.propellantMassKg).toBeCloseTo(800, 6);
    const byFinal = data<{ deltaVMS: number }>(doc, 'rocket_delta_v', { ispS: 300, initialMassKg: 10, finalMassKg: 5 });
    expect(byFinal.deltaVMS).toBeCloseTo(300 * 9.80665 * Math.log(2), 5);
  });

  it('refuses invalid masses', () => {
    expectRefusal(doc, 'rocket_delta_v', { ispS: 0, initialMassKg: 10, finalMassKg: 5 }, 'FLD_PARAM_INVALID', 'ispS');
    expectRefusal(doc, 'rocket_delta_v', { ispS: 300, initialMassKg: 10 }, 'FLD_INPUT_CONFLICT');
    expectRefusal(doc, 'rocket_delta_v', { ispS: 300, initialMassKg: 10, propellantMassKg: 10 }, 'FLD_PARAM_INVALID', 'propellantMassKg');
    expectRefusal(doc, 'rocket_delta_v', { ispS: 300, initialMassKg: 10, finalMassKg: 11 }, 'FLD_PARAM_INVALID', 'finalMassKg');
    expectRefusal(doc, 'rocket_delta_v', { ispS: 300, initialMassKg: 10, targetDeltaVMS: -1 }, 'FLD_PARAM_INVALID');
    expectRefusal(doc, 'rocket_delta_v', { ispS: 300, initialMassKg: 10, finalMassKg: 5, thrustN: 0 }, 'FLD_PARAM_INVALID', 'thrustN');
  });

  it('honours color (LIM-1 #5b): the nozzle solid takes it; a malformed colour is refused', () => {
    const { doc: next, result } = design({ throatRadius: 20, expansionRatio: 9, shape: 'conical', wallThickness: 2, color: '#b87333' });
    expect(next.entities[result.id]?.color).toBe('#b87333');
    expectRefusal(
      doc,
      'design_nozzle',
      { throatRadius: 20, expansionRatio: 9, wallThickness: 2, color: 'copper' },
      'FLD_PARAM_INVALID',
      'color',
    );
  });
});
