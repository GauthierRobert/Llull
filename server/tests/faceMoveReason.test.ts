/**
 * DES-4c (04 DIR §13): a face move OCC cannot rebuild is refused with DIR_FACE_MOVE_FAILED and the summary carries OCC's own reason over the kernel
 * port (`GeometryKernel.lastRefusal`), on the real native kernel.
 */

import { expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { ExecutionContext } from '@core/commands/types';
import { createEmptyDocument } from '@core/model/types';
import { describeNative, liveKernels } from './kernelTestSupport';

const kernels = liveKernels();
const ctx = (): ExecutionContext => ({ ...defaultContext(), kernel: kernels.occt });

describeNative('the OCC reason of a refused face move (DES-4c, native kernel)', () => {
  it('an offset through the whole box names BRepOffset_MakeOffset in the refusal', () => {
    const box = execute(createEmptyDocument(), 'add_box', { size: [10, 10, 10] }, ctx());
    const id = box.affected[0] as string;
    const refused = execute(box.document, 'move_faces', { id, facesNear: [[0, 0, 5]], mode: 'offset', distance: -12 }, ctx());
    expect(refused.error?.code).toBe('DIR_FACE_MOVE_FAILED');
    expect(refused.summary).toContain('BRepOffset_MakeOffset failed');
    expect(refused.document).toBe(box.document);
    const moved = execute(box.document, 'move_faces', { id, facesNear: [[0, 0, 5]], mode: 'offset', distance: 1 }, ctx());
    expect(moved.affected, moved.summary).toHaveLength(1);
  }, 120_000);
});
