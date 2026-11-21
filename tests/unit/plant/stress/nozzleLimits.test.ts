/** 07 PST nozzle limits per model: `set_nozzle_load_limit` and `check_nozzle_loads` in the 03 EQP nozzle frame (TR-PST-09, FR-PST-14). */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { nozzleFrame, toFrame } from '../../../../packages/domain-aec/src/plant/stress/code/nozzleFrame';
import { apply, expectRefusal } from '../../../helpers/commandAssertions';
import { anchorAt, baseDoc, cases, conditioned, DN100, withModel, withPipe } from './m3Fixtures';
import { expectRel } from './stressFixtures';

const LBF = 4.4482216152605;

interface Scene {
  doc: CadDocument;
  id: string;
  restraintId: string;
}

interface Row {
  case: string;
  ratio: number;
  forceNozzleFrameN: [number, number, number];
  momentNozzleFrameNm: [number, number, number];
}

/** Pump P-101 with a +Z nozzle N2 at (0, 300, 1000); the pipe rises 3000 mm from the nozzle, turns +X for 3000 mm; anchor at the nozzle. */
function scene(record = true): Scene {
  let doc = apply(baseDoc(), 'add_equipment', {
    name: 'Centrifugal pump',
    mark: 'P-101',
    location: [0, -300],
    size: [1200, 600, 800],
    weight: 650,
  });
  doc = apply(doc, 'add_nozzle', {
    equipment: 'P-101',
    mark: 'N2',
    dn: 100,
    rating: 'CL150',
    facing: 'RF',
    location: { on: 'free', position: [0, 300, 1000], direction: [0, 0, 1] },
    projection: 300,
  });
  const pipe = withPipe(
    doc,
    [
      [0, 300, 1000],
      [0, 300, 4000],
      [3000, 300, 4000],
    ],
    DN100.odMm,
  );
  const model = withModel(pipe.doc, [pipe.id]);
  let d = conditioned(model.doc, model.id, { temperatures: [{ name: 'T1', tempC: 60 }] });
  d = anchorAt(d, model.id, pipe.id, 0);
  d = cases(d, model.id, [
    { name: 'SUS', type: 'SUS', basic: ['W'] },
    { name: 'OPE', type: 'OPE', basic: ['W', 'T1'] },
  ]);
  const restraintId = d.plant?.stress?.models[model.id]?.restraints[0]?.id as string;
  return { doc: record ? apply(d, 'record_pipe_stress_results', { modelId: model.id }) : d, id: model.id, restraintId };
}

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
