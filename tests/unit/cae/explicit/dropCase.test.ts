/**
 * 14 FLL-M5: create_drop_case. Oracle VC-FLL-05 (energy balance): v0 = sqrt(2 g h) = 3.1316 m/s for h = 0.5 m; for m = 1.115 kg on a k = 20000 N/m
 * spring m g (h + x) = k x^2 / 2 gives a peak spring force 478.703 N. The spring run itself needs the native solver (server/tests); here the
 * set-up the run starts from is checked against those closed forms.
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { buildExplicitJob } from '@cae/index';
import { expectNoOp, expectPure } from '../../../helpers/expectNoOp';
import { dropVehicle, levelDrop } from './dropCaseFixture';

const G = 9.80665;

describe('create_drop_case', () => {
  it('sets up the 0.5 m level drop: v0 = sqrt(2 g h) = 3.1316 m/s, gravity, a ground wall under the lowest point, mass and energy', () => {
    const { doc, boxId } = dropVehicle();
    const result = execute(doc, 'create_drop_case', levelDrop(boxId));
    expect(result.error).toBeUndefined();
    const [analysisId = '', wallId = ''] = result.affected;
    expect(result.affected).toHaveLength(2);
    const data = result.data as Record<string, unknown>;
    expect(data['impactVelocityMps']).toBeCloseTo(3.1316, 4);
    const analysis = result.document.analysis?.cases[analysisId];
    expect(analysis?.type).toBe('explicit_dynamics');
    expect(analysis?.solver).toBe('llull_explicit');
    expect(Object.keys(analysis?.parts ?? {})).toEqual([boxId]);
    const explicit = analysis?.explicit;
    expect(explicit?.endTimeS).toBeCloseTo(0.01, 12);
    expect(explicit?.historyIntervalS).toBeCloseTo(0.01 / 200, 12);
    expect(explicit?.gravity?.[2]).toBeCloseTo(-G * 1000, 9);
    const velocity = Object.values(explicit?.initialVelocities ?? {})[0];
    expect(velocity?.entityId).toBe(boxId);
    expect(velocity?.velocity[2]).toBeCloseTo(-Math.sqrt(2 * G * 0.5) * 1000, 9);
    expect(explicit?.rigidWalls[wallId]).toEqual({ name: 'ground', point: [0, 0, 100], normal: [0, 0, 1] });
    expect(data['massKg']).toBeCloseTo(1.115, 9);
    expect(data['impactEnergyJ']).toBeCloseTo(1.115 * G * 0.5, 9);
    expect(result.summary).toContain('3.1316 m/s');
    expect(result.summary).toContain('standard gravity default');
    // the drop speed and the energy balance with the VC-FLL-05 spring reproduce the oracle peak force
    const m = data['massKg'] as number;
    const k = 20000;
    const x = (m * G + Math.sqrt((m * G) ** 2 + 2 * k * m * G * 0.5)) / k;
    expect(k * x).toBeCloseTo(478.703, 0);
    expect(0.5 * m * (data['impactVelocityMps'] as number) ** 2 + m * G * x).toBeCloseTo(0.5 * k * x * x, 9);
    // the case is a valid explicit job (structured hex 8 x 8 x 2 cells of 25 mm)
    const built = buildExplicitJob(result.document, analysisId, null);
    if (!built.ok) throw new Error(built.message);
    expect(built.job.walls).toEqual([{ name: 'ground', point: [0, 0, 100], normal: [0, 0, 1] }]);
    expect(built.job.initialVelocity.slice(0, 3)).toEqual([0, 0, expect.closeTo(-3131.55, 1)]);
  });

  it('tilts the ground about the chosen axis and places the wall at the lowest corner along its normal', () => {
    const { doc, boxId } = dropVehicle();
    const result = execute(
      doc,
      'create_drop_case',
      levelDrop(boxId, {
        orientation: 'tilted',
        tiltDegrees: 30,
        tiltAxis: [0, 1],
        historyInterval: { value: 1, unit: 'ms' },
        gravityMps2: 9.81,
      }),
    );
    expect(result.error).toBeUndefined();
    const data = result.data as { groundNormal: number[]; wallPoint: number[]; impactVelocityMps: number };
    expect(data.groundNormal[0]).toBeCloseTo(Math.sin(Math.PI / 6), 12);
    expect(data.groundNormal[1]).toBeCloseTo(0, 12);
    expect(data.groundNormal[2]).toBeCloseTo(Math.cos(Math.PI / 6), 12);
    expect(data.impactVelocityMps).toBeCloseTo(Math.sqrt(2 * 9.81 * 0.5), 12);
    // lowest corner along n (n_x > 0): x = 0, z = 100
    expect(data.wallPoint).toEqual([0, 0, 100]);
    expect(result.summary).not.toContain('(default)');
  });

  it('defaults the tilt axis to X, names the case and leaves the mesh source to the case default', () => {
    const { doc, boxId } = dropVehicle();
    const { mesh: _mesh, ...rest } = levelDrop(boxId, { orientation: 'tilted', tiltDegrees: 45, name: 'rolled landing' });
    const result = execute(doc, 'create_drop_case', rest);
    expect(result.error).toBeUndefined();
    const data = result.data as { analysisId: string; groundNormal: number[] };
    expect(data.groundNormal[0]).toBeCloseTo(0, 12);
    expect(data.groundNormal[1]).toBeCloseTo(-Math.SQRT1_2, 12);
    expect(result.document.analysis?.cases[data.analysisId]?.name).toBe('rolled landing');
    expect(result.document.analysis?.cases[data.analysisId]?.explicit?.mesh).toEqual({ kind: 'fea_mesh' });
    expect(result.summary).toContain('45 deg');
  });

  it.each([
    ['unknown part', { partIds: ['nope'] }, 'FLL_DROP_PARTS'],
    ['duplicate part', { partIds: ['$box', '$box'] }, 'FLL_DROP_PARTS'],
    ['tilt on level', { tiltDegrees: 10 }, 'FLL_DROP_ORIENTATION'],
    ['tilted without angle', { orientation: 'tilted' }, 'FLL_DROP_ORIENTATION'],
    ['tilt of 90', { orientation: 'tilted', tiltDegrees: 90 }, 'FLL_DROP_ORIENTATION'],
    ['zero tilt axis', { orientation: 'tilted', tiltDegrees: 10, tiltAxis: [0, 0] }, 'FLL_DROP_ORIENTATION'],
    ['bad end time', { endTime: { value: -1, unit: 'ms' } }, 'EXP_TIME_INVALID'],
    ['history longer than the run', { historyInterval: { value: 1, unit: 's' } }, 'EXP_TIME_INVALID'],
    ['structured mesh without size', { mesh: { kind: 'structured_hex' } }, 'EXP_PARAM_INVALID'],
  ])('refuses %s with the unchanged document', (_label, overrides, code) => {
    const { doc, boxId } = dropVehicle();
    const params = levelDrop(boxId, overrides);
    if (Array.isArray(params['partIds'])) params['partIds'] = params['partIds'].map((id: string) => (id === '$box' ? boxId : id));
    const result = execute(doc, 'create_drop_case', params);
    expect(result.error?.code).toBe(code);
    expect(result.error?.remediation.length).toBeGreaterThan(0);
    expectNoOp(result, doc);
  });

  it('refuses a 2D part, a non-positive height or gravity, and invalid params', () => {
    const { doc, boxId } = dropVehicle();
    const line = execute(doc, 'draw_line', { start: [0, 0], end: [10, 0] });
    expect(execute(line.document, 'create_drop_case', levelDrop(line.affected[0] ?? '')).error?.code).toBe('FLL_DROP_PARTS');
    expect(execute(doc, 'create_drop_case', levelDrop(boxId, { heightM: 0 })).error?.code).toBeDefined();
    expect(execute(doc, 'create_drop_case', levelDrop(boxId, { partIds: [] })).rejected).toBe(true);
    expect(execute(doc, 'create_drop_case', levelDrop(boxId, { gravityMps2: -1 })).rejected).toBe(true);
  });

  it('refuses an unsupported document unit through the nested step, leaving the document unchanged', () => {
    const { doc, boxId } = dropVehicle();
    const feet = { ...doc, units: 'ft' as const };
    const result = execute(feet, 'create_drop_case', levelDrop(boxId));
    expect(result.rejected).toBe(true);
    expect(result.document).toBe(feet);
  });

  it('reports an unknown mass instead of refusing when the part has no material', () => {
    const { doc, boxId } = dropVehicle();
    const bare = execute(doc, 'assign_material', { materialName: 'vehicle', entityIds: [] }).document;
    const stripped = {
      ...bare,
      entities: { ...bare.entities, [boxId]: { ...bare.entities[boxId]!, materialId: undefined } },
    } as typeof doc;
    const result = execute(stripped, 'create_drop_case', levelDrop(boxId));
    expect(result.error).toBeUndefined();
    expect((result.data as { massKg: number | null }).massKg).toBeNull();
    expect(result.summary).toContain('mass unknown');
  });

  it('is pure', () => {
    const { doc, boxId } = dropVehicle();
    expectPure(doc, () => execute(doc, 'create_drop_case', levelDrop(boxId)));
  });

  it('is deterministic: the same document and params give the same case ids', () => {
    const { doc, boxId } = dropVehicle();
    const a = execute(doc, 'create_drop_case', levelDrop(boxId));
    const b = execute(doc, 'create_drop_case', levelDrop(boxId));
    expect(a.affected).toEqual(b.affected);
    expect(JSON.stringify(a.document)).toBe(JSON.stringify(b.document));
  });
});
