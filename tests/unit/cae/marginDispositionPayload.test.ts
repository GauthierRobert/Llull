/** margin_disposition_payload: the read-only hash a reviewer signs for dispose_margin. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { analysisInputHash } from '@cae/hash/inputHash';
import { marginDispositionPayload } from '@cae/margins/disposition';
import { caseIn } from './helpers';
import { marginBar } from './marginsFixtures';

const bar = marginBar();
interface Row {
  rowId: string;
  rowKey: string;
  status: string;
  ms: number | null;
}
const failRow = (execute(bar.recorded, 'compute_margins', { analysisId: bar.analysisId }, bar.ctx).data as { rows: Row[] }).rows[0] as Row;
const params = { analysisId: bar.analysisId, rowId: failRow.rowId, decision: 'accepted', justification: 'tested to 1.8 x limit' };

describe('margin_disposition_payload', () => {
  it('returns the hash dispose_margin verifies, without touching the document', () => {
    const result = execute(bar.recorded, 'margin_disposition_payload', params, bar.ctx);
    expect(result.error, result.summary).toBeUndefined();
    const expected = marginDispositionPayload(
      bar.analysisId,
      {
        rowKey: failRow.rowKey,
        status: failRow.status,
        ms: failRow.ms,
        inputHash: analysisInputHash(bar.recorded, bar.analysisId, 'full'),
      },
      'accepted',
      'tested to 1.8 x limit',
      caseIn(bar.recorded, bar.analysisId).results?.resultsHash ?? '',
    );
    expect(result.data).toMatchObject({ payloadSha256: expected, rowKey: failRow.rowKey, status: failRow.status });
    expect(result.affected).toEqual([]);
  });

  it('is pure', () => {
    const before = JSON.stringify(bar.recorded);
    const result = execute(bar.recorded, 'margin_disposition_payload', params, bar.ctx);
    expect(JSON.stringify(bar.recorded)).toBe(before);
    expect(result.document).toBe(bar.recorded);
  });

  it('refuses an unknown analysis and an unknown row', () => {
    const unknown = execute(bar.recorded, 'margin_disposition_payload', { ...params, analysisId: 'nope' }, bar.ctx);
    expect(unknown.error?.code).toBe('FEA_ANALYSIS_NOT_FOUND');
    const row = execute(bar.recorded, 'margin_disposition_payload', { ...params, rowId: 'r999' }, bar.ctx);
    expect(row.error?.code).toBe('FEA_MARGIN_ROW_NOT_FOUND');
  });
});
