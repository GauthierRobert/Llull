/** 07 PST nozzle limits per model: `set_nozzle_load_limit` and `check_nozzle_loads` in the 03 EQP nozzle frame (TR-PST-09, FR-PST-14). */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { nozzleFrame, toFrame } from '../../../../packages/domain-aec/src/plant/stress/code/nozzleFrame';
import { apply, expectRefusal } from '../../../helpers/commandAssertions';
import { scene, type Row, type Scene } from './nozzleFixtures';
import { expectRel } from './stressFixtures';
import { cases as setCases } from './m3Fixtures';

const LBF = 4.4482216152605;

const USER = (limit: number): Record<string, unknown> => ({
  standard: 'user',
  userLimits: { source: 'vendor letter', resultantForce: limit },
});

const setLimit = (s: Scene, extra: Record<string, unknown> = {}): CadDocument =>
  apply(s.doc, 'set_nozzle_load_limit', { modelId: s.id, portId: 'P-101:N2', holderId: s.restraintId, ...USER(1e9), ...extra });

const rowsOf = (result: ReturnType<typeof execute>): Row[] => (result.data as { rows: Row[] }).rows;

describe('nozzleFrame', () => {
  it('vertical nozzle: x = world X, y = world Y, z = axis', () => {
    expect(nozzleFrame([0, 0, 1])).toEqual({ x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] });
  });
  it('horizontal nozzle along +X: y up, x = y cross z', () => {
    const frame = nozzleFrame([1, 0, 0]);
    expect(frame?.y).toEqual([0, 0, 1]);
    expect(frame?.x).toEqual([0, 1, 0]);
    expect(toFrame(frame as NonNullable<typeof frame>, [0, -5, 7])).toEqual([-5, 7, 0]);
  });
  it('frameX overrides x (projected) and is refused along the axis or zero', () => {
    const frame = nozzleFrame([0, 0, 1], [1, 1, 5]);
    expect(frame?.x[0]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(frame?.y[1]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(nozzleFrame([0, 0, 1], [0, 0, 3])).toBeNull();
    expect(nozzleFrame([0, 0, 0])).toBeNull();
  });
});

describe('set_nozzle_load_limit', () => {
  it('stores one limit per port, replaces it on a second call, and is pure', () => {
    const s = scene();
    const before = JSON.stringify(s.doc);
    const first = execute(s.doc, 'set_nozzle_load_limit', { modelId: s.id, portId: 'P-101:N2', holderId: s.restraintId, ...USER(1000) });
    expect(first.rejected).toBeUndefined();
    expect(JSON.stringify(s.doc)).toBe(before);
    const limitId = (first.data as { limitId: string }).limitId;
    expect(first.affected).toEqual([s.id, limitId]);
    const second = execute(first.document, 'set_nozzle_load_limit', {
      modelId: s.id,
      portId: 'P-101:N2',
      holderId: s.restraintId,
      standard: 'nema_sm23',
      nominalIn: 4,
    });
    expect((second.data as { limitId: string }).limitId).toBe(limitId);
    const limits = second.document.plant?.stress?.models[s.id]?.nozzleLimits;
    expect(limits).toHaveLength(1);
    expect(limits?.[0]?.standard).toBe('nema_sm23');
  });

  it('refuses unknown model, port, holder, incomplete rule, bad frameX', () => {
    const s = scene();
    const base = { modelId: s.id, portId: 'P-101:N2', holderId: s.restraintId };
    expectRefusal(s.doc, 'set_nozzle_load_limit', { ...base, modelId: 'nope', ...USER(1) }, 'PST_MODEL_NOT_FOUND');
    expectRefusal(s.doc, 'set_nozzle_load_limit', { ...base, portId: 'P-101:X', ...USER(1) }, 'PST_NOZZLE_PORT_NOT_FOUND');
    expectRefusal(s.doc, 'set_nozzle_load_limit', { ...base, holderId: 'ghost', ...USER(1) }, 'PST_NOZZLE_NODE_NOT_FOUND');
    expectRefusal(s.doc, 'set_nozzle_load_limit', { ...base, standard: 'api610' }, 'PST_NOZZLE_LIMIT_MISSING');
    expectRefusal(s.doc, 'set_nozzle_load_limit', { ...base, standard: 'nema_sm23' }, 'PST_PARAM_INVALID');
    expectRefusal(s.doc, 'set_nozzle_load_limit', { ...base, ...USER(1), frameX: [0, 0, 1] }, 'PST_PARAM_INVALID');
  });
});

describe('check_nozzle_loads', () => {
  it('nozzle load = minus the recorded reaction in the nozzle frame; ratio against a user resultant limit', () => {
    const s = scene();
    const doc = setLimit(s);
    const result = execute(doc, 'check_nozzle_loads', { modelId: s.id });
    expect(result.rejected).toBeUndefined();
    const rows = rowsOf(result);
    expect(rows.map((row) => row.case)).toEqual(['SUS', 'OPE']);
    const recorded = doc.plant?.stress?.models[s.id]?.recorded?.supportLoads.find((load) => load.case === 'SUS');
    const sus = rows[0] as Row;
    expect(sus.forceNozzleFrameN[2]).toBeCloseTo(-(recorded?.forceN[2] as number), 6);
    expect(sus.forceNozzleFrameN[2]).toBeLessThan(0);
    expect(sus.momentNozzleFrameNm[1]).toBeCloseTo(-(recorded?.momentNmm[1] as number) / 1000, 6);
    expect(Math.abs(sus.momentNozzleFrameNm[1])).toBeGreaterThan(1);
    const hit = execute(setLimit(s, USER(2000)), 'check_nozzle_loads', { modelId: s.id, cases: ['SUS'] });
    const row = rowsOf(hit)[0] as Row;
    expectRel(row.ratio, Math.hypot(...row.forceNozzleFrameN) / 2000, 1e-9);
  });

  it('NEMA SM 23 in lbf: ratio = (3 F + M) / (500 De)', () => {
    const s = scene();
    const doc = apply(s.doc, 'set_nozzle_load_limit', {
      modelId: s.id,
      portId: 'P-101:N2',
      holderId: s.restraintId,
      standard: 'nema_sm23',
      nominalIn: 4,
    });
    const result = execute(doc, 'check_nozzle_loads', { modelId: s.id, cases: ['SUS'] });
    const row = rowsOf(result)[0] as Row;
    const force = Math.hypot(...row.forceNozzleFrameN) / LBF;
    const moment = Math.hypot(...row.momentNozzleFrameNm) / 1.3558179483314;
    expectRel(row.ratio, (3 * force + moment) / 2000, 1e-9);
    expect((result.data as { warnings: { code: string }[] }).warnings[0]?.code).toBe('PST_NOZZLE_LIMIT_UNVERIFIED');
  });

  it('refuses an overload with every row in the detail', () => {
    const s = scene();
    const result = expectRefusal(setLimit(s, USER(1)), 'check_nozzle_loads', { modelId: s.id }, 'PST_NOZZLE_OVERLOAD');
    expect(JSON.stringify(result)).toContain('forceNozzleFrameN');
  });

  it('refuses missing limits, results, stale results, unknown cases, vanished ports and holders', () => {
    const s = scene();
    expectRefusal(s.doc, 'check_nozzle_loads', { modelId: s.id }, 'PST_NOZZLE_NO_LIMITS');
    expectRefusal(s.doc, 'check_nozzle_loads', { modelId: 'nope' }, 'PST_MODEL_NOT_FOUND');
    const unrecorded = scene(false);
    expectRefusal(setLimit(unrecorded), 'check_nozzle_loads', { modelId: unrecorded.id }, 'PST_NOT_RECORDED');
    const limited = setLimit(s);
    expectRefusal(limited, 'check_nozzle_loads', { modelId: s.id, cases: ['EXP'] }, 'PST_PARAM_INVALID');
    expectRefusal(
      apply(limited, 'update_stress_model', { modelId: s.id, frictionCoefficient: 0.5 }),
      'check_nozzle_loads',
      { modelId: s.id },
      'PST_RESULTS_STALE',
    );
    const gone = structuredClone(limited);
    const model = gone.plant?.stress?.models[s.id];
    if (model?.nozzleLimits?.[0] !== undefined) model.nozzleLimits[0].holderId = 'ghost';
    expectRefusal(gone, 'check_nozzle_loads', { modelId: s.id }, 'PST_NOZZLE_NODE_NOT_FOUND');
    const noPort = structuredClone(limited);
    const noPortModel = noPort.plant?.stress?.models[s.id];
    if (noPortModel?.nozzleLimits?.[0] !== undefined) noPortModel.nozzleLimits[0].portId = 'P-101:ZZ';
    expectRefusal(noPort, 'check_nozzle_loads', { modelId: s.id }, 'PST_NOZZLE_PORT_NOT_FOUND');
  });

  it('is pure', () => {
    const s = scene();
    const doc = setLimit(s);
    const before = JSON.stringify(doc);
    execute(doc, 'check_nozzle_loads', { modelId: s.id });
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('nozzle limit lifecycle and guards', () => {
  it('delete_nozzle_load_limit by portId or limitId; a vanished port blocks the check until the limit is deleted', () => {
    const s = scene();
    const limited = setLimit(s);
    const limitId = limited.plant?.stress?.models[s.id]?.nozzleLimits?.[0]?.id as string;
    const gone = structuredClone(limited);
    const model = gone.plant?.stress?.models[s.id];
    if (model?.nozzleLimits?.[0] !== undefined) model.nozzleLimits[0].portId = 'P-101:ZZ';
    expectRefusal(gone, 'check_nozzle_loads', { modelId: s.id }, 'PST_NOZZLE_PORT_NOT_FOUND');
    const deleted = execute(gone, 'delete_nozzle_load_limit', { modelId: s.id, limitId });
    expect(deleted.rejected).toBeUndefined();
    expect(deleted.affected).toEqual([s.id, limitId]);
    expectRefusal(deleted.document, 'check_nozzle_loads', { modelId: s.id }, 'PST_NOZZLE_NO_LIMITS');
    const byPort = apply(limited, 'delete_nozzle_load_limit', { modelId: s.id, portId: 'P-101:N2' });
    expect(byPort.plant?.stress?.models[s.id]?.nozzleLimits).toEqual([]);
    expect(byPort.plant?.stress?.models[s.id]?.recorded).toBeDefined();
  });

  it('delete refuses unknown model, none or both selectors, unknown limit', () => {
    const s = scene();
    const limited = setLimit(s);
    expectRefusal(limited, 'delete_nozzle_load_limit', { modelId: 'nope', limitId: 'x' }, 'PST_MODEL_NOT_FOUND');
    expectRefusal(limited, 'delete_nozzle_load_limit', { modelId: s.id }, 'PST_PARAM_INVALID');
    expectRefusal(limited, 'delete_nozzle_load_limit', { modelId: s.id, limitId: 'a', portId: 'b' }, 'PST_PARAM_INVALID');
    expectRefusal(limited, 'delete_nozzle_load_limit', { modelId: s.id, portId: 'P-101:N9' }, 'PST_PARAM_INVALID');
    expectRefusal(limited, 'delete_nozzle_load_limit', { modelId: s.id, limitId: 'nope' }, 'PST_PARAM_INVALID');
  });

  it('refuses a holder away from the port (PST_NOZZLE_NOT_AT_PORT) and accepts the anchor at the flange', () => {
    const s = scene();
    const pipeId = s.doc.plant?.stress?.models[s.id]?.scope.ids[0] as string;
    const far = apply(s.doc, 'add_stress_restraint', { modelId: s.id, at: { pipeId, atMm: 6000 }, kind: 'anchor' });
    const farId = far.plant?.stress?.models[s.id]?.restraints[1]?.id as string;
    expectRefusal(
      far,
      'set_nozzle_load_limit',
      { modelId: s.id, portId: 'P-101:N2', holderId: farId, ...USER(1) },
      'PST_NOZZLE_NOT_AT_PORT',
    );
    expect(
      execute(far, 'set_nozzle_load_limit', { modelId: s.id, portId: 'P-101:N2', holderId: s.restraintId, ...USER(1) }).rejected,
    ).toBeUndefined();
  });

  it('a zero frameX is rejected by the schema; a frameX along the axis is refused at set time', () => {
    const s = scene();
    const base = { modelId: s.id, portId: 'P-101:N2', holderId: s.restraintId, ...USER(1) };
    expect(execute(s.doc, 'set_nozzle_load_limit', { ...base, frameX: [0, 0, 0] }).rejected).toBe(true);
    expectRefusal(s.doc, 'set_nozzle_load_limit', { ...base, frameX: [0, 0, 5] }, 'PST_PARAM_INVALID', 'frameX');
  });

  it('a case filter that excludes every reaction of the holder is PST_PARAM_INVALID on cases, not a missing node', () => {
    const s = scene(false);
    const withCombo = setCases(s.doc, s.id, [
      { name: 'SUS', type: 'SUS', basic: ['W'] },
      { name: 'OPE', type: 'OPE', basic: ['W', 'T1'] },
      { name: 'T1ONLY', type: 'OPE', basic: ['T1'] },
      { name: 'EXPS', type: 'EXP', combine: [{ case: 'T1ONLY', factor: 1 }], method: 'scalar' },
    ]);
    const recorded = apply(withCombo, 'record_pipe_stress_results', { modelId: s.id });
    const doc = apply(recorded, 'set_nozzle_load_limit', { modelId: s.id, portId: 'P-101:N2', holderId: s.restraintId, ...USER(1e9) });
    expectRefusal(doc, 'check_nozzle_loads', { modelId: s.id, cases: ['EXPS'] }, 'PST_PARAM_INVALID', 'cases');
  });

  it('reports a limitsHash that changes with the limits', () => {
    const s = scene();
    const hash = (doc: CadDocument): string =>
      (execute(doc, 'check_nozzle_loads', { modelId: s.id }).data as { limitsHash: string }).limitsHash;
    expect(hash(setLimit(s))).toMatch(/^[0-9a-f]{64}$/);
    expect(hash(setLimit(s, USER(2e9)))).not.toBe(hash(setLimit(s)));
  });

  it('with the hot modulus the nozzle loads still come from the recorded (hot) OPE reactions', () => {
    const s = scene(true, true);
    const doc = setLimit(s);
    const result = execute(doc, 'check_nozzle_loads', { modelId: s.id });
    expect(result.rejected).toBeUndefined();
    expect(rowsOf(result).map((row) => row.case)).toEqual(['SUS', 'OPE']);
  });
});
