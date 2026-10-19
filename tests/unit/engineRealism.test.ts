/**
 * PHY-21 M3b realism laws without a physics engine: accuracy envelope, friction law, brake calibration (VC-FPR-15 analytic side), sourced
 * materials (VC-30, 36), gear and propeller declarations, reference data and the E / U_val comparison with a synthetic S (VC-31, 34),
 * propeller table interpolation, plausibility bands, load validation of the new slices, loop tiers (VC-35).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { EngineLosses, PropellerLoad } from '@core/model/dynamics';
import { type ReferenceData } from '@core/model/prototype';
import { accuracy, bandText, combineContributions } from '@core/dynamics/accuracy';
import { fmepAt, fmepBand, ownsCylinder } from '@core/dynamics/engine/engineLosses';
import { advanceRatio, pchipAt, propellerCoefficients } from '@core/dynamics/propellerTable';
import { propellerOutput } from '@core/dynamics/forceLaws';
import { combustionOrigin } from '@core/dynamics/engine/combustionOrigin';
import { comparePoint, summariseComparison } from '@core/dynamics/engine/referenceComparison';
import { REFERENCE_PRESET_NAMES, REFERENCE_PRESETS } from '@core/dynamics/engine/referencePresets';
import { isRotaxReduction, outsideBand } from '@core/dynamics/engine/plausibility';
import { idealGearWarnings } from '@core/dynamics/gearLoss';
import { sourcedMaterial } from '@core/commands/document/sourcedMaterials';
import { bodyMassProperties, buildSimulationModel } from '@core/dynamics/simulationModel';
import { setEngineLossLaw } from '@core/dynamics/engineLossHook';
import { realismOf, setRealismLaw } from '@core/commands/dynamics/realismHook';
import { installEngineLaws } from '@core/commands/dynamics/engine/hooks';
import { validateMaterialValue } from '@core/commands/persistence/guards';
import { residualTier } from '@core/dynamics/reactions';
import { dynamicsProblems } from '@core/commands/persistence/dynamicsValidation';
import { prototypeProblems } from '@core/commands/persistence/prototypeValidation';
import { RATED_BRAKE_TORQUE_NM, RATED_RPM, CHEN_FLYNN, calibratedEngine, singleZone, step, BORE_MM } from './engineRealismFixture';
import { sliderCrank } from './sliderCrankFixture';

const expectedCases = (): { id: string; value: number | number[]; tolerance: Record<string, number | boolean> }[] => {
  const file = fileURLToPath(new URL('../../docs/physics/21-functional-prototype/validation/expected_results.json', import.meta.url));
  return (JSON.parse(readFileSync(file, 'utf8')) as { cases: never[] }).cases;
};
const caseOf = (id: string): { value: number | number[]; tolerance: Record<string, number | boolean> } => {
  const found = expectedCases().find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no ${id} in expected_results.json`);
  return found;
};

describe('accuracy envelope (FR-FPR-70, TR-FPR-14)', () => {
  it('independent contributions combine by root-sum-square against the result', () => {
    const band = combineContributions(
      [
        { band: { rel: 0.001 }, value: 33 },
        { band: { rel: 0.13 }, value: 2.7 },
      ],
      30.25,
    );
    const expected = Math.hypot(0.001 * 33, 0.13 * 2.7) / 30.25;
    expect(band).toEqual({ rel: expect.closeTo(expected, 12) });
  });

  it('an absolute band is taken against its own contribution and a missing band stays null, never 0', () => {
    expect(combineContributions([{ band: { abs: 1, unit: 'N·m' }, value: 100 }], 100)).toEqual({ rel: expect.closeTo(0.01, 12) });
    expect(
      combineContributions(
        [
          { band: { rel: 0.01 }, value: 10 },
          { band: null, value: 5 },
        ],
        5,
      ),
    ).toBeNull();
    expect(combineContributions([], 5)).toBeNull();
    expect(combineContributions([{ band: { rel: 0.1 }, value: 1 }], 0)).toBeNull();
    expect(combineContributions([{ band: { abs: 1, unit: 'N' }, value: 0 }], 1)).toBeNull();
  });

  it('states a missing band explicitly as "± ?"', () => {
    expect(bandText(null)).toBe('± ?');
    expect(bandText({ rel: 0.13 })).toBe('± 13 %');
    expect(bandText({ abs: 1, unit: 'N·m' })).toBe('± 1 N·m');
    expect(accuracy(null, 'x', 'predicted').validationLevel).toBe(0);
  });
});

describe('friction law (FR-FPR-71)', () => {
  const chen: EngineLosses = { id: 'l', crank: 'c', cylinders: [], oilTempFactor: 1, model: { ...CHEN_FLYNN, kind: 'chen_flynn' } };
  const table: EngineLosses = {
    id: 't',
    crank: 'c',
    cylinders: ['a'],
    oilTempFactor: 2.1,
    model: {
      kind: 'fmep_table',
      points: [
        [2000, 1e5],
        [4000, 1.4e5],
      ],
      source: 'test',
    },
  };

  it('chen_flynn is A + B p_max + C n + D n²; the oil factor multiplies; its stated band is 13 %', () => {
    const value = fmepAt(chen, 5800, 6.5e6);
    expect(value.pa).toBeCloseTo(40_000 + 0.005 * 6.5e6 + 5 * 5800 + 1.5e-6 * 5800 ** 2, 6);
    expect(fmepAt({ ...chen, oilTempFactor: 2.1 }, 5800, 6.5e6).pa).toBeCloseTo(2.1 * value.pa, 6);
    expect(fmepBand(chen).band).toEqual({ rel: 0.13 });
  });

  it('fmep_table interpolates, clamps and flags speeds outside it (FPR_OUTSIDE_VALIDATED_RANGE); no band is stated', () => {
    expect(fmepAt(table, 3000, 0).pa).toBeCloseTo(2.1 * 1.2e5, 6);
    expect(fmepAt(table, 4000, 0)).toEqual({ pa: expect.closeTo(2.1 * 1.4e5, 6), outsideRange: false });
    expect(fmepAt(table, 1000, 0)).toEqual({ pa: expect.closeTo(2.1 * 1e5, 6), outsideRange: true });
    expect(fmepAt(table, 5000, 0).outsideRange).toBe(true);
    expect(fmepBand(table).band).toBeNull();
  });

  it('an empty list means every cylinder on the crank; a list restricts it', () => {
    expect(ownsCylinder(chen, { id: 'x', crank: 'c' })).toBe(true);
    expect(ownsCylinder(chen, { id: 'x', crank: 'other' })).toBe(false);
    expect(ownsCylinder(table, { id: 'a', crank: 'c' })).toBe(true);
    expect(ownsCylinder(table, { id: 'b', crank: 'c' })).toBe(false);
  });
});

describe('set_engine_losses', () => {
  const { doc } = sliderCrank();

  it('stores one record per crank with its source, defaults the oil factor and cylinders, and is pure', () => {
    const before = structuredClone(doc);
    const result = execute(doc, 'set_engine_losses', { crank: 'crank_j', model: CHEN_FLYNN });
    expect(doc).toEqual(before);
    expect(result.affected).toHaveLength(1);
    const record = result.document.dynamics?.losses?.[result.affected[0] ?? ''];
    expect(record).toMatchObject({ crank: 'crank_j', cylinders: [], oilTempFactor: 1, model: { kind: 'chen_flynn', aPa: 40_000 } });
    expect(result.summary).toContain('± 13 %');
  });

  it('refuses the component model as unsupported and never approximates it (§11 Q8)', () => {
    const result = execute(doc, 'set_engine_losses', { crank: 'crank_j', model: { kind: 'component', source: 'x' } });
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
    expect(result.error?.code).toBe('FPR_LOSS_MODEL_UNSUPPORTED');
  });

  it('no-ops on a bad crank, a missing source or constants, a bad table, a foreign cylinder and a second record', () => {
    const noop = (params: Record<string, unknown>): string => {
      const result = execute(doc, 'set_engine_losses', params);
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      return result.summary;
    };
    expect(noop({ crank: 'nope', model: CHEN_FLYNN })).toMatch(/not found/);
    expect(noop({ crank: 'slide_j', model: CHEN_FLYNN })).toMatch(/must be a revolute/);
    expect(noop({ crank: 'crank_j', model: { ...CHEN_FLYNN, source: ' ' } })).toMatch(/needs a source/);
    expect(noop({ crank: 'crank_j', model: { kind: 'chen_flynn', source: 's', aPa: 1 } })).toMatch(/needs aPa, bRatio/);
    expect(noop({ crank: 'crank_j', model: { kind: 'fmep_table', source: 's', points: [[1000, 1e5]] } })).toMatch(/at least 2/);
    expect(
      noop({
        crank: 'crank_j',
        model: {
          kind: 'fmep_table',
          source: 's',
          points: [
            [2000, 1e5],
            [1000, 1e5],
          ],
        },
      }),
    ).toMatch(/strictly increasing/);
    expect(noop({ crank: 'crank_j', model: CHEN_FLYNN, cylinders: ['cyl-1'] })).toMatch(/cylinder pressure 'cyl-1' not found/);
    const once = execute(doc, 'set_engine_losses', { crank: 'crank_j', model: CHEN_FLYNN, id: 'loss-a' }).document;
    expect(execute(once, 'set_engine_losses', { crank: 'crank_j', model: CHEN_FLYNN }).summary).toMatch(
      /already has engine losses 'loss-a'/,
    );
    expect(execute(once, 'set_engine_losses', { crank: 'crank_j', model: CHEN_FLYNN, id: 'crank' }).summary).toMatch(
      /already has|already used/,
    );
  });

  it('delete_dynamics_item removes the record with its crank joint and shares the id space', () => {
    const withLoss = execute(doc, 'set_engine_losses', { crank: 'crank_j', model: CHEN_FLYNN, id: 'loss-a' }).document;
    expect(execute(withLoss, 'set_engine_losses', { crank: 'rod_j', model: CHEN_FLYNN, id: 'loss-a' }).summary).toMatch(/already used/);
    const removed = execute(withLoss, 'delete_dynamics_item', { id: 'crank_j' });
    expect(removed.document.dynamics?.losses).toEqual({});
    const direct = execute(withLoss, 'delete_dynamics_item', { id: 'loss-a' });
    expect(direct.document.dynamics?.losses).toEqual({});
    expect(direct.document.dynamics?.joints['crank_j']).toBeDefined();
  });
});

describe('brake calibration at declaration (VC-FPR-15, FR-FPR-72 / 78)', () => {
  const { doc, cylinder } = calibratedEngine();

  it('calibrates the single-zone heat release so brake torque meets the target, stored as a heat table with the calibrated speed marked', () => {
    const model = doc.dynamics?.cylinders?.[cylinder]?.model;
    expect(model?.kind).toBe('single_zone');
    if (model?.kind !== 'single_zone') return;
    expect(model.heat.kind).toBe('table_vs_rpm');
    expect(model.calibratedRpm).toEqual([RATED_RPM]);
  });

  it('engine_quick_check reproduces the calibrated brake torque within 0.5 % and tags it calibrated (VC-FPR-15b)', () => {
    const quick = execute(doc, 'engine_quick_check', { cylinder, rpm: RATED_RPM, displacementCm3: 1352.12 });
    const data = quick.data as {
      brake: { brakeTorqueNm: number; bmepBar: number; fmepBar: number; mechanicalEfficiency: number };
      accuracy: Record<string, { origin: string; validationLevel: number; band: unknown }>;
    };
    expect(Math.abs(data.brake.brakeTorqueNm - RATED_BRAKE_TORQUE_NM) / RATED_BRAKE_TORQUE_NM).toBeLessThan(0.005);
    expect(data.brake.bmepBar).toBeCloseTo(caseOf('VC-FPR-15a').value as number, 1);
    expect(data.brake.mechanicalEfficiency).toBeGreaterThan(0.85);
    expect(data.accuracy['brakeTorqueNm']).toMatchObject({ origin: 'calibrated', validationLevel: 1 });
    expect(quick.summary).toMatch(/Brake 121\.\d+ N·m.*calibrated/);
    // indicated torque is IMEP-based; brake = indicated - friction
    const mean = (quick.data as { mean: { meanTorqueNm: number } }).mean.meanTorqueNm;
    expect(mean).toBeGreaterThan(data.brake.brakeTorqueNm);
  });

  it('a speed away from the calibration point is a prediction with no stated gas-side band', () => {
    const quick = execute(doc, 'engine_quick_check', { cylinder, rpm: 4000 });
    const data = quick.data as { accuracy: Record<string, { origin: string; band: unknown; basis: string; warnings: string[] }> };
    expect(data.accuracy['meanTorqueNm']).toMatchObject({ origin: 'predicted', band: null });
    expect(data.accuracy['meanTorqueNm']?.basis).toMatch(/no quantitative uncertainty estimate/);
    expect(data.accuracy['brakeTorqueNm']?.band).toBeNull();
    expect(data.accuracy['brakeTorqueNm']?.warnings.join(' ')).toMatch(/rigid bodies/);
  });

  it('without a speed there is no brake figure, only the indicated one; parameter-only checks say their MEP is an input', () => {
    const noSpeed = execute(doc, 'engine_quick_check', { cylinder });
    expect((noSpeed.data as { brake?: unknown }).brake).toBeUndefined();
    const given = execute(doc, 'engine_quick_check', { crankRadiusMm: 30.5, rodLengthMm: 130, mepBar: 10, displacementCm3: 338 });
    const data = given.data as { accuracy: Record<string, { origin: string; band: unknown }> };
    expect(data.accuracy['meanTorqueNm']).toMatchObject({ origin: 'input', band: null });
    expect(data.accuracy['kinematics']).toBeDefined();
  });

  it('refuses a brake target without engine losses (FPR_NO_LOSSES) and one that cannot be reached', () => {
    const plain = sliderCrank({ rMm: 30.5, lMm: 130 }).doc;
    const request = (target: Record<string, unknown>, from: CadDocument): ReturnType<typeof execute> =>
      execute(from, 'add_cylinder_pressure', {
        piston: 'slide_j',
        crank: 'crank_j',
        boreMm: BORE_MM,
        compressionRatio: 10.8,
        model: singleZone({ kind: 'calibrate_brake', brake: [target] }),
      });
    const noLosses = request({ rpm: 5800, brakeTorqueNm: 30 }, plain);
    expect(noLosses.affected).toEqual([]);
    expect(noLosses.error?.code).toBe('FPR_NO_LOSSES');
    const withLoss = execute(plain, 'set_engine_losses', { crank: 'crank_j', model: CHEN_FLYNN }).document;
    const unreachable = request({ rpm: 5800, brakeTorqueNm: 1e7 }, withLoss);
    expect(unreachable.affected).toEqual([]);
    expect(['FPR_CALIBRATION_FAILED', 'FPR_PRESSURE_MODEL_INVALID']).toContain(unreachable.error?.code);
  });

  it('calibrate_brake needs the mechanism geometry and a points list, and is pure', () => {
    const bare = createEmptyDocument();
    const result = execute(bare, 'add_cylinder_pressure', {
      piston: 'slide_j',
      crank: 'crank_j',
      boreMm: BORE_MM,
      compressionRatio: 10.8,
      model: singleZone({ kind: 'calibrate_brake' }),
    });
    expect(result.affected).toEqual([]);
    const plain = sliderCrank({ rMm: 30.5, lMm: 130 }).doc;
    const before = structuredClone(plain);
    const noPoints = execute(plain, 'add_cylinder_pressure', {
      piston: 'slide_j',
      crank: 'crank_j',
      boreMm: BORE_MM,
      compressionRatio: 10.8,
      model: singleZone({ kind: 'calibrate_brake' }),
    });
    expect(noPoints.summary).toMatch(/calibrate_brake/);
    expect(plain).toEqual(before);
  });

  it('two calibration points are interpolated in rpm and both marked', () => {
    const plain = sliderCrank({ rMm: 30.5, lMm: 130 }).doc;
    const withLoss = execute(plain, 'set_engine_losses', { crank: 'crank_j', model: CHEN_FLYNN }).document;
    const result = execute(withLoss, 'add_cylinder_pressure', {
      piston: 'slide_j',
      crank: 'crank_j',
      boreMm: BORE_MM,
      compressionRatio: 10.8,
      model: singleZone({
        kind: 'calibrate_brake',
        brake: [
          { rpm: 5800, brakeTorqueNm: 30.25 },
          { rpm: 3500, brakeTorqueNm: 28.6 },
        ],
        cylinderCount: 1,
      }),
    });
    const model = result.document.dynamics?.cylinders?.[result.affected[0] ?? '']?.model;
    expect(model?.kind === 'single_zone' && model.calibratedRpm).toEqual([3500, 5800]);
    expect(result.summary).toMatch(/3500 rpm → .*5800 rpm → /);
    const quick = execute(result.document, 'engine_quick_check', { cylinder: result.affected[0], rpm: 3500, displacementCm3: 338.05 });
    expect((quick.data as { brake: { brakeTorqueNm: number } }).brake.brakeTorqueNm).toBeCloseTo(28.6, 0);
    const between = execute(result.document, 'engine_quick_check', { cylinder: result.affected[0], rpm: 4500, displacementCm3: 338.05 });
    expect((between.data as { accuracy: Record<string, { origin: string }> }).accuracy['brakeTorqueNm']?.origin).toBe('predicted');
  });

  it('combustionOrigin: a table is input, a model at a calibrated speed (within 1 % or 25 rpm) is calibrated, else predicted', () => {
    const model = doc.dynamics?.cylinders?.[cylinder]?.model;
    if (model === undefined) throw new Error('no model');
    expect(combustionOrigin([model], 5800)).toBe('calibrated');
    expect(combustionOrigin([model], 5820)).toBe('calibrated');
    expect(combustionOrigin([model], 5000)).toBe('predicted');
    expect(
      combustionOrigin(
        [
          {
            kind: 'table',
            points: [
              [0, 1],
              [720, 1],
            ],
          },
        ],
        100,
      ),
    ).toBe('input');
  });
});

describe('sourced materials (FR-FPR-73, VC-FPR-30, 36)', () => {
  const cube = (): { doc: CadDocument; id: string } => step(createEmptyDocument(), 'add_box', { size: [50, 50, 50] });

  it('al_4032 is created from the catalogue with its source and grade; a 50 mm cube weighs 0.335 kg and is not "unsourced" (VC-30)', () => {
    const { doc, id } = cube();
    const assigned = execute(doc, 'assign_material', { materialName: 'al_4032', entityIds: [id] });
    expect(assigned.affected).toEqual([id]);
    expect(assigned.summary).toMatch(/sourced catalogue \(grade B\).*Smiths/);
    const material = assigned.document.materials['al_4032'];
    expect(material).toMatchObject({ grade: 'B' });
    expect(material?.source).toMatch(/E-R32/);
    const body = { id: 'b', entityIds: [id], fixed: false };
    const props = bodyMassProperties(assigned.document, body);
    if ('error' in props) throw new Error(props.error);
    expect(props.mass).toBeCloseTo(caseOf('VC-FPR-30').value as number, 6);
    expect(props.densityDefaulted).toBe(false);
    expect(props.unverifiedReasons).toEqual([]);
    expect(props.densitySources.join(' ')).toMatch(/source: Smiths/);
  });

  it('steel_4340 is 7850 kg/m³; the input document is untouched; an unknown name and prototype keys are still refused', () => {
    const { doc, id } = cube();
    const before = structuredClone(doc);
    const steel = execute(doc, 'assign_material', { materialName: 'steel_4340', entityIds: [id] });
    expect(doc).toEqual(before);
    const props = bodyMassProperties(steel.document, { id: 'b', entityIds: [id], fixed: false });
    if ('error' in props) throw new Error(props.error);
    expect(props.mass).toBeCloseTo(7850 * 0.05 ** 3, 6);
    for (const name of ['mystery_alloy', 'constructor', '__proto__']) {
      const refused = execute(doc, 'assign_material', { materialName: name, entityIds: [id] });
      expect(refused.affected).toEqual([]);
      expect(refused.document).toBe(doc);
    }
    expect(sourcedMaterial(doc, 'toString')).toBeNull();
  });

  it('a body with no material is flagged FPR_MASS_DEFAULTED (warn) and its mass unverified (VC-36)', () => {
    const { doc, id } = cube();
    const body = step(doc, 'add_rigid_body', { entityIds: [id], id: 'b' });
    const props = bodyMassProperties(body.doc, { id: 'b', entityIds: [id], fixed: false });
    if ('error' in props) throw new Error(props.error);
    expect(props.densityDefaulted).toBe(true);
    expect(props.unverifiedReasons.length).toBeGreaterThan(0);
    const check = execute(body.doc, 'check_dynamics', {}).data as { items: { code: string; status: string }[] };
    expect(check.items.find((item) => item.code === 'FPR_MASS_DEFAULTED')?.status).toBe('warn');
    const sourced = execute(body.doc, 'assign_material', { materialName: 'steel_4340', entityIds: [id] }).document;
    const after = execute(sourced, 'check_dynamics', {}).data as { items: { code: string; status: string }[] };
    expect(after.items.find((item) => item.code === 'FPR_MASS_DEFAULTED')?.status).toBe('pass');
  });
});

describe('gear couplings with tooth counts and efficiency (FR-FPR-74)', () => {
  const twoShafts = (): CadDocument => {
    let doc = createEmptyDocument();
    const a = step(doc, 'add_cylinder', { radius: 80, height: 20, axis: [0, 0, 1], position: [0, 0, 0] });
    const b = step(a.doc, 'add_cylinder', { radius: 150, height: 15, axis: [0, 0, 1], position: [0, 300, 0] });
    doc = step(b.doc, 'add_rigid_body', { entityIds: [a.id], massKg: 2, id: 'crank' }).doc;
    doc = step(doc, 'add_rigid_body', { entityIds: [b.id], massKg: 2, id: 'prop' }).doc;
    doc = step(doc, 'add_body_joint', { kind: 'revolute', child: 'crank', anchor: [0, 0, 0], axis: [0, 0, 1], id: 'crank_j' }).doc;
    return step(doc, 'add_body_joint', { kind: 'revolute', child: 'prop', anchor: [0, 300, 0], axis: [0, 0, 1], id: 'prop_j' }).doc;
  };

  it('tooth counts give the exact ratio z_driver / z_driven (21/51), reversed for an external mesh, with the efficiency stored', () => {
    const doc = twoShafts();
    const result = execute(doc, 'add_gear_coupling', { driver: 'crank_j', driven: 'prop_j', teeth: [21, 51], efficiency: 0.99 });
    const gear = Object.values(result.document.dynamics?.gears ?? {})[0];
    expect(gear).toMatchObject({ ratio: 21 / 51, efficiency: 0.99, teeth: [21, 51] });
    expect(result.summary).toMatch(/teeth 21\/51.*efficiency 0.99/);
    const reversed = execute(doc, 'add_gear_coupling', { driver: 'crank_j', driven: 'prop_j', teeth: [21, 51], reverseRotation: true });
    expect(Object.values(reversed.document.dynamics?.gears ?? {})[0]?.ratio).toBeCloseTo(-21 / 51, 12);
    expect(reversed.summary).toMatch(/ideal/);
    expect(
      idealGearWarnings(
        reversed.document.dynamics ?? { gravity: [0, 0, 0], bodies: {}, joints: {}, gears: {}, motors: {}, propellers: {} },
      ),
    ).toHaveLength(1);
    expect(
      idealGearWarnings(result.document.dynamics ?? { gravity: [0, 0, 0], bodies: {}, joints: {}, gears: {}, motors: {}, propellers: {} }),
    ).toEqual([]);
  });

  it('refuses neither ratio nor teeth, disagreeing ones, and an efficiency outside (0, 1]; a ratio alone still works', () => {
    const doc = twoShafts();
    const bad = (params: Record<string, unknown>): string => {
      const result = execute(doc, 'add_gear_coupling', { driver: 'crank_j', driven: 'prop_j', ...params });
      expect(result.affected).toEqual([]);
      return result.summary;
    };
    expect(bad({})).toMatch(/ratio or tooth counts/);
    expect(bad({ ratio: 0.5, teeth: [21, 51] })).toMatch(/disagrees/);
    expect(bad({ ratio: 0.5, efficiency: 1.2 })).toMatch(/invalid params/);
    expect(bad({ ratio: 0.5, efficiency: 0 })).toMatch(/invalid params/);
    const plain = execute(doc, 'add_gear_coupling', { driver: 'crank_j', driven: 'prop_j', ratio: 0.5 });
    expect(Object.values(plain.document.dynamics?.gears ?? {})[0]).toEqual(expect.objectContaining({ ratio: 0.5 }));
    expect(Object.values(plain.document.dynamics?.gears ?? {})[0]).not.toHaveProperty('efficiency');
  });
});

describe('propeller coefficient table (FR-FPR-75)', () => {
  const base: PropellerLoad = {
    id: 'p',
    joint: 'j',
    diameter: 1.75,
    thrustCoefficient: 0.1,
    powerCoefficient: 0.05,
    airDensity: 1.225,
    thrustDirection: [0, 1, 0],
  };
  const table = {
    points: [
      [0.2, 0.1, 0.06],
      [0.4, 0.08, 0.065],
      [0.6, 0.05, 0.06],
      [0.8, 0.0, 0.04],
    ] as PropellerLoad['table'] extends infer T ? (T extends { points: infer P } ? P : never) : never,
    source: 'test table',
    grade: 'C' as const,
  };

  it('PCHIP passes through its nodes, stays inside the data range (monotone) and clamps at the ends', () => {
    const xs = [0, 1, 2, 3, 4];
    const ys = [0, 0.1, 0.9, 1, 1];
    xs.forEach((x, i) => expect(pchipAt(xs, ys, x)).toBeCloseTo(ys[i] ?? 0, 12));
    for (let x = 0; x <= 4; x += 0.05) {
      const value = pchipAt(xs, ys, x);
      expect(value).toBeGreaterThanOrEqual(-1e-12);
      expect(value).toBeLessThanOrEqual(1 + 1e-12);
    }
    expect(pchipAt(xs, ys, -3)).toBe(0);
    expect(pchipAt(xs, ys, 9)).toBe(1);
    // monotone data never overshoots: a flat run stays flat
    expect(pchipAt([0, 1, 2, 3], [0, 1, 1, 1], 2.5)).toBeCloseTo(1, 12);
    expect(pchipAt([0, 2], [1, 3], 1)).toBeCloseTo(2, 12);
    expect(pchipAt([], [], 1)).toBe(0);
  });

  it('keeps the shape at turning points and steep ends: no overshoot beyond the neighbouring data, at either end', () => {
    const within = (xs: number[], ys: number[]): void => {
      for (let i = 1; i < xs.length; i++)
        for (let f = 0; f <= 1; f += 0.05) {
          const x = (xs[i - 1] ?? 0) + f * ((xs[i] ?? 0) - (xs[i - 1] ?? 0));
          const [low, high] = [Math.min(ys[i - 1] ?? 0, ys[i] ?? 0), Math.max(ys[i - 1] ?? 0, ys[i] ?? 0)];
          // a turning point or an end slope may bend the curve, but never beyond a third of the span past its end values
          const slack = 0.34 * (high - low) + 1e-12;
          expect(pchipAt(xs, ys, x)).toBeGreaterThanOrEqual(low - slack);
          expect(pchipAt(xs, ys, x)).toBeLessThanOrEqual(high + slack);
        }
    };
    within([0, 1, 2, 3], [0, 1, 0.5, 0.6]); // a local maximum: the slope there is zero
    within([0, 1, 2], [0, 1, 5]); // a steeper second interval: the three-point end slope has the wrong sign
    within([0, 1, 2], [0, 1, -5]); // opposite slopes: the end slope is capped at three times the first difference
    within([0, 1, 2], [-5, 1, 0]); // the same shapes mirrored, for the end slope at the right
    within([0, 1, 2], [5, 1, 0]);
    within([0, 1, 2], [1, 0, 5]);
    expect(pchipAt([0, 1, 2, 3], [0, 1, 0.5, 0.6], 1)).toBe(1);
    expect(pchipAt([0, 1, 2], [0, 1, 5], 0.5)).toBeGreaterThan(0);
  });

  it('J = V / (n D); J = 0 and propellers without a table keep the static pair', () => {
    expect(advanceRatio({ ...base, airspeedMps: 40, table }, (2400 * 2 * Math.PI) / 60)).toBeCloseTo(40 / (40 * 1.75), 9);
    expect(advanceRatio({ ...base, airspeedMps: 40 }, 0)).toBe(0);
    const staticPair = propellerCoefficients({ ...base, table }, 100);
    expect(staticPair).toMatchObject({ thrustCoefficient: 0.1, powerCoefficient: 0.05, tabulated: false, outsideTable: false });
    expect(propellerCoefficients({ ...base, airspeedMps: 40 }, 100).tabulated).toBe(false);
  });

  it('J > 0 reads the table (interpolated, held beyond the last J, flagged outside) and drives thrust, power and torque', () => {
    const omega = (2400 * 2 * Math.PI) / 60;
    const n = 2400 / 60;
    const propeller: PropellerLoad = { ...base, airspeedMps: 0.5 * n * 1.75, table };
    const coefficients = propellerCoefficients(propeller, omega);
    expect(coefficients.advanceRatio).toBeCloseTo(0.5, 12);
    expect(coefficients.thrustCoefficient).toBeLessThan(0.08);
    expect(coefficients.thrustCoefficient).toBeGreaterThan(0.05);
    expect(coefficients.outsideTable).toBe(false);
    const output = propellerOutput(propeller, omega);
    expect(output.thrust).toBeCloseTo(coefficients.thrustCoefficient * 1.225 * n * n * 1.75 ** 4, 9);
    expect(output.torque).toBeCloseTo((coefficients.powerCoefficient * 1.225 * n * n * 1.75 ** 5) / (2 * Math.PI), 9);
    expect(output.power).toBeCloseTo(output.torque * omega, 9);
    expect(output.advanceRatio).toBeCloseTo(0.5, 12);
    const fast = propellerOutput({ ...propeller, airspeedMps: 1.2 * n * 1.75 }, omega);
    expect(fast.outsideTable).toBe(true);
    expect(fast.thrust).toBeCloseTo(0, 9);
    expect(propellerOutput(base, omega)).not.toHaveProperty('advanceRatio');
  });

  it('add_propeller stores the table, airspeed and inertia, and refuses a table without source, unordered J or an airspeed without a table', () => {
    const { doc } = sliderCrank();
    const params = { joint: 'crank_j', diameter: 1.75, thrustCoefficient: 0.1, powerCoefficient: 0.05 };
    const before = structuredClone(doc);
    const ok = execute(doc, 'add_propeller', {
      ...params,
      airspeedMps: 30,
      inertiaKgM2: 0.25,
      table: { points: table.points, source: 'test table', grade: 'B' },
    });
    expect(doc).toEqual(before);
    const stored = Object.values(ok.document.dynamics?.propellers ?? {})[0];
    expect(stored).toMatchObject({ airspeedMps: 30, inertiaKgM2: 0.25, table: { grade: 'B', source: 'test table' } });
    expect(ok.summary).toMatch(/Ct\/Cp table of 4 points.*inertia 0.25/);
    const refuse = (extra: Record<string, unknown>): string => {
      const result = execute(doc, 'add_propeller', { ...params, ...extra });
      expect(result.affected).toEqual([]);
      return result.summary;
    };
    expect(refuse({ table: { points: table.points, source: ' ' } })).toMatch(/non-empty source/);
    expect(
      refuse({
        table: {
          points: [
            [0.4, 0.1, 0.1],
            [0.2, 0.1, 0.1],
          ],
          source: 's',
        },
      }),
    ).toMatch(/strictly increase/);
    expect(
      refuse({
        table: {
          points: [
            [-0.1, 0.1, 0.1],
            [0.2, 0.1, 0.1],
          ],
          source: 's',
        },
      }),
    ).toMatch(/strictly increase/);
    expect(refuse({ airspeedMps: 20 })).toMatch(/needs a Ct \/ Cp table/);
    const defaulted = execute(doc, 'add_propeller', { ...params, table: { points: table.points, source: 's' } });
    expect(Object.values(defaulted.document.dynamics?.propellers ?? {})[0]?.table?.grade).toBe('C');
  });
});

describe('reference data (FR-FPR-77, §11 Q9)', () => {
  const emptyDoc = createEmptyDocument();

  it('ships the five public presets with sources, grades and calibration points; the preset name is the id', () => {
    for (const name of REFERENCE_PRESET_NAMES) {
      const result = execute(emptyDoc, 'add_reference_data', { preset: name });
      expect(result.affected).toEqual([name]);
      const stored = result.document.prototype?.references?.[name];
      expect(stored?.source.length).toBeGreaterThan(20);
      expect(['A', 'B', 'C']).toContain(stored?.grade);
      expect(stored?.points.length).toBeGreaterThan(0);
      expect(stored?.bandRel).toBe(0.05);
      expect(result.summary).toContain(stored?.source ?? 'x');
    }
    expect(REFERENCE_PRESETS.rotax_912uls_full_throttle.calibrationRpm).toEqual([5800]);
    expect(REFERENCE_PRESETS.o320a_full_throttle.calibrationRpm).toEqual([2700]);
    expect(
      execute(emptyDoc, 'add_reference_data', { preset: 'rotax_912_static_rpm_window' }).document.prototype?.references?.[
        'rotax_912_static_rpm_window'
      ]?.points,
    ).toEqual([{ value: 5450, min: 5100, max: 5800 }]);
  });

  it('the Rotax ULS torque preset reproduces the VC-FPR-31 reference BMEP of the pack within 0.1 bar (BMEP = 4 pi T / V_d, 1352 cm³)', () => {
    const preset = REFERENCE_PRESETS.rotax_912uls_full_throttle;
    const expected = caseOf('VC-FPR-31').value as number[];
    expect(preset.points.map((point) => point.rpm)).toEqual([2500, 3000, 3500, 4000, 4500, 5000, 5100, 5500, 5800]);
    preset.points.forEach((point, i) => {
      const bmepBar = (4 * Math.PI * point.value) / 1.352e-3 / 1e5;
      expect(Math.abs(bmepBar - (expected[i] ?? 0))).toBeLessThan(0.1);
    });
    expect(preset.points.every((point) => point.uncertainty === 1)).toBe(true);
    expect(preset.digitised).toBe(true);
  });

  it('a preset field is overridden by the call; custom data needs quantity, points and a source; ids are unique; the input is untouched', () => {
    const before = structuredClone(emptyDoc);
    const custom = execute(emptyDoc, 'add_reference_data', {
      quantity: 'bmep_bar',
      points: [
        { rpm: 3000, value: 9.9, uncertainty: 0.1 },
        { rpm: 5000, value: 11.8 },
      ],
      source: 'test sheet',
      grade: 'A',
      calibrationRpm: [5000],
      bandRel: 0.03,
      altitudeM: 1500,
      note: 'cold day',
      id: 'mine',
    });
    expect(emptyDoc).toEqual(before);
    expect(custom.document.prototype?.references?.['mine']).toMatchObject({
      quantity: 'bmep_bar',
      grade: 'A',
      bandRel: 0.03,
      calibrationRpm: [5000],
      condition: { throttle: 'full', altitudeM: 1500, note: 'cold day' },
    });
    expect(custom.summary).toMatch(/altitude 1500 m is not modelled/);
    const over = execute(emptyDoc, 'add_reference_data', {
      preset: 'o320b_full_throttle',
      calibrationRpm: [2400],
      bandRel: 0.1,
      id: 'o320',
    });
    expect(over.document.prototype?.references?.['o320']).toMatchObject({
      calibrationRpm: [2400],
      bandRel: 0.1,
      quantity: 'brake_power_kW',
    });
    const again = execute(custom.document, 'add_reference_data', { preset: 'o320b_full_throttle', id: 'mine' });
    expect(again.affected).toEqual([]);
    expect(again.summary).toMatch(/already exists/);
  });

  it('refuses missing quantity / points / source, a non-positive band, a stray calibration speed and a half window', () => {
    const refuse = (params: Record<string, unknown>): string => {
      const result = execute(emptyDoc, 'add_reference_data', params);
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(emptyDoc);
      return result.summary;
    };
    const point = { rpm: 3000, value: 1 };
    expect(refuse({ points: [point], source: 's' })).toMatch(/quantity/);
    expect(refuse({ quantity: 'bmep_bar', source: 's' })).toMatch(/at least one point/);
    expect(refuse({ quantity: 'bmep_bar', points: [], source: 's' })).toMatch(/at least one point/);
    expect(refuse({ quantity: 'bmep_bar', points: [point] })).toMatch(/needs a source/);
    expect(refuse({ quantity: 'bmep_bar', points: [point], source: '  ' })).toMatch(/needs a source/);
    expect(refuse({ quantity: 'bmep_bar', points: [point], source: 's', bandRel: 0 })).toMatch(/invalid params|bandRel/);
    expect(refuse({ quantity: 'bmep_bar', points: [point], source: 's', calibrationRpm: [4000] })).toMatch(/not the speed of any point/);
    expect(refuse({ quantity: 'static_rpm', points: [{ value: 5, min: 4 }], source: 's' })).toMatch(/window point/);
    expect(refuse({ quantity: 'static_rpm', points: [{ value: 5, min: 6, max: 4 }], source: 's' })).toMatch(/window point/);
  });

  it('generates deterministic step ids when no id is given', () => {
    const result = execute(emptyDoc, 'add_reference_data', { quantity: 'bmep_bar', points: [{ rpm: 3000, value: 1 }], source: 's' });
    expect(result.affected[0]).toMatch(/^ref-\d+\.\d+$/);
  });
});

describe('E, U_val and status with a synthetic S (VC-FPR-31, 34)', () => {
  const reference: ReferenceData = { ...REFERENCE_PRESETS.rotax_912uls_full_throttle, id: 'uls' };
  const point = (rpm: number): { rpm: number; value: number; uncertainty?: number } => {
    const found = reference.points.find((candidate) => candidate.rpm === rpm);
    if (found?.rpm === undefined) throw new Error(`no point ${rpm}`);
    return { rpm, value: found.value, ...(found.uncertainty === undefined ? {} : { uncertainty: found.uncertainty }) };
  };

  it('a hold-out point inside the ±5 % band passes with E = S - D, U_val over the known terms and origin predicted', () => {
    const d = point(4000);
    const result = comparePoint({ reference, point: d, simulated: d.value * 1.04, numericalRel: 0.002, inputBand: { rel: 0.03 } });
    expect(result).toMatchObject({ status: 'pass', origin: 'predicted', holdOut: true, code: null, rpm: 4000, unit: 'N·m' });
    expect(result.error).toBeCloseTo(d.value * 0.04, 9);
    expect(result.errorRel).toBeCloseTo(0.04, 9);
    const [uNum, uInput, uD] = [0.002 * d.value * 1.04, 0.03 * d.value * 1.04, 1];
    expect(result.uncertainty).toMatchObject({
      numerical: expect.closeTo(uNum, 9),
      input: expect.closeTo(uInput, 9),
      reference: 1,
      missing: [],
    });
    expect(result.uncertainty.validation).toBeCloseTo(Math.sqrt(uNum ** 2 + uInput ** 2 + uD ** 2), 9);
    expect(result.accuracy.comparison).toEqual({
      referenceId: 'uls',
      s: d.value * 1.04,
      d: d.value,
      e: result.error,
      uVal: result.uncertainty.validation,
    });
    expect(result.accuracy).toMatchObject({ origin: 'predicted', validationLevel: 2 });
  });

  it('a hold-out miss on a grade B reference fails with FPR_REFERENCE_MISMATCH; on grade C it only warns', () => {
    const d = point(3000);
    const miss = comparePoint({ reference, point: d, simulated: d.value * 1.08, numericalRel: null, inputBand: null });
    expect(miss).toMatchObject({ status: 'fail', code: 'FPR_REFERENCE_MISMATCH' });
    expect(miss.accuracy.validationLevel).toBe(0);
    const grade = comparePoint({
      reference: { ...reference, grade: 'C' },
      point: d,
      simulated: d.value * 0.9,
      numericalRel: null,
      inputBand: null,
    });
    expect(grade).toMatchObject({ status: 'warn', code: 'FPR_REFERENCE_MISMATCH' });
  });

  it('missing terms are listed and left out, never taken as 0; with none the uncertainty is unknown (null)', () => {
    const d = point(3000);
    const partial = comparePoint({ reference, point: d, simulated: d.value, numericalRel: null, inputBand: null });
    expect(partial.uncertainty.missing).toEqual([expect.stringContaining('U_num'), expect.stringContaining('U_input')]);
    expect(partial.uncertainty.validation).toBeCloseTo(1, 12);
    const none = comparePoint({ reference, point: { rpm: 3000, value: d.value }, simulated: d.value, numericalRel: null, inputBand: null });
    expect(none.uncertainty.validation).toBeNull();
    expect(none.accuracy.band).toBeNull();
    expect(none.accuracy.warnings.join(' ')).toMatch(/U_D/);
    const absolute = comparePoint({ reference, point: d, simulated: 100, numericalRel: null, inputBand: { abs: 2, unit: 'N·m' } });
    expect(absolute.uncertainty.input).toBe(2);
  });

  it('a calibration point is information with origin calibrated and never pass evidence (VC-FPR-34)', () => {
    const d = point(5800);
    const result = comparePoint({ reference, point: d, simulated: d.value * 1.3, numericalRel: null, inputBand: null });
    expect(result).toMatchObject({ status: 'info', origin: 'calibrated', holdOut: false, code: null });
    expect(result.accuracy).toMatchObject({ origin: 'calibrated', validationLevel: 1 });
    expect(result.accuracy.warnings.join(' ')).toMatch(/not validation evidence/);
    const summary = summariseComparison([result]);
    expect(summary).toMatchObject({ status: 'pass', calibrationPoints: 1, holdOutPoints: 0, validationLevel: 1 });
    expect(summary.statement).toMatch(/no predictive evidence/);
  });

  it('a window point (static rpm) passes inside min..max and misses by the distance outside', () => {
    const window: ReferenceData = { ...REFERENCE_PRESETS.rotax_912_static_rpm_window, id: 'w' };
    const p = window.points[0] ?? { value: 0 };
    const inside = comparePoint({ reference: window, point: p, simulated: 5300, numericalRel: null, inputBand: null });
    expect(inside).toMatchObject({ status: 'pass', error: 0, span: { min: 5100, max: 5800 } });
    expect(comparePoint({ reference: window, point: p, simulated: 5000, numericalRel: null, inputBand: null })).toMatchObject({
      status: 'fail',
      error: -100,
    });
    expect(comparePoint({ reference: window, point: p, simulated: 6000, numericalRel: null, inputBand: null }).error).toBe(200);
    expect(comparePoint({ reference: window, point: { value: 0 }, simulated: 1, numericalRel: null, inputBand: null }).errorRel).toBe(
      Infinity,
    );
    expect(comparePoint({ reference: window, point: { value: 0 }, simulated: 0, numericalRel: null, inputBand: null }).errorRel).toBe(0);
  });

  it('validation level: all-calibration is 1 (no predictive evidence), all hold-out passes 2, four or more 3, a miss drops to 1; none is not_run', () => {
    const make = (rpm: number, factor: number): ReturnType<typeof comparePoint> => {
      const d = point(rpm);
      return comparePoint({ reference, point: d, simulated: d.value * factor, numericalRel: null, inputBand: null });
    };
    expect(summariseComparison([])).toMatchObject({ status: 'not_run', validationLevel: 0 });
    expect(summariseComparison([make(3000, 1), make(3500, 1.01)])).toMatchObject({ status: 'pass', validationLevel: 2, holdOutPassed: 2 });
    expect(summariseComparison([make(3000, 1), make(3500, 1), make(4000, 1), make(4500, 1)]).validationLevel).toBe(3);
    const missed = summariseComparison([make(3000, 1), make(3500, 1.2)]);
    expect(missed).toMatchObject({ status: 'fail', validationLevel: 1, holdOutPassed: 1 });
    expect(summariseComparison([make(3000, 1), make(5800, 2)]).calibrationPoints).toBe(1);
    expect(summariseComparison([make(3000, 1.2)]).status).toBe('fail');
    const warning = comparePoint({
      reference: { ...reference, grade: 'C' },
      point: point(3000),
      simulated: 1,
      numericalRel: null,
      inputBand: null,
    });
    expect(summariseComparison([warning]).status).toBe('warn');
  });
});

describe('plausibility bands (FR-FPR-76)', () => {
  it('reports value, band, unit and the basis; nothing inside the band', () => {
    expect(outsideBand('x', 0.9, [0.75, 0.95], '', 'named default', ['id'], 'hint')).toEqual([]);
    const found = outsideBand('mechanicalEfficiency', 0.6, [0.75, 0.95], '', 'named default band', ['loss'], 'check friction');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      code: 'FPR_UNREALISTIC',
      status: 'warn',
      quantity: 'mechanicalEfficiency',
      value: 0.6,
      band: [0.75, 0.95],
      basis: 'named default band',
      ids: ['loss'],
    });
    expect(found[0]?.message).toMatch(/0\.75\.\.0\.95.*named default band.*check friction/);
    expect(outsideBand('x', Number.NaN, [0, 1], '', 'b', [], 'h')).toEqual([]);
  });

  it('recognises the Rotax 912 reductions 51/21 and 50/22 (either direction of the ratio) within 1 %', () => {
    expect(isRotaxReduction(21 / 51)).toBe(true);
    expect(isRotaxReduction(-22 / 50)).toBe(true);
    expect(isRotaxReduction(0.5)).toBe(false);
    expect(isRotaxReduction(1)).toBe(false);
  });
});

describe('load validation of the new slices', () => {
  const { doc } = calibratedEngine();
  const withRefs = execute(doc, 'add_reference_data', { preset: 'rotax_912uls_full_throttle' }).document;

  it('accepts a model with losses, gear efficiency, a propeller table and a calibrated single-zone cylinder; old documents load unchanged', () => {
    expect(dynamicsProblems(doc.dynamics)).toEqual([]);
    expect(dynamicsProblems(sliderCrank().doc.dynamics)).toEqual([]);
    expect(prototypeProblems(withRefs.prototype)).toEqual([]);
    expect(prototypeProblems({ intents: {}, grounded: [] })).toEqual([]);
  });

  it('rejects malformed losses, gear, propeller and reference records with a path', () => {
    const dynamics = structuredClone(doc.dynamics) as unknown as Record<string, Record<string, Record<string, unknown>>>;
    const loss = Object.values(dynamics['losses'] ?? {})[0];
    if (loss === undefined) throw new Error('no losses');
    const break_ = (mutate: (record: Record<string, unknown>) => void): string[] => {
      const copy = structuredClone(dynamics);
      const record = Object.values(copy['losses'] ?? {})[0];
      if (record !== undefined) mutate(record);
      return dynamicsProblems(copy);
    };
    expect(break_((record) => (record['oilTempFactor'] = 0))[0]).toMatch(/dynamics\.losses\['.+'\]: oilTempFactor/);
    expect(break_((record) => (record['crank'] = 3))[0]).toMatch(/crank must be a joint id/);
    expect(break_((record) => (record['cylinders'] = [1]))[0]).toMatch(/cylinders must be/);
    expect(break_((record) => (record['model'] = { kind: 'chen_flynn' }))[0]).toMatch(/non-empty source/);
    expect(break_((record) => (record['model'] = { kind: 'chen_flynn', source: 's', aPa: 1 }))[0]).toMatch(/finite aPa/);
    expect(break_((record) => (record['model'] = { kind: 'fmep_table', source: 's', points: [[1, 1]] }))[0]).toMatch(
      /fmep_table needs points/,
    );
    expect(break_((record) => (record['model'] = { kind: 'component', source: 's' }))[0]).toMatch(/must be 'chen_flynn' or 'fmep_table'/);
    const gearDoc = (extra: Record<string, unknown>): string[] =>
      dynamicsProblems({
        gravity: [0, 0, 0],
        bodies: {},
        joints: {},
        motors: {},
        propellers: {},
        gears: { g: { id: 'g', driver: 'a', driven: 'b', ratio: 2, ...extra } },
      });
    expect(gearDoc({ efficiency: 0.9, teeth: [21, 51] })).toEqual([]);
    expect(gearDoc({ efficiency: 1.5 })[0]).toMatch(/efficiency must be in \(0, 1\]/);
    expect(gearDoc({ teeth: [21] })[0]).toMatch(/teeth must be/);
    const propDoc = (extra: Record<string, unknown>): string[] =>
      dynamicsProblems({
        gravity: [0, 0, 0],
        bodies: {},
        joints: {},
        gears: {},
        motors: {},
        propellers: {
          p: {
            id: 'p',
            joint: 'j',
            diameter: 1,
            airDensity: 1.2,
            thrustCoefficient: 0.1,
            powerCoefficient: 0.05,
            thrustDirection: [0, 1, 0],
            ...extra,
          },
        },
      });
    const goodTable = {
      points: [
        [0, 0.1, 0.05],
        [0.5, 0.05, 0.04],
      ],
      source: 's',
      grade: 'B',
    };
    expect(propDoc({ table: goodTable, airspeedMps: 10, inertiaKgM2: 0.3 })).toEqual([]);
    expect(propDoc({ airspeedMps: -1 })[0]).toMatch(/airspeedMps/);
    expect(propDoc({ inertiaKgM2: 0 })[0]).toMatch(/inertiaKgM2/);
    expect(propDoc({ table: { ...goodTable, source: '' } })[0]).toMatch(/table needs points/);
    expect(propDoc({ table: { ...goodTable, grade: 'Z' } })[0]).toMatch(/table needs points/);
    expect(
      propDoc({
        table: {
          ...goodTable,
          points: [
            [0.5, 1, 1],
            [0.2, 1, 1],
          ],
        },
      })[0],
    ).toMatch(/strictly increase/);
    const refBreak = (mutate: (record: Record<string, unknown>) => void): string[] => {
      const copy = structuredClone(withRefs.prototype) as unknown as { references: Record<string, Record<string, unknown>> };
      const record = copy.references['rotax_912uls_full_throttle'];
      if (record !== undefined) mutate(record);
      return prototypeProblems(copy);
    };
    expect(refBreak((record) => (record['quantity'] = 'nope'))[0]).toMatch(/quantity must be one of/);
    expect(refBreak((record) => (record['condition'] = {}))[0]).toMatch(/condition needs throttle/);
    expect(refBreak((record) => (record['source'] = ''))[0]).toMatch(/source and grade/);
    expect(refBreak((record) => (record['digitised'] = 'yes'))[0]).toMatch(/digitised must be a boolean/);
    expect(refBreak((record) => (record['bandRel'] = 0))[0]).toMatch(/bandRel must be > 0/);
    expect(refBreak((record) => (record['points'] = []))[0]).toMatch(/points must be a non-empty array/);
    expect(refBreak((record) => (record['calibrationRpm'] = 'x'))[0]).toMatch(/calibrationRpm/);
    expect(prototypeProblems({ intents: {}, grounded: [], references: 'x' })[0]).toMatch(/references must be an object/);
    expect(prototypeProblems({ intents: {}, grounded: [], references: { a: { id: 'b' } } })[0]).toMatch(/whose id is 'a'/);
    expect(prototypeProblems({ intents: {}, grounded: [], references: JSON.parse('{"__proto__": {}}') as object })[0]).toMatch(/reserved/);
  });

  it('rejects a calibratedRpm that is not an array of positive numbers (a string used to load and crash engine_quick_check)', () => {
    const breakCylinder = (value: unknown): string[] => {
      const copy = structuredClone(doc.dynamics) as unknown as { cylinders: Record<string, { model: Record<string, unknown> }> };
      const cylinder = Object.values(copy.cylinders)[0];
      if (cylinder === undefined) throw new Error('no cylinder');
      cylinder.model['calibratedRpm'] = value;
      return dynamicsProblems(copy);
    };
    expect(breakCylinder([5800])).toEqual([]);
    expect(breakCylinder('5800')[0]).toMatch(/calibratedRpm must be an array of finite numbers > 0/);
    expect(breakCylinder([0])[0]).toMatch(/calibratedRpm/);
    expect(breakCylinder([Number.NaN])[0]).toMatch(/calibratedRpm/);
  });

  it('rejects a material source that is empty and a grade outside A / B / C', () => {
    const base = { name: 'm', density: 2.68, color: '#cccccc', metalness: 0.5, roughness: 0.5 };
    expect(validateMaterialValue('m', { ...base, source: 'E-R32', grade: 'B' })).toBeNull();
    expect(validateMaterialValue('m', { ...base, source: '' })).toMatch(/source must be a non-empty string/);
    expect(validateMaterialValue('m', { ...base, source: 3 })).toMatch(/source must be a non-empty string/);
    expect(validateMaterialValue('m', { ...base, grade: 'D' })).toMatch(/grade must be 'A', 'B' or 'C'/);
  });
});

describe('engine injection points (spec 11 Q3)', () => {
  it('a model with losses is refused when no engine friction law is installed, never run lossless', () => {
    const { doc } = calibratedEngine();
    setEngineLossLaw(null);
    try {
      const built = buildSimulationModel(doc, 1e-4);
      expect('error' in built && built.error).toMatch(/no engine friction law is installed/);
    } finally {
      installEngineLaws();
    }
    expect('error' in buildSimulationModel(doc, 1e-4)).toBe(false);
  });

  it('without a realism law the realism block is absent', () => {
    setRealismLaw(null);
    try {
      expect(realismOf({} as unknown as Parameters<typeof realismOf>[0])).toBeNull();
    } finally {
      installEngineLaws();
    }
  });
});

describe('loop residual tiers (VC-FPR-35)', () => {
  it('0.5 / 5 / 20 µm are pass / warn / fail against the 1e-6 and 1e-5 m limits', () => {
    const [pass, fail] = caseOf('VC-FPR-35').value as number[];
    expect(pass).toBe(1e-6);
    expect(fail).toBe(1e-5);
    expect(residualTier(0.5e-6, pass ?? 0, fail ?? 0)).toBe('pass');
    expect(residualTier(5e-6, pass ?? 0, fail ?? 0)).toBe('warn');
    expect(residualTier(20e-6, pass ?? 0, fail ?? 0)).toBe('fail');
  });
});
