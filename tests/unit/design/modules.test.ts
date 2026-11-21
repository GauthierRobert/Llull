import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { setGeometryKernel } from '@core/geometry/kernel';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';

const dir = new URL('../../../docs/design/08-assembly-scale/validation/plans/target_v2_modules/', import.meta.url);
const read = (f: string): string => readFileSync(new URL(f, dir), 'utf8');
beforeAll(async () => {
  setGeometryKernel(await createManifoldKernel());
});
afterAll(() => setGeometryKernel(null));

describe('probe', () => {
  it('engine', () => {
    const r = execute(createEmptyDocument(), 'apply_design', {
      source: read('engine.lld').replace(/^\s*add_connection_group.*$/gm, ''),
      modules: { 'fan.lld': read('fan.lld'), 'stage.lld': read('stage.lld').replace(/^\s*add_connection_group.*$/gm, '') },
    });
    expect(r.summary + JSON.stringify(r.error)).toBe("");
    expect(1).toBe(1);
  });
});
