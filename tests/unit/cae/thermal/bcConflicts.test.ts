import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { addBc, machineContext, recorded, resultsFor, thermalFixture, twoTetMesh } from './fixtures';

const source = { citation: 'test input' };
const hot = (value: number, x: number): Record<string, unknown> => ({
  name: `t${value}`,
  kind: 'temperature',
  value,
  unit: 'degC',
  source,
  target: { entityId: '', facesNear: [[x, 0.5, 0.025]] },
});

function solvedWith(
  values: readonly [number, number],
  sharedFace: boolean,
): { doc: ReturnType<typeof recorded>; ids: string[]; analysisId: string } {
  const base = thermalFixture();
  const first = addBc(base, { ...hot(values[0], 0), target: { entityId: base.boxId, facesNear: [[0, 0.5, 0.025]] } });
  const second = addBc(
    { ...base, doc: first.doc },
    { ...hot(values[1], 1), target: { entityId: base.boxId, facesNear: [[sharedFace ? 0 : 1, 0.5, 0.025]] } },
  );
  const fixture = { ...base, doc: second.doc };
  const mesh = twoTetMesh(fixture, { nodeSets: { [`B_${first.id}`]: [1, 3, 4], [`B_${second.id}`]: sharedFace ? [1, 3, 4] : [5] } });
  const results = resultsFor(fixture, mesh, [{ time: 1, temperature: { 1: values[1], 2: 60, 3: values[1], 4: values[1], 5: 40 } }]);
  return { doc: recorded(fixture, mesh, results), ids: [first.id, second.id], analysisId: base.analysisId };
}

describe('check_thermal THM_BC_CONFLICT', () => {
  it('fails when two temperature BCs prescribe different values on the same nodes', () => {
    const { doc, ids, analysisId } = solvedWith([50, 80], true);
    const result = execute(doc, 'check_thermal', { analysisId }, machineContext());
    const items = (result.data as { items: { code: string; ids: string[]; message: string }[] }).items;
    const conflict = items.find((entry) => entry.code === 'THM_BC_CONFLICT');
    expect(conflict?.ids).toEqual(ids);
    expect(conflict?.message).toContain('3 shared node(s)');
    expect((result.data as { status: string }).status).toBe('fail');
  });

  it('accepts equal values on shared nodes and different values on separate nodes', () => {
    for (const [values, shared] of [
      [[50, 50], true],
      [[50, 80], false],
    ] as const) {
      const { doc, analysisId } = solvedWith(values, shared);
      const items = (execute(doc, 'check_thermal', { analysisId }, machineContext()).data as { items: { code: string }[] }).items;
      expect(items.some((entry) => entry.code === 'THM_BC_CONFLICT')).toBe(false);
    }
  });
});
