import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { beamOnColumns, step, twoLevels } from './steelFixtures';
import { supportsOf } from './pipeSupportFixtures';
import { expectNoOp } from '../../helpers/expectNoOp';
import { xyz } from '../../helpers/xy';
import type { PipeSupportRow } from '@aec/industrial/piping/pipeSupportCheck';

/** DN100 pipe along X at y = 2000 over three beams (x = 0, 6000, 12000) of a 6 m-bay rack; pipe ends 500 mm past the outer beams. */
function rack(): ReturnType<typeof twoLevels> {
  return step(beamOnColumns([0, 6000, 12000]), 'add_pipe_run', {
    levelId: 'level-1',
    dn: 100,
    line: 'L-1',
    service: 'water',
    points: xyz(-500, 2000, 3027.15, 12500, 2000, 3027.15),
  });
}

const xOf = (doc: ReturnType<typeof rack>): number[] => supportsOf(doc).map((support) => support.position[0]);

describe('add_pipe_support spacing snapped to steel', () => {
  it('places one support on every beam the pipe crosses and warns about spans over the spacing', () => {
    const result = execute(rack(), 'add_pipe_support', { line: 'L-1', spacing: 4000 });
    const supports = supportsOf(result.document);
    expect(supports).toHaveLength(3);
    xOf(result.document).forEach((x, index) => expect(Math.abs(x - index * 6000)).toBeLessThanOrEqual(30));
    expect(supports.every((support) => support.memberId !== null)).toBe(true);
    const data = result.data as { unattached: string[]; spanWarnings: string[] };
    expect(data.unattached).toEqual([]);
    expect(data.spanWarnings.join(' ')).toContain('span 6.00 m exceeds the table span 4.30 m (x2)');
    expect(result.summary).toContain('WARNING');
    expect(result.summary).not.toContain('unattached (no steel');
    expect(result.document.order).toContain('pipeSupport-1:block');
  });
  it('warns about the table span even within the spacing, and is quiet within both', () => {
    const result = execute(rack(), 'add_pipe_support', { line: 'L-1', spacing: 6500 });
    expect((result.data as { spanWarnings: string[] }).spanWarnings.join(' ')).toContain('table span');
    const wide = execute(
      step(beamOnColumns([0, 3000, 6000]), 'add_pipe_run', {
        levelId: 'level-1',
        dn: 100,
        points: xyz(0, 2000, 3027.15, 6000, 2000, 3027.15),
      }),
      'add_pipe_support',
      { pipeId: 'pipe-1', spacing: 3500 },
    );
    expect(supportsOf(wide.document)).toHaveLength(3);
    expect((wide.data as { spanWarnings: string[] }).spanWarnings).toEqual([]);
  });
  it('snapToSteel false keeps plain spacing placement (supports away from steel are unattached)', () => {
    const result = execute(rack(), 'add_pipe_support', { line: 'L-1', spacing: 4000, snapToSteel: false });
    expect(supportsOf(result.document).length).toBeGreaterThan(3);
    expect((result.data as { unattached: string[] }).unattached.length).toBeGreaterThan(0);
  });
  it('falls back to spacing placement when the pipe crosses no steel', () => {
    const doc = step(twoLevels(), 'add_pipe_run', { levelId: 'level-1', dn: 100, points: xyz(0, 2000, 3027.15, 6000, 2000, 3027.15) });
    const result = execute(doc, 'add_pipe_support', { pipeId: 'pipe-1', spacing: 3000 });
    expect(supportsOf(result.document).length).toBeGreaterThan(1);
    expect(result.summary).toContain('crosses no steel');
    expect(result.summary).toContain('WARNING');
  });
  it('rejects an unknown memberId and keeps the document unchanged', () => {
    const doc = rack();
    expectNoOp(execute(doc, 'add_pipe_support', { line: 'L-1', spacing: 4000, memberId: 'member-99' }), doc);
  });
});

describe('check_pipe_supports with unattached supports', () => {
  it('measures spans between the unattached supports and lists them', () => {
    const doc = step(twoLevels(), 'add_pipe_run', {
      levelId: 'level-1',
      dn: 100,
      line: 'L-9',
      points: xyz(0, 2000, 3027.15, 12000, 2000, 3027.15),
    });
    const placed = step(doc, 'add_pipe_support', { pipeId: 'pipe-1', spacing: 4000 });
    const row = (execute(placed, 'check_pipe_supports', {}).data as { pipes: PipeSupportRow[] }).pipes[0] as PipeSupportRow;
    expect(row.ok).toBe(false);
    expect(row.supports).toBe(0);
    expect(row.unattached).toBeGreaterThan(0);
    expect(row.unattachedSupports).toHaveLength(row.unattached);
    expect(row.unattachedSupports[0]).toMatchObject({ mark: 'PS1', type: 'shoe' });
    expect(row.largestSpanM).toBeGreaterThan(0);
    expect(row.largestSpanM).toBeLessThan(12);
    expect((row.overhangM.start ?? 99) + (row.overhangM.end ?? 99)).toBeLessThan(12);
    expect(row.notes.join(' ')).toContain('every support is unattached');
    expect(row.issues.join(' ')).toContain('attached to no steel member');
  });
});
