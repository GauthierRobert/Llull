/**
 * @layer server/tests
 * Live OpenCascade: a fillet OCC reports "done" but that would corrupt the model is refused with a
 * reason, never committed — an invalid blend next to a tangent boss (every later boolean on it
 * spun forever), and a corner where several blends meet whose mesh has a hole (STL not watertight).
 * Fixtures are the plans that hit them while modelling Too Tall Toby drawings.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createNodeOcctKernel } from '../src/occtNode';

beforeAll(async () => setGeometryKernel(await createNodeOcctKernel()), 120_000);
afterAll(() => setGeometryKernel(null));

const plan = (name: string): unknown[] =>
  JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'fillets', name), 'utf8')) as unknown[];

function runUntilFillet(actions: unknown[]): ReturnType<typeof execute> {
  const filletAt = actions.findIndex(
    (action) => (action as { command?: string }).command === 'fillet_edge',
  );
  return execute(createEmptyDocument(), 'build_project', {
    actions: actions.slice(0, filletAt + 1),
  });
}

describe('occt fillet results are checked before they are committed', () => {
  it('refuses an invalid blend against a tangent boss (no hang downstream)', () => {
    const result = runUntilFillet(plan('tangent-boss-fillet.json'));
    expect(result.summary).toMatch(/could not round these edges into a valid solid/);
    expect(result.document.featureHistory).toHaveLength(0);
  });

  it('refuses a fillet whose corner blends leave the mesh open', () => {
    const result = runUntilFillet(plan('open-corner-handle.json'));
    expect(result.summary).toMatch(/could not be tessellated into a closed mesh/);
  });

  it('still fillets the same handle edges when the corner edges are left out', () => {
    const actions = plan('open-corner-handle.json');
    const fillet = actions.at(-1) as { params: { edgesNear: number[][] } };
    const longEdgesOnly = {
      ...fillet,
      params: { ...fillet.params, edgesNear: fillet.params.edgesNear.slice(0, -4) },
    };
    const result = runUntilFillet([...actions.slice(0, -1), longEdgesOnly]);
    expect(result.summary).toMatch(/plan step\(s\) ok|Plan complete/);
    expect(result.summary).not.toMatch(/FAIL|aborted/);
  });
});
