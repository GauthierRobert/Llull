/** compute_margins and check_analysis on a mesh with too few layers through the wall (FR-INT-06, TR-INT-08, VC-INT-14). The mesh is always measured. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FeMeshArtifact } from '@core/model/analysis';
import type { FeMeshAdequacy } from '@core/model/meshAdequacy';
import { blockMesh, unionMesh } from './adequacyFixtures';
import { marginBar, STAND_IN_MESH, type MarginBar } from './marginsFixtures';

interface Row {
  rowId: string;
  status: string;
  state?: string;
  code?: string;
  ms: number | null;
  disposition: string;
}
interface Table {
  rows: Row[];
  overall: string;
  overrides?: string[];
  meshAdequacy: FeMeshAdequacy;
  warnings: string[];
}
const tableOf = (result: { data?: unknown }): Table => result.data as unknown as Table;

/** The 2 x 1 x 1 bar on a real lattice of cells of 1 / `perDepth` mm (so `perDepth` layers through its 1 mm depth), measured, no stamp. */
const lattice =
  (perDepth: number) =>
  (boxId: string): FeMeshArtifact =>
    blockMesh([2 * perDepth, perDepth, perDepth], [2, 1, 1], { entityId: boxId });

/** 4 layers over the bar plus a cube of the same part on under 5 % of the surface: 2 cells (2 layers, marginal) or 1 cell (1 layer, below the half-budget floor). */
const withCube =
  (cells: number, side: number) =>
  (boxId: string): FeMeshArtifact =>
    unionMesh(
      blockMesh([8, 4, 4], [2, 1, 1], { entityId: boxId }),
      blockMesh([cells, cells, cells], [side, side, side], { entityId: boxId }),
    );

const margins = (bar: MarginBar, params: Record<string, unknown> = {}): ReturnType<typeof execute> =>
  execute(bar.recorded, 'compute_margins', { analysisId: bar.analysisId, ...params }, bar.ctx);

describe('compute_margins on an inadequate mesh', () => {
  it('VC-INT-14: every row is not_assessed with FEA_MESH_INADEQUATE and the overall verdict is not pass', () => {
    const result = margins(marginBar());
    expect(result.rejected).not.toBe(true);
    const table = tableOf(result);
    expect(table.rows.length).toBeGreaterThan(0);
    for (const row of table.rows)
      expect(row).toMatchObject({
        status: 'NOT_ASSESSED',
        state: 'not_assessed',
        code: 'FEA_MESH_INADEQUATE',
        ms: null,
        disposition: 'none',
      });
    expect(table.overall).toBe('not_assessed');
    expect(table.meshAdequacy.verdict).toBe('inadequate');
    expect(table.overrides).toBeUndefined();
    expect(result.summary).toContain('NOT ASSESSED (FEA_MESH_INADEQUATE');
    expect(result.summary).not.toContain('min MS');
    expect(table.warnings[0]).toContain('FEA_MESH_INADEQUATE');
    expect(result.summary).not.toContain('dispositioned by a human');
  });

  it('acceptInadequateMesh: true restores the numeric states and records the override', () => {
    const result = margins(marginBar(), STAND_IN_MESH);
    const table = tableOf(result);
    expect(table.rows.map((row) => row.status)).toEqual(['FAIL', 'PASS']);
    expect(table.rows[0]?.ms).toBeCloseTo(-0.047619, 5);
    expect(table.overall).toBe('fail');
    expect(table.overrides).toEqual(['acceptInadequateMesh']);
    expect(table.warnings.some((text) => text.startsWith('FEA_MESH_INADEQUATE accepted by acceptInadequateMesh'))).toBe(true);
    expect(result.summary).toContain('min MS');
  });

  it('a forged adequate verdict (or an empty {}) recorded on the results gates nothing: the mesh is measured', () => {
    for (const recordedAdequacy of [{ verdict: 'adequate', parts: [], unmeasuredParts: [] }, {}]) {
      const table = tableOf(margins(marginBar({ recordedAdequacy })));
      expect(table.rows.every((row) => row.status === 'NOT_ASSESSED')).toBe(true);
      expect(table.overall).toBe('not_assessed');
      expect(table.meshAdequacy.verdict).toBe('inadequate');
    }
  });

  it('a not_assessed row cannot be dispositioned', () => {
    const bar = marginBar();
    const refused = execute(
      bar.recorded,
      'dispose_margin',
      { analysisId: bar.analysisId, rowId: 'r1', decision: 'accepted', justification: 'ok', confirmation: {} },
      { ...bar.ctx, humanSignature: { verify: () => ({ signer: 'Dr. Reviewer', signatureId: 'sig' }) } },
    );
    expect(refused.rejected).toBe(true);
    expect(refused.error?.code).toBe('FEA_MESH_INADEQUATE');
    const payload = execute(
      bar.recorded,
      'margin_disposition_payload',
      { analysisId: bar.analysisId, rowId: 'r1', decision: 'accepted', justification: 'ok' },
      bar.ctx,
    );
    expect(payload.error?.code).toBe('FEA_MESH_INADEQUATE');
  });

  it('check_analysis raises FEA_MESH_INADEQUATE as an error and does not list the unassessed margins unless the mesh is accepted', () => {
    const bar = marginBar();
    type Check = { status: string; items: { code: string; severity: string }[] };
    const check = execute(bar.recorded, 'check_analysis', { analysisId: bar.analysisId }, bar.ctx).data as Check;
    expect(check.status).toBe('fail');
    expect(check.items.find((entry) => entry.code === 'FEA_MESH_INADEQUATE')?.severity).toBe('error');
    expect(check.items.some((entry) => entry.code === 'FEA_MS_NEGATIVE')).toBe(false);
    const accepted = execute(bar.recorded, 'check_analysis', { analysisId: bar.analysisId, ...STAND_IN_MESH }, bar.ctx).data as Check;
    expect(accepted.items.some((entry) => entry.code === 'FEA_MS_NEGATIVE')).toBe(true);
    expect(accepted.items.find((entry) => entry.code === 'FEA_MESH_INADEQUATE')?.severity).toBe('error');
  });
});

