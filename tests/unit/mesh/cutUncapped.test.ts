/**
 * A cap that cannot be made (DES-7c step 7, TECHNICAL_SPEC 13.12.2): when the input crosses itself near the plane the section is not a simple outline, the
 * cap triangulator leaves it open (`uncapped`, no cap triangles), and `cut_mesh` says why in its summary and what to run, instead of reporting a quiet success.
 * Found on a 1,310,720-triangle scan-like sphere whose noise makes neighbouring triangles cross at the plane.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { docWithMeshes, icosphere } from '../../helpers/meshFixtures';

type Data = Record<string, unknown>;

/** A closed, consistently wound sphere whose vertices near z = 1 are thrown about by more than an edge, so the triangles there cross one another. */
function crumpledBand(): { positions: number[]; indices: number[] } {
  const sphere = icosphere(10, 3);
  let state = 7;
  const next = (): number => ((state = (state * 1103515245 + 12345) % 2147483648), state / 2147483648);
  const positions = sphere.positions.map((value, i) =>
    i % 3 === 2 || Math.abs((sphere.positions[i - (i % 3) + 2] as number) - 1) > 1.2 ? value : value + (next() - 0.5) * 6,
  );
  return { positions, indices: sphere.indices };
}

describe('cut_mesh with a cap that cannot be made', () => {
  it('names the cause (the input crosses itself near the plane) and the next step, and still reports the count in data', () => {
    const { doc, ids } = docWithMeshes(crumpledBand());
    const result = execute(doc, 'cut_mesh', { id: ids[0] as string, plane: { origin: [0, 0, 1], normal: [0, 0, 1] } });
    expect(result.error).toBeUndefined();
    expect((result.data as Data)['uncapped']).toBeGreaterThan(0);
    expect(result.summary).toContain('crosses itself near the plane');
    expect(result.summary).toContain('repair_mesh');
  });

  it('says nothing of the kind for a clean sphere or a section the caller asked to leave open', () => {
    const { doc, ids } = docWithMeshes(icosphere(10, 3));
    const clean = execute(doc, 'cut_mesh', { id: ids[0] as string, plane: { origin: [0, 0, 1], normal: [0, 0, 1] } });
    expect((clean.data as Data)['uncapped']).toBe(0);
    expect(clean.summary).not.toContain('WARNING');
    const open = execute(doc, 'cut_mesh', { id: ids[0] as string, plane: { origin: [0, 0, 1], normal: [0, 0, 1] }, cap: false });
    expect(open.summary).not.toContain('WARNING');
  });
});
