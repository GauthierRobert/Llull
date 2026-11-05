/** compute_margins and check_analysis on a mesh with too few layers through the wall (FR-INT-06, TR-INT-08, VC-INT-14). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FeMeshAdequacy } from '@core/model/meshAdequacy';
import { marginBar } from './marginsFixtures';

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
const PART: FeMeshAdequacy['parts'][number] = {
  entityId: 'p',
  order: 'linear',
  elementsThrough: 2,
  minimumLayers: 1,
  tetsCrossed: 3,
  required: 4,
  samples: 400,
  verdict: 'inadequate',
};
const INADEQUATE: FeMeshAdequacy = { verdict: 'inadequate', parts: [PART], unmeasuredParts: [] };

describe('compute_margins on an inadequate mesh', () => {
  it('VC-INT-14: every row is not_assessed with FEA_MESH_INADEQUATE and the overall verdict is not pass', () => {
    const bar = marginBar({ adequacy: 'measured' });
    const result = execute(bar.recorded, 'compute_margins', { analysisId: bar.analysisId }, bar.ctx);
    expect(result.rejected).not.toBe(true);
    const table = result.data as unknown as Table;
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
    const bar = marginBar({ adequacy: 'measured' });
    const result = execute(bar.recorded, 'compute_margins', { analysisId: bar.analysisId, acceptInadequateMesh: true }, bar.ctx);
    const table = result.data as unknown as Table;
    expect(table.rows.map((row) => row.status)).toEqual(['FAIL', 'PASS']);
    expect(table.rows[0]?.ms).toBeCloseTo(-0.047619, 5);
    expect(table.overall).toBe('fail');
    expect(table.overrides).toEqual(['acceptInadequateMesh']);
    expect(table.warnings.some((text) => text.startsWith('FEA_MESH_INADEQUATE accepted by acceptInadequateMesh'))).toBe(true);
    expect(result.summary).toContain('min MS');
  });

  it('the verdict recorded on the results governs; an adequate mesh needs no override and records none', () => {
    const recordedBad = marginBar({ adequacy: INADEQUATE });
    const gated = execute(recordedBad.recorded, 'compute_margins', { analysisId: recordedBad.analysisId }, recordedBad.ctx);
    expect((gated.data as unknown as Table).rows.every((row) => row.status === 'NOT_ASSESSED')).toBe(true);
    const good = marginBar();
    const open = execute(good.recorded, 'compute_margins', { analysisId: good.analysisId, acceptInadequateMesh: true }, good.ctx);
    expect((open.data as unknown as Table).overrides).toBeUndefined();
    expect((open.data as unknown as Table).overall).toBe('fail');
    const marginal = marginBar({ adequacy: { ...INADEQUATE, verdict: 'marginal' }, ftu: 900, fty: 800 });
    const passed = execute(marginal.recorded, 'compute_margins', { analysisId: marginal.analysisId }, marginal.ctx);
    expect((passed.data as unknown as Table).overall).toBe('pass');
  });

  it('a not_assessed row cannot be dispositioned', () => {
    const bar = marginBar({ adequacy: 'measured' });
    const refused = execute(
      bar.recorded,
      'dispose_margin',
      { analysisId: bar.analysisId, rowId: 'r1', decision: 'accepted', justification: 'ok', signature: {} },
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

  it('check_analysis raises FEA_MESH_INADEQUATE as an error and does not list the unassessed margins', () => {
    const bar = marginBar({ adequacy: 'measured' });
    const check = execute(bar.recorded, 'check_analysis', { analysisId: bar.analysisId }, bar.ctx).data as {
      status: string;
      items: { code: string; severity: string }[];
    };
    expect(check.status).toBe('fail');
    expect(check.items.find((entry) => entry.code === 'FEA_MESH_INADEQUATE')?.severity).toBe('error');
    expect(check.items.some((entry) => entry.code === 'FEA_MS_NEGATIVE')).toBe(false);
  });

  it('check_analysis warns FEA_MESH_MARGINAL when only a thin spot is short of the budget', () => {
    const bar = marginBar({
      adequacy: { ...INADEQUATE, verdict: 'marginal', parts: [{ ...PART, verdict: 'marginal', elementsThrough: 5 }] },
    });
    const items = (
      execute(bar.recorded, 'check_analysis', { analysisId: bar.analysisId }, bar.ctx).data as {
        items: { code: string; severity: string }[];
      }
    ).items;
    expect(items.find((entry) => entry.code === 'FEA_MESH_MARGINAL')?.severity).toBe('warning');
  });
});
