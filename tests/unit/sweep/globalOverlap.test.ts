import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { OVERLAP_CHECK_TRIANGLES } from '@core/commands/surface/checkOverlap';
import { expectPure } from '../../helpers/expectNoOp';

interface CheckData {
  readonly status: string;
  readonly findings: ReadonlyArray<{
    readonly code: string;
    readonly severity: string;
    readonly value: number | null;
    readonly message: string;
  }>;
}

const sweepAlong = (path: number[][], radius: number, bendRadius: number): { doc: ReturnType<typeof createEmptyDocument>; id: string } => {
  const made = execute(createEmptyDocument(), 'sweep_profile', { path, radius, bendRadius });
  expect(made.affected, made.summary).toHaveLength(1);
  return { doc: made.document, id: made.affected[0] as string };
};

const globalFindings = (data: CheckData): CheckData['findings'] =>
  data.findings.filter((f) => f.code === 'SWG_CHECK_SELF_INTERSECTION_GLOBAL');

describe('check_sweep_loft finds a sweep whose path passes back through its own tube (DES-2c, 02 SWG §16.4)', () => {
  it('a path that crosses itself fails with the crossing pair count; the volume check could not see it', () => {
    const { doc, id } = sweepAlong(
      [
        [0, 0, 0],
        [60, 0, 0],
        [60, 40, 0],
        [30, 40, 0],
        [30, -30, 0],
      ],
      4,
      8,
    );
    const checked = execute(doc, 'check_sweep_loft', { ids: [id] });
    const data = checked.data as CheckData;
    expect(data.status).toBe('fail');
    const [finding] = globalFindings(data);
    expect(finding).toMatchObject({ severity: 'fail' });
    expect(finding?.value).toBeGreaterThan(0);
    expect(finding?.message).toContain('passes through itself');
    expectPure(doc, () => execute(doc, 'check_sweep_loft', { ids: [id] }));
  });

  it('an L-shaped path, a U-turn wider than the section and a closed ring stay clean', () => {
    for (const [path, closed] of [
      [
        [
          [0, 0, 0],
          [40, 0, 0],
          [40, 40, 0],
        ],
        false,
      ],
      [
        [
          [0, 0, 0],
          [40, 0, 0],
          [40, 30, 0],
          [0, 30, 0],
        ],
        false,
      ],
      [
        [
          [0, 0, 0],
          [40, 0, 0],
          [40, 40, 0],
          [0, 40, 0],
        ],
        true,
      ],
    ] as const) {
      const made = execute(createEmptyDocument(), 'sweep_profile', { path, radius: 4, bendRadius: 8, closed });
      const data = execute(made.document, 'check_sweep_loft', { ids: made.affected }).data as CheckData;
      expect(globalFindings(data), JSON.stringify(path)).toEqual([]);
    }
  });

  it('a sweep above the triangle limit is not searched and says so (info)', () => {
    const turns = Array.from({ length: 400 }, (_, k) => [k * 12, k % 2 === 0 ? 0 : 30, 0]);
    const made = execute(createEmptyDocument(), 'sweep_profile', { path: turns, radius: 2, bendRadius: 5 });
    const data = execute(made.document, 'check_sweep_loft', { ids: made.affected }).data as CheckData;
    const [finding] = globalFindings(data);
    expect(finding).toMatchObject({ severity: 'info' });
    expect(finding?.value).toBeGreaterThan(OVERLAP_CHECK_TRIANGLES);
  });
});
