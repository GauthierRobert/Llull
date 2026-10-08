import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

const many = <T>(count: number, make: (index: number) => T): T[] =>
  Array.from({ length: count }, (_, index) => make(index));

const expectRefused = (doc: CadDocument, name: string, params: Record<string, unknown>): string => {
  const result = execute(doc, name, params);
  expect(result.document, name).toBe(doc);
  expect(result.affected).toEqual([]);
  return result.summary;
};

describe('resource limits: generators refuse bombs with a clear summary', () => {
  it('add_grid_system caps the bays per direction at 100', () => {
    const doc = createEmptyDocument();
    expect(
      expectRefused(doc, 'add_grid_system', {
        xSpacings: many(101, () => 1000),
        ySpacings: [1000],
      }),
    ).toMatch(/at most 100 bays per direction \(got 101 x, 1 y\)/);
    const ok = execute(doc, 'add_grid_system', {
      xSpacings: many(100, () => 1000),
      ySpacings: many(100, () => 1000),
    });
    expect(ok.affected.length).toBeGreaterThan(0);
  });

  it('draw_walls caps the outline at 500 points', () => {
    const points = many(501, (index) => [index * 100, (index % 2) * 100]);
    expect(expectRefused(createEmptyDocument(), 'draw_walls', { points })).toMatch(
      /at most 500 points per call \(got 501\)/,
    );
  });

  it('add_pipe_run and add_cable_tray cap a run at 1000 points', () => {
    const points = many(1001, (index) => [index * 100, (index % 2) * 100, 1000]);
    const doc = createEmptyDocument();
    expect(expectRefused(doc, 'add_pipe_run', { points })).toMatch(/at most 1000 points per run/);
    expect(expectRefused(doc, 'add_cable_tray', { points })).toMatch(/at most 1000 points per run/);
  });

  it('add_panel caps the outline at 500 corners and still takes a 500-corner polygon', () => {
    const circle = (count: number): number[][] =>
      many(count, (index) => {
        const angle = (index / count) * 2 * Math.PI;
        return [Math.cos(angle) * 5000, Math.sin(angle) * 5000, 3000];
      });
    const doc = createEmptyDocument();
    expect(expectRefused(doc, 'add_panel', { corners: circle(501) })).toMatch(
      /at most 500 corners \(got 501\)/,
    );
    expect(execute(doc, 'add_panel', { corners: circle(500) }).affected.length).toBeGreaterThan(0);
  });

  it('add_pipe_support refuses a spacing that would crowd a run, and too many points', () => {
    let doc = execute(createEmptyDocument(), 'add_pipe_run', {
      points: [
        [0, 0, 1000],
        [100000, 0, 1000],
      ],
      dn: 100,
    }).document;
    expect(expectRefused(doc, 'add_pipe_support', { pipeId: 'pipe-1', spacing: 1 })).toMatch(
      /would put over 500 supports on .* use a larger spacing/,
    );
    const at = many(501, (index) => [index * 100, 0, 1000]);
    expect(expectRefused(doc, 'add_pipe_support', { pipeId: 'pipe-1', at })).toMatch(
      /at most 500 points per call \(got 501\)/,
    );
    doc = execute(doc, 'add_steel_member', {
      profile: 'IPE300',
      role: 'beam',
      start: [0, 0, 500],
      end: [100000, 0, 500],
    }).document;
    const ok = execute(doc, 'add_pipe_support', { pipeId: 'pipe-1', spacing: 5000 });
    expect(ok.affected.length).toBeGreaterThan(0);
  });
});
