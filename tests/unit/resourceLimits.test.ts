import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import {
  MAX_COPIES_PER_COMMAND,
  MAX_PROFILE_POINTS,
  MAX_REVOLVE_SEGMENTS,
} from '@core/commands/limits';

const ring = (count: number): Array<[number, number]> =>
  Array.from({ length: count }, (_, i): [number, number] => [
    10 * Math.cos((2 * Math.PI * i) / count),
    10 * Math.sin((2 * Math.PI * i) / count),
  ]);

const empty = createEmptyDocument();

describe('point-count limits', () => {
  it('draw_polyline accepts MAX_PROFILE_POINTS and refuses one more', () => {
    const ok = execute(empty, 'draw_polyline', { points: ring(MAX_PROFILE_POINTS) });
    expect(ok.affected).toHaveLength(1);
    const refused = execute(empty, 'draw_polyline', { points: ring(MAX_PROFILE_POINTS + 1) });
    expect(refused.document).toBe(empty);
    expect(refused.summary).toContain('MAX_PROFILE_POINTS');
  });

  it('extrude_profile accepts MAX_PROFILE_POINTS and refuses one more', () => {
    expect(
      execute(empty, 'extrude_profile', { profile: ring(MAX_PROFILE_POINTS), depth: 1 }).affected,
    ).toHaveLength(1);
    const refused = execute(empty, 'extrude_profile', {
      profile: ring(MAX_PROFILE_POINTS + 1),
      depth: 1,
    });
    expect(refused.document).toBe(empty);
    expect(refused.summary).toContain('MAX_PROFILE_POINTS');
  });

  it('revolve_profile refuses an oversized profile', () => {
    const refused = execute(empty, 'revolve_profile', {
      profile: ring(MAX_PROFILE_POINTS + 1).map(([x, y]): [number, number] => [Math.abs(x) + 1, y]),
    });
    expect(refused.document).toBe(empty);
    expect(refused.summary).toContain('MAX_PROFILE_POINTS');
  });

  it('array_along_path refuses an oversized path', () => {
    const box = execute(empty, 'add_box', { size: [1, 1, 1] });
    const path = Array.from({ length: MAX_PROFILE_POINTS + 1 }, (_, i) => [i, 0, 0]);
    const refused = execute(box.document, 'array_along_path', {
      sourceId: box.affected[0]!,
      path,
      count: 2,
    });
    expect(refused.document).toBe(box.document);
    expect(refused.summary).toContain('MAX_PROFILE_POINTS');
  });
});

describe('revolve segments limit', () => {
  const profile = [
    [1, 0],
    [2, 0],
    [2, 1],
  ];

  it('accepts MAX_REVOLVE_SEGMENTS', () => {
    const result = execute(empty, 'revolve_profile', { profile, segments: MAX_REVOLVE_SEGMENTS });
    expect(result.affected).toHaveLength(1);
  });

  it('refuses more than MAX_REVOLVE_SEGMENTS', () => {
    const refused = execute(empty, 'revolve_profile', {
      profile,
      segments: MAX_REVOLVE_SEGMENTS + 1,
    });
    expect(refused.document).toBe(empty);
    expect(refused.summary).toContain('MAX_REVOLVE_SEGMENTS');
  });
});

describe('copy-count limits (existing caps stay in force)', () => {
  const box = execute(empty, 'add_box', { size: [1, 1, 1] });
  const id = box.affected[0]!;

  it('array_linear accepts MAX_COPIES_PER_COMMAND and refuses one more', () => {
    const ok = execute(box.document, 'array_linear', {
      id,
      count: MAX_COPIES_PER_COMMAND,
      offset: [2, 0, 0],
    });
    expect(ok.affected).toHaveLength(MAX_COPIES_PER_COMMAND - 1);
    const refused = execute(box.document, 'array_linear', {
      id,
      count: MAX_COPIES_PER_COMMAND + 1,
      offset: [2, 0, 0],
    });
    expect(refused.document).toBe(box.document);
  });
});
