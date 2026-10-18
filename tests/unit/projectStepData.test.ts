import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { similarNames } from '@lib/similarNames';
import { registerCommands } from '@core/commands/commandTable';
import { defineCommand, z } from '@core/commands/schema';

interface Step {
  ok: boolean;
  summary: string;
  data?: unknown;
  dataOmittedChars?: number;
}
const steps = (actions: unknown[]): Step[] =>
  (execute(createEmptyDocument(), 'build_project', { actions, onError: 'continue' }).data as { steps: Step[] }).steps;

describe('build_project step data', () => {
  it('a mutating step without data carries no data key', () => {
    const run = steps([{ command: 'draw_arc', params: { center: [0, 0], radius: 1 } }]);
    expect(run[0]).not.toHaveProperty('data');
  });

  it('keeps data of a mutating step up to the size cap and reports the size of what it dropped', () => {
    const bulky = defineCommand({
      name: 'zz_test_bulky_mutation',
      description: 'test only: mutating command returning small or huge data',
      params: z.object({ chars: z.number().describe('payload size in characters') }),
      run: (doc, { chars }) => ({
        document: { ...doc, units: 'm' as const },
        summary: 'bulk',
        affected: ['x'],
        data: { blob: 'a'.repeat(chars) },
      }),
    });
    registerCommands('test:zz', [bulky as never]);
    const [small, huge] = steps([
      { command: 'zz_test_bulky_mutation', params: { chars: 100 } },
      { command: 'zz_test_bulky_mutation', params: { chars: 9000 } },
    ]);
    expect(small?.data).toEqual({ blob: 'a'.repeat(100) });
    expect(small).not.toHaveProperty('dataOmittedChars');
    expect(huge).not.toHaveProperty('data');
    expect(huge?.dataOmittedChars).toBeGreaterThan(9000);
  });

  it('unknown commands suggest close names', () => {
    const [typo, retired] = steps([
      { command: 'draw_arcc', params: {} },
      { command: 'draw_circle', params: { center: [0, 0], radius: 1 } },
    ]);
    expect(typo?.ok).toBe(false);
    expect(typo?.summary).toMatch(/Unknown command: draw_arcc\. Did you mean: draw_arc/);
    // draw_circle was merged into draw_arc: the retired name points at its replacement first
    expect(retired?.summary).toMatch(/Unknown command: draw_circle\. Did you mean: draw_arc/);
    const [far] = steps([{ command: 'qqqqqqqqqqqqqqq', params: {} }]);
    expect(far?.summary).toBe('Unknown command: qqqqqqqqqqqqqqq');
  });
});

describe('similarNames', () => {
  const names = ['draw_arc', 'draw_circle', 'add_circle_hole', 'add_box', 'add_cylinder', 'move_entities'];
  it('ranks typos first, then shared words, at most `limit`', () => {
    expect(similarNames('draw_cirle', names)[0]).toBe('draw_circle');
    expect(similarNames('add_bx', names)).toContain('add_box');
    expect(similarNames('make_circle', names, 2)).toEqual(['draw_circle', 'add_circle_hole']);
    expect(similarNames('draw_something_long', names)).toHaveLength(2);
  });
  it('returns nothing when no name is close or shares a word', () => {
    expect(similarNames('xyzzyplugh', names)).toEqual([]);
    expect(similarNames('', [])).toEqual([]);
  });
});
