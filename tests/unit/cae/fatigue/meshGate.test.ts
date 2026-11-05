/** FE hot-spot fatigue on a mesh with too few layers through the wall (FR-INT-06): rows are not assessed, never pass, unless accepted. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { isEvaluationFailure } from '@cae/fatigue/evaluate';
import { fatigueFieldArtifact, fatigueFieldInput } from '@cae/fatigue/feField';
import { fatigueFieldReference } from '../../../helpers/fatigueFieldOracle';
import { feFatigue, type FeFatigue } from './feFixtures';

type Json = Record<string, unknown>;
const data = (result: { data?: unknown }): Json => (result.data ?? {}) as Json;

/** The fixture with its field stored; the seeded 2-layer C3D4 grid is inadequate when measured. */
function stored(options: Parameters<typeof feFatigue>[0]): FeFatigue {
  const fixture = feFatigue(options);
  const input = fatigueFieldInput(fixture.doc, fixture.caseId, fixture.store);
  if (isEvaluationFailure(input)) throw new Error(input.message);
  const artifact = fatigueFieldArtifact(input, fatigueFieldReference(input), 'test');
  if (typeof artifact === 'string') throw new Error(artifact);
  fixture.store.alias(input.key, fixture.store.put(artifact));
  return fixture;
}

describe('compute_fatigue / check_fatigue on an inadequate mesh', () => {
  it('rows are NOT_ASSESSED with FEA_MESH_INADEQUATE, no margin, the status is never PASS', () => {
    const fixture = stored({ adequacy: 'measured' });
    const result = execute(fixture.doc, 'compute_fatigue', { caseId: fixture.caseId }, fixture.ctx);
    const out = data(result);
    expect(out['status']).toBe('NOT_ASSESSED');
    expect(out['minMargin']).toBeNull();
    for (const row of out['rows'] as Json[])
      expect(row).toMatchObject({ status: 'NOT_ASSESSED', margin: null, code: 'FEA_MESH_INADEQUATE' });
    expect((out['meshAdequacy'] as Json)['verdict']).toBe('inadequate');
    expect(result.summary).toContain('NOT ASSESSED (FEA_MESH_INADEQUATE');
    expect(out['overrides']).toBeUndefined();
    const check = data(execute(fixture.doc, 'check_fatigue', { caseId: fixture.caseId }, fixture.ctx));
    expect(check['status']).toBe('fail');
    expect((check['items'] as Json[]).find((entry) => entry['code'] === 'FEA_MESH_INADEQUATE')).toMatchObject({ severity: 'error' });
  });

  it('acceptInadequateMesh: true restores the numeric rows and records the override', () => {
    const fixture = stored({ adequacy: 'measured' });
    const out = data(execute(fixture.doc, 'compute_fatigue', { caseId: fixture.caseId, acceptInadequateMesh: true }, fixture.ctx));
    expect(out['overrides']).toEqual(['acceptInadequateMesh']);
    for (const row of out['rows'] as Json[]) expect(row['status']).toMatch(/^(PASS|MARGINAL|FAIL)$/);
    const check = data(execute(fixture.doc, 'check_fatigue', { caseId: fixture.caseId, acceptInadequateMesh: true }, fixture.ctx));
    expect((check['items'] as Json[]).find((entry) => entry['code'] === 'FEA_MESH_INADEQUATE')).toMatchObject({ severity: 'warning' });
  });

  it('an adequate mesh is untouched', () => {
    const fixture = stored({});
    const out = data(execute(fixture.doc, 'compute_fatigue', { caseId: fixture.caseId }, fixture.ctx));
    expect(out['status']).toMatch(/^(PASS|MARGINAL|FAIL)$/);
    expect(out['overrides']).toBeUndefined();
  });
});
