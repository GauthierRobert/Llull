import { afterEach, describe, expect, it } from 'vitest';
import { getGeometryKernel, setGeometryKernel } from '@core/geometry/kernel';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { getActiveKernelName, installGeometryKernel } from '../src/geometryKernel';

afterEach(() => {
  delete process.env['LLULL_KERNEL'];
  setGeometryKernel(null);
});

describe('LLULL_KERNEL', () => {
  it('unset installs Manifold', async () => {
    delete process.env['LLULL_KERNEL'];
    expect(await installGeometryKernel()).toBe(true);
    expect(getActiveKernelName()).toBe('manifold');
    expect(getGeometryKernel()).not.toBeNull();
  });

  it('occt loads OpenCascade under Node and fillet_edge runs through the injected context', async () => {
    process.env['LLULL_KERNEL'] = 'occt';
    expect(await installGeometryKernel()).toBe(true);
    expect(getActiveKernelName()).toBe('occt');

    const base = execute(createEmptyDocument(), 'add_box', { size: [2, 2, 2] });
    const params = { id: base.affected[0]!, radius: 0.2 };
    const first = execute(base.document, 'fillet_edge', params, defaultContext());
    const second = execute(base.document, 'fillet_edge', params, defaultContext());

    expect(first.affected).toHaveLength(1);
    const entity = first.document.entities[first.affected[0]!];
    const again = second.document.entities[second.affected[0]!];
    expect(entity?.kind).toBe('mesh');
    expect(again).toMatchObject({ kind: 'mesh', mesh: expect.anything() });
    expect(JSON.stringify(again && 'mesh' in again ? again.mesh : null)).toBe(
      JSON.stringify(entity && 'mesh' in entity ? entity.mesh : null),
    );
  }, 60_000);
});
