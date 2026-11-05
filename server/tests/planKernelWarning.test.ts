import { describe, expect, it } from 'vitest';
import { getCommand } from '@core/commands/registry';
import { OCCT_ONLY_COMMANDS, planKernelWarnings } from '../src/cli/planKernelWarning';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { fakeKernel } from '../../tests/helpers/fakeKernel';

const plan = {
  actions: [
    { command: 'add_box', params: {} },
    { command: 'loop', actions: [{ command: 'fillet_edge' }, { command: 'shell_solid' }] },
  ],
};

describe('planKernelWarnings', () => {
  it('warns about commands Manifold cannot perform, including inside loops, and points at the native kernel', async () => {
    const warnings = planKernelWarnings(plan, await createManifoldKernel());
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^fillet_edge cannot be performed/);
    expect(warnings[1]).toMatch(/^shell_solid cannot be performed/);
    expect(warnings[0]).toMatch(/native llull-kernel/);
  });

  it('warns once per kernel-required or kernel-optional command: boolean + mass_properties + fillet_edge give 3 warnings (VC-INT-17)', async () => {
    const mixed = {
      actions: [
        { command: 'add_box', params: {} },
        { command: 'boolean', params: {} },
        { command: 'boolean', params: {} },
        { command: 'mass_properties', params: {} },
        { command: 'fillet_edge', params: {} },
      ],
    };
    const warnings = planKernelWarnings(mixed, await createManifoldKernel());
    expect(warnings).toHaveLength(3);
    expect(warnings.join(' ')).toMatch(/boolean is kernel-optional/);
    expect(warnings.join(' ')).toMatch(/mass_properties is kernel-optional/);
    expect(warnings.join(' ')).toMatch(/fillet_edge cannot be performed/);
  });

  it('warns when no kernel is installed', () => {
    expect(planKernelWarnings(plan, null)[0]).toMatch(/active kernel/);
  });

  it('is silent on an exact kernel, for plans without such commands, and for non-plans', async () => {
    expect(planKernelWarnings(plan, fakeKernel())).toEqual([]);
    const manifold = await createManifoldKernel();
    expect(planKernelWarnings({ actions: [{ command: 'add_box' }] }, manifold)).toEqual([]);
    expect(planKernelWarnings(5, manifold)).toEqual([]);
  });

  it('only lists registered commands whose recipe op the manifold kernel does not support', async () => {
    for (const name of OCCT_ONLY_COMMANDS) expect(getCommand(name), name).toBeDefined();
    const kernel = await createManifoldKernel();
    for (const op of ['fillet', 'chamfer', 'shell', 'blend'] as const) expect(kernel.supports(op)).toBe(false);
  });
});
