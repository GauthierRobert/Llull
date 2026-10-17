import { describe, expect, it } from 'vitest';
import { getCommand } from '@core/commands/registry';
import { OCCT_ONLY_COMMANDS, planKernelWarnings } from '../src/cli/planKernelWarning';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';

const plan = {
  actions: [
    { command: 'add_box', params: {} },
    { command: 'loop', actions: [{ command: 'fillet_edge' }, { command: 'shell_solid' }] },
  ],
};

describe('planKernelWarnings', () => {
  it('warns about commands Manifold cannot perform, including inside loops, and suggests --kernel occt', () => {
    const [warning] = planKernelWarnings(plan, 'manifold');
    expect(warning).toMatch(/fillet_edge, shell_solid/);
    expect(warning).toMatch(/--kernel occt/);
  });

  it('is silent on occt, for plans without such commands, and for non-plans', () => {
    expect(planKernelWarnings(plan, 'occt')).toEqual([]);
    expect(planKernelWarnings({ actions: [{ command: 'add_box' }] }, 'manifold')).toEqual([]);
    expect(planKernelWarnings(5, 'manifold')).toEqual([]);
  });

  it('only lists registered commands whose recipe op the manifold kernel does not support', async () => {
    for (const name of OCCT_ONLY_COMMANDS) expect(getCommand(name), name).toBeDefined();
    const kernel = await createManifoldKernel();
    for (const op of ['fillet', 'chamfer', 'shell', 'blend'] as const) expect(kernel.supports(op)).toBe(false);
  });
});
