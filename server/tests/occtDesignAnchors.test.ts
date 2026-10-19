/** Live native OCC kernel (llull-kernel; skipped with a logged reason without the binary): a `.lld` anchor on a composite solid picks the real planar face (inspect_faces), where a bounding-box side would miss. */
import { expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import { createEmptyDocument } from '@core/model/types';
import { describeNative, liveKernels } from './kernelTestSupport';

const kernels = liveKernels();
const ctx = (kernel: 'occt' | 'manifold'): ExecutionContext => ({ ...defaultContext(), kernel: kernels[kernel] });

const L_SHAPE = `add_box base size=[100, 60, 10] position=[0, 0, 5]
add_box wall size=[100, 10, 50] on=base.top align=back
boolean body op=union a=base b=wall
add_hole bore target=body face=body.top points=[[0, 25]] pointsFrame=world_xy hole.kind=simple hole.diameter=4 extent.kind=blind extent.depth=20
check volume of=bore expect ~= 100*60*10 + 100*10*50 - pi*4*20 ± 0.1%
`;

describeNative('design anchors on the exact kernel', () => {
  it('body.top of an L-shaped union is the top of the wall (exact face), and the check passes', () => {
    const r = execute(createEmptyDocument(), 'apply_design', { source: L_SHAPE }, ctx('occt'));
    expect(r.error).toBeUndefined();
    expect(r.summary).toMatch(/1\/1 checks pass/);
  });

  it('without exact faces the same anchor is a bounding-box side: refused with the operand / kernel hint', () => {
    const r = execute(createEmptyDocument(), 'apply_design', { source: L_SHAPE }, ctx('manifold'));
    expect(r.error?.code).toBe('DESIGN_STEP_FAILED');
    expect(r.error?.remediation).toMatch(/body\.top is the centre of a side of the bounding box/);
  });
});
