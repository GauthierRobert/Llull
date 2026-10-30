/**
 * 02 SWG §16.4 (DES-2c): on the native kernel, a sweep whose path passes back through its own tube is built, and its exact volume EQUALS the
 * section-times-path integral (the overlap is integrated twice by both), so SWG_CHECK_VOLUME_MISMATCH cannot see it; the global overlap finding does.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { createNativeTestKernel, describeNativeWhen } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

interface CheckData {
  readonly status: string;
  readonly findings: ReadonlyArray<{ readonly code: string; readonly severity: string }>;
  readonly volumeChecks: ReadonlyArray<{ readonly expected: number; readonly measured: number }>;
}

describeNativeWhen({ capabilities: ['massProperties'], label: 'native sweep overlap' })(
  'a sweep through itself (native OCCT kernel)',
  () => {
    let kernel: IsolatedKernel;
    beforeAll(() => {
      kernel = createNativeTestKernel();
      setGeometryKernel(kernel);
    }, 120_000);
    afterAll(() => {
      setGeometryKernel(null);
      kernel.dispose();
    });

    it('is built, its exact volume matches the integral, and only the global overlap finding fails it', () => {
      const path = [
        [0, 0, 0],
        [60, 0, 0],
        [60, 40, 0],
        [30, 40, 0],
        [30, -30, 0],
      ];
      const made = execute(createEmptyDocument(), 'sweep_profile', { path, radius: 4, bendRadius: 8 });
      expect(made.affected, made.summary).toHaveLength(1);
      const data = execute(made.document, 'check_sweep_loft', { ids: made.affected }).data as CheckData;
      const [volume] = data.volumeChecks;
      expect(volume).toBeDefined();
      expect(Math.abs((volume?.measured ?? 0) - (volume?.expected ?? 1)) / (volume?.expected ?? 1)).toBeLessThan(1e-6);
      const codes = data.findings.filter((f) => f.severity === 'fail').map((f) => f.code);
      expect(codes).toEqual(['SWG_CHECK_SELF_INTERSECTION_GLOBAL']);
      expect(data.status).toBe('fail');
    }, 120_000);
  },
);