describe('compute_margins on a MEASURED mesh (no stamp, no opt-in): the bar on a lattice of cells', () => {
  it('4 layers through the depth: adequate, numeric rows, no override, no mesh warning', () => {
    const result = margins(marginBar({ lattice: lattice(4) }));
    const table = tableOf(result);
    expect(table.meshAdequacy.verdict).toBe('adequate');
    expect(table.meshAdequacy.parts[0]?.elementsThrough).toBeCloseTo(4, 6);
    expect(table.overrides).toBeUndefined();
    expect(table.rows.map((row) => row.status)).toEqual(['FAIL', 'PASS']);
    expect(table.rows[0]?.ms).toBeCloseTo(300 / (210 * 1.5) - 1, 6);
    expect(table.rows[1]?.ms).toBeCloseTo(250 / 210 - 1, 6);
    expect(table.overall).toBe('fail');
    expect(table.warnings.some((text) => text.startsWith('FEA_MESH'))).toBe(false);
    expect(result.summary).toContain('min MS');
  });

  it('3 layers through the depth: inadequate, every row not assessed', () => {
    const table = tableOf(margins(marginBar({ lattice: lattice(3) })));
    expect(table.meshAdequacy.verdict).toBe('inadequate');
    expect(table.rows.every((row) => row.status === 'NOT_ASSESSED')).toBe(true);
  });

  it('a 2-layer spot on under 5 % of the surface is marginal: numeric rows, FEA_MESH_MARGINAL in the warnings, summary and check_analysis, never gated', () => {
    const bar = marginBar({ lattice: withCube(2, 0.25), ftu: 900, fty: 800 });
    const result = margins(bar);
    const table = tableOf(result);
    expect(table.meshAdequacy.verdict).toBe('marginal');
    expect(table.rows.map((row) => row.status)).toEqual(['PASS', 'PASS']);
    expect(table.overall).toBe('pass');
    expect(table.warnings.some((text) => text.startsWith('FEA_MESH_MARGINAL'))).toBe(true);
    expect(result.summary).toContain('FEA_MESH_MARGINAL');
    const check = execute(bar.recorded, 'check_analysis', { analysisId: bar.analysisId }, bar.ctx).data as {
      items: { code: string; severity: string }[];
    };
    expect(check.items.find((entry) => entry.code === 'FEA_MESH_MARGINAL')?.severity).toBe('warning');
  });

  it('hard floor: a 1-layer rib on under 5 % of the surface is inadequate although the 5th percentile reads 4 layers', () => {
    const table = tableOf(margins(marginBar({ lattice: withCube(1, 0.125) })));
    expect(table.meshAdequacy.verdict).toBe('inadequate');
    expect(table.meshAdequacy.parts[0]?.elementsThrough).toBeCloseTo(4, 6);
    expect(table.rows.every((row) => row.status === 'NOT_ASSESSED')).toBe(true);
  });

  it('no artifact store is a refusal, never a pass', () => {
    const bar = marginBar({ lattice: lattice(4) });
    const result = execute(bar.recorded, 'compute_margins', { analysisId: bar.analysisId }, { ...bar.ctx, feaArtifacts: null });
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe('FEA_RESULTS_MISSING');
  });
});
