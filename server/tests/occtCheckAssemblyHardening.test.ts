/** Live OpenCascade: containment inside a compound part and contact with curved parts (review fixes to check_assembly). */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { CheckResult } from '@core/model/checkResult';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { liveKernels } from './kernelTestSupport';

const kernels = liveKernels();
const ctx = (): ExecutionContext => ({ ...defaultContext(), kernel: kernels.occt });

function builder(): { run: (name: string, params: Record<string, unknown>) => string; doc: () => CadDocument } {
  let doc = createEmptyDocument();
  return {
    doc: () => doc,
    run: (name, params) => {
      const result: CommandResult = execute(doc, name, params, ctx());
      expect(result.rejected, result.summary).toBeUndefined();
      doc = result.document;
      return result.affected[0] ?? '';
    },
  };
}

describe('check_assembly on OCC, review fixes', () => {
  it('a small box fully inside one solid of a compound frame, without contact, is FPR_PAIR_CONTAINED', () => {
    const b = builder();
    const big = b.run('add_box', { size: [40, 40, 40], position: [0, 0, 0] });
    const far = b.run('add_box', { size: [10, 10, 10], position: [200, 0, 0] });
    const frame = b.run('boolean', { op: 'union', a: big, b: far });
    const inner = b.run('add_box', { size: [10, 10, 10], position: [0, 0, 0] });
    const data = execute(b.doc(), 'check_assembly', { includeJoints: false }, ctx()).data as CheckResult;
    const contained = data.items.find((item) => item.code === 'FPR_PAIR_CONTAINED');
    expect(contained?.ids).toEqual([frame, inner].sort());
    expect(contained?.values['overlapVolumeMm3']).toBeCloseTo(1000, 1);
  });

  it('a sphere 0.0005 mm above a plate is touching: curved bounds are not short by the chord error', () => {
    const b = builder();
    const plate = b.run('add_box', { size: [100, 100, 2], position: [0, 0, 0] });
    const ball = b.run('add_sphere', { radius: 10, position: [0, 0, 11.0005] });
    const data = execute(b.doc(), 'check_assembly', { includeJoints: false }, ctx()).data as CheckResult;
    const touch = data.items.find((item) => item.code === 'FPR_PAIR_TOUCH');
    expect(touch?.ids).toEqual([plate, ball].sort());
    expect(touch?.values['minDistanceMm']).toBeCloseTo(0.0005, 6);
  });
});
