/** PST-M5b `analyze_pipe_stress` cursor paging: the pages concatenate to the full detail lists, the cursor is bound to the analysis inputs. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { apply, expectRefusal } from '../../../helpers/commandAssertions';
import { recordedModel } from './m3Fixtures';

interface Page {
  limit: number;
  offset: number;
  total: Record<string, number>;
  nextCursor: string | null;
}
interface Data {
  details?: Record<string, unknown[]>;
  page?: Page;
}

const INCLUDE = ['displacements', 'reactions', 'stresses'];

describe('analyze_pipe_stress limit / cursor', () => {
  const { doc, id } = recordedModel();
  const full = execute(doc, 'analyze_pipe_stress', { modelId: id, include: INCLUDE }).data as Data;

  it('without a limit the details are whole and there is no page', () => {
    expect(full.page).toBeUndefined();
    expect((full.details?.['stresses'] ?? []).length).toBeGreaterThan(4);
    expect((full.details?.['displacements'] ?? []).length).toBeGreaterThan(4);
  });

  it('walking the cursors returns every entry of every list once, in order, with constant totals', () => {
    const collected: Record<string, unknown[]> = { displacements: [], reactions: [], stresses: [] };
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const result = execute(doc, 'analyze_pipe_stress', {
        modelId: id,
        include: INCLUDE,
        limit: 3,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(result.rejected, result.summary).toBeUndefined();
      const data = result.data as Data;
      pages += 1;
      for (const key of INCLUDE) {
        expect((data.details?.[key] ?? []).length).toBeLessThanOrEqual(3);
        collected[key]?.push(...(data.details?.[key] ?? []));
        expect(data.page?.total[key]).toBe((full.details?.[key] ?? []).length);
      }
      expect(data.page?.offset).toBe((pages - 1) * 3);
      cursor = data.page?.nextCursor ?? undefined;
      if (cursor === undefined) break;
      expect(pages).toBeLessThan(100);
    }
    for (const key of INCLUDE) expect(collected[key]).toEqual(full.details?.[key]);
    expect(pages).toBe(Math.ceil(Math.max(...INCLUDE.map((key) => (full.details?.[key] ?? []).length)) / 3));
  });

  it('a limit above every list gives one page and no next cursor', () => {
    const data = execute(doc, 'analyze_pipe_stress', { modelId: id, include: INCLUDE, limit: 100000 }).data as Data;
    expect(data.page?.nextCursor).toBeNull();
    expect(data.details).toEqual(full.details);
  });

  it('the summary is unchanged by paging (same hashes), and a page past the end is empty', () => {
    const first = execute(doc, 'analyze_pipe_stress', { modelId: id, include: ['stresses'], limit: 2 });
    const total = (first.data as Data).page?.total['stresses'] as number;
    const past = execute(doc, 'analyze_pipe_stress', {
      modelId: id,
      include: ['stresses'],
      limit: 2,
      cursor: `${(full as unknown as { inputHash: string }).inputHash.slice(0, 16)}:${total + 10}`,
    });
    expect((past.data as Data).details?.['stresses']).toEqual([]);
    expect((past.data as Data).page?.nextCursor).toBeNull();
    expect((first.data as unknown as { resultHash: string }).resultHash).toBe((full as unknown as { resultHash: string }).resultHash);
  });

  it('refuses a cursor from other inputs (PST_CURSOR_STALE), a malformed one and a cursor without a limit', () => {
    const first = execute(doc, 'analyze_pipe_stress', { modelId: id, include: ['stresses'], limit: 2 }).data as Data;
    const cursor = first.page?.nextCursor as string;
    const edited = apply(doc, 'update_stress_model', { modelId: id, name: 'renamed' });
    expectRefusal(
      doc,
      'analyze_pipe_stress',
      { modelId: id, include: ['stresses'], limit: 2, cursor: 'ffffffffffffffff:2' },
      'PST_CURSOR_STALE',
    );
    const changed = apply(edited, 'set_pipe_operating_conditions', {
      modelId: id,
      installTempC: 21.1,
      temperatures: [{ name: 'T1', tempC: 80 }],
      wallMm: 6.02,
      material: { youngsModulusMPa: 200000, ShMPa: 138, ScMPa: 138, thermal: { table: 'carbon-steel-c1' } },
    });
    expectRefusal(changed, 'analyze_pipe_stress', { modelId: id, include: ['stresses'], limit: 2, cursor }, 'PST_CURSOR_STALE');
    expectRefusal(
      doc,
      'analyze_pipe_stress',
      { modelId: id, include: ['stresses'], limit: 2, cursor: 'not-a-cursor' },
      'PST_PARAM_INVALID',
    );
    expectRefusal(doc, 'analyze_pipe_stress', { modelId: id, include: ['stresses'], cursor }, 'PST_PARAM_INVALID');
    expectRefusal(doc, 'analyze_pipe_stress', { modelId: id, include: ['stresses'], limit: 0 }, 'CMD_INVALID_PARAMS');
  });
});
