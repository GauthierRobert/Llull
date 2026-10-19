/** Every toolset has a `.lld` example (packages/design-lang/examples) that applies on the default kernel with all its checks passing. */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { setGeometryKernel } from '@core/geometry/kernel';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { TOOLSET_NAMES } from '@protocol/toolsets';
import type { CheckResult } from '@design/checks';

const dir = join(import.meta.dirname, '..', '..', '..', 'packages', 'design-lang', 'examples');
const examples = readdirSync(dir).filter((name) => name.endsWith('.lld'));

beforeAll(async () => {
  setGeometryKernel(await createManifoldKernel());
});
afterAll(() => setGeometryKernel(null));

describe('examples', () => {
  it('cover every toolset except design itself', () => {
    expect(examples.map((name) => name.replace(/\.lld$/, '')).sort()).toEqual(TOOLSET_NAMES.filter((t) => t !== 'design').sort());
  });

  it.each(examples)('%s applies, its checks pass, check_design agrees, and it regenerates', (name) => {
    const source = readFileSync(join(dir, name), 'utf8');
    const applied = execute(createEmptyDocument(), 'apply_design', { source });
    expect(applied.error, applied.summary).toBeUndefined();
    const checks = (applied.data as { checks: CheckResult[] }).checks;
    expect(checks.length).toBeGreaterThanOrEqual(3);
    expect(checks.filter((c) => !c.pass)).toEqual([]);
    expect(execute(applied.document, 'check_design', {}).error).toBeUndefined();
    const replayed = execute(applied.document, 'replay_history', {});
    expect(replayed.error, replayed.summary).toBeUndefined();
    // Same entities (count): a plain import_dxf step re-mints its ids on replay too (its layer is carried, core history/carry.ts).
    expect(replayed.document.order).toHaveLength(applied.document.order.length);
    expect(execute(replayed.document, 'check_design', {}).error).toBeUndefined();
  });
});
