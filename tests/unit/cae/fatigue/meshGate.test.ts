/** FE hot-spot fatigue on a mesh with too few layers through the wall (FR-INT-06): rows are not assessed, never pass, unless accepted. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { isEvaluationFailure } from '@cae/fatigue/evaluate';
import { fatigueFieldArtifact, fatigueFieldInput } from '@cae/fatigue/feField';
import { fatigueFieldReference } from '../../../helpers/fatigueFieldOracle';
import { blockMesh, unionMesh } from '../adequacyFixtures';
import { feFatigue, type FeFatigue } from './feFixtures';

type Json = Record<string, unknown>;
const data = (result: { data?: unknown }): Json => (result.data ?? {}) as Json;

/** A 2-layer C3D4 grid (4 x 2 x 2 cells of 0.5 mm over the 1 mm depth): measured inadequate (C3D4 needs 4). */
const COARSE = { cells: [4, 2, 2] } as const;

/** The fixture with its field stored. */
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
    const fixture = stored(COARSE);
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
    const fixture = stored(COARSE);
    const out = data(execute(fixture.doc, 'compute_fatigue', { caseId: fixture.caseId, acceptInadequateMesh: true }, fixture.ctx));
    expect(out['overrides']).toEqual(['acceptInadequateMesh']);
    for (const row of out['rows'] as Json[]) expect(row['status']).toMatch(/^(PASS|MARGINAL|FAIL)$/);
    const check = data(execute(fixture.doc, 'check_fatigue', { caseId: fixture.caseId, acceptInadequateMesh: true }, fixture.ctx));
    expect((check['items'] as Json[]).find((entry) => entry['code'] === 'FEA_MESH_INADEQUATE')).toMatchObject({ severity: 'warning' });
  });

  it('a forged adequate verdict recorded on the results gates nothing: the mesh is measured', () => {
    const forged = { verdict: 'adequate', parts: [], unmeasuredParts: [] };
    for (const recordedAdequacy of [forged, {}]) {
      const fixture = stored({ ...COARSE, recordedAdequacy });
      const out = data(execute(fixture.doc, 'compute_fatigue', { caseId: fixture.caseId }, fixture.ctx));
      expect(out['status']).toBe('NOT_ASSESSED');
      expect((out['meshAdequacy'] as Json)['verdict']).toBe('inadequate');
    }
  });

  it('a MEASURED adequate mesh (8 x 4 x 4 cells, 4 layers through the depth, no stamp) drives compute_fatigue to numeric hot spots', () => {
    const fixture = stored({});
    const result = execute(fixture.doc, 'compute_fatigue', { caseId: fixture.caseId }, fixture.ctx);
    const out = data(result);
    expect((out['meshAdequacy'] as Json)['verdict']).toBe('adequate');
    expect(out['status']).toMatch(/^(PASS|MARGINAL|FAIL)$/);
    expect(out['overrides']).toBeUndefined();
    expect(Number.isFinite(out['minMargin'] as number)).toBe(true);
    const rows = out['rows'] as Json[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row['code']).not.toBe('FEA_MESH_INADEQUATE');
      expect(row['margin'] === null || Number.isFinite(row['margin'] as number)).toBe(true);
    }
    expect(result.summary).not.toContain('NOT ASSESSED');
  });

  it('a marginal mesh (a 2-layer spot on under 5 % of the surface of a 4-layer part) is computed, with FEA_MESH_MARGINAL in the warnings, items and summary', () => {
    const mesh = unionMesh(blockMesh([16, 8, 8], [4, 2, 2]), blockMesh([2, 2, 2], [0.5, 0.5, 0.5]));
    const grid = { nodes: mesh.nodes, elements: mesh.blocks.flatMap((block) => block.elements.map((element) => element.slice(1))) };
    const fixture = stored({ grid });
    const result = execute(fixture.doc, 'compute_fatigue', { caseId: fixture.caseId }, fixture.ctx);
    const out = data(result);
    expect((out['meshAdequacy'] as Json)['verdict']).toBe('marginal');
    expect(out['status']).toMatch(/^(PASS|MARGINAL|FAIL)$/);
    expect((out['warnings'] as string[])[0]).toContain('FEA_MESH_MARGINAL');
    expect((out['items'] as Json[]).find((entry) => entry['code'] === 'FEA_MESH_MARGINAL')).toMatchObject({ severity: 'warning' });
    expect(result.summary).toContain('FEA_MESH_MARGINAL');
  });
});
