/** Live OpenCascade: check_assembly on exact B-reps (VC-FPR-01, 02, 09) and the worker-isolated kernel's analyze / distance. */
import { expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CheckResult } from '@core/model/checkResult';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { cube } from '../../tests/helpers/kernelAnalysisCases';
import { liveKernels, describeNative } from './kernelTestSupport';

const kernels = liveKernels();

describeNative('check_assembly on OCC', () => {
  const ctx = (): ExecutionContext => ({ ...defaultContext(), kernel: kernels.occt });
  const run = (doc: CadDocument, name: string, params: Record<string, unknown>): CommandResult => {
    const result = execute(doc, name, params, ctx());
    expect(result.rejected, result.summary).toBeUndefined();
    return result;
  };

  it('VC-01 / VC-02 on exact solids', () => {
    let doc = run(createEmptyDocument(), 'add_box', { size: [20, 20, 20], position: [0, 0, 0] }).document;
    doc = run(doc, 'add_box', { size: [20, 20, 20], position: [10, 0, 0] }).document;
    doc = run(doc, 'add_box', { size: [20, 20, 20], position: [50, 0, 0] }).document;
    doc = run(doc, 'add_box', { size: [20, 20, 20], position: [70, 0, 0] }).document;
    const data = run(doc, 'check_assembly', { includeJoints: false }).data as CheckResult;
    const hard = data.items.find((item) => item.code === 'FPR_PAIR_HARD');
    expect(hard?.values['overlapVolumeMm3']).toBeCloseTo(4000, 1);
    const touch = data.items.find((item) => item.code === 'FPR_PAIR_TOUCH');
    expect(touch?.values['overlapVolumeMm3']).toBe(0);
    expect(data.items.filter((item) => item.code === 'FPR_PAIR_HARD')).toHaveLength(1);
    expect(data.provenance.kernel).toBe('occt');
  });

  it('VC-09: a 10.00 mm pin in a 10.02 mm bore, coaxial with a revolute joint, is realised with 0.020 mm clearance', () => {
    let doc = createEmptyDocument();
    const add = (name: string, params: Record<string, unknown>): string => {
      const result = run(doc, name, params);
      doc = result.document;
      return result.affected[0] ?? '';
    };
    const block = add('add_box', { size: [40, 40, 40], position: [0, 0, 0] });
    const hole = add('add_cylinder', { radius: 5.01, height: 60, position: [0, 0, 0] });
    const housing = add('boolean', { op: 'subtract', a: block, b: hole });
    const pin = add('add_cylinder', { radius: 5, height: 20, position: [0, 0, 0] });
    add('add_rigid_body', { entityIds: [housing], fixed: true, id: 'housing' });
    add('add_rigid_body', { entityIds: [pin], id: 'pin' });
    add('add_body_joint', { id: 'hinge', kind: 'revolute', parent: 'housing', child: 'pin', anchor: [0, 0, 0], axis: [0, 0, 1] });
    const data = run(doc, 'check_assembly', {}).data as CheckResult;
    const joint = data.items.find((item) => item.ids.includes('hinge'));
    expect(joint?.code).toBe('FPR_JOINT_REALISED');
    expect(joint?.values['diametralClearanceMm']).toBeCloseTo(0.02, 6);
    expect(joint?.values['engagementMm']).toBeCloseTo(20, 6);
    expect(joint?.values['pinDiameterMm']).toBeCloseTo(10, 6);
    expect(data.items.some((item) => item.code === 'FPR_PAIR_HARD')).toBe(false);
  });

  it('a revolute joint without any pin / bore is FPR_JOINT_NOT_REALISED (warn)', () => {
    let doc = createEmptyDocument();
    const add = (name: string, params: Record<string, unknown>): string => {
      const result = run(doc, name, params);
      doc = result.document;
      return result.affected[0] ?? '';
    };
    const frame = add('add_box', { size: [20, 20, 20], position: [0, 0, 0] });
    const wheel = add('add_box', { size: [10, 10, 10], position: [0, 0, 30] });
    add('add_rigid_body', { entityIds: [frame], fixed: true, id: 'frame' });
    add('add_rigid_body', { entityIds: [wheel], id: 'wheel' });
    add('add_body_joint', { id: 'axle', kind: 'revolute', parent: 'frame', child: 'wheel', anchor: [0, 0, 30], axis: [0, 0, 1] });
    const data = run(doc, 'check_assembly', {}).data as CheckResult;
    expect(data.items.find((item) => item.ids.includes('axle'))).toMatchObject({ code: 'FPR_JOINT_NOT_REALISED', status: 'warn' });
  });
});

describeNative('worker-isolated OCC kernel', () => {
  it('relays analyze and distance with their extra arguments', () => {
    expect(kernels.occt.name).toBe('occt');
    const [a, b] = [
      kernels.occt.evaluate({ op: 'solid', entity: cube('a', [0, 0, 0], 20) }),
      kernels.occt.evaluate({ op: 'solid', entity: cube('b', [20.5, 0, 0], 20) }),
    ];
    expect(kernels.occt.analyze?.(a!)?.volume).toBeCloseTo(8000, 3);
    expect(kernels.occt.distance?.(a!, b!, 1)?.distance).toBeCloseTo(0.5, 6);
  }, 120_000);
});
