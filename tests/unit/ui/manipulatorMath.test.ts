import { describe, expect, it } from 'vitest';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import {
  axisParamFromRay,
  draggedValue,
  findBodyInReach,
  parseValueText,
  resolveExtrudeMode,
  snapToStep,
  stepForScale,
  sweptBounds,
} from '@ui/viewport/3d/manipulators/manipulatorMath';
import { createHandleDrag } from '@ui/viewport/3d/manipulators/handleDrag';
import { handleFrame, initialValue, planForSession } from '@ui/viewport/3d/manipulators/featurePlan';
import { entityBoundsInDoc } from '@core/geometry/bounds';

describe('axisParamFromRay', () => {
  it('finds where a ray crosses closest to the axis line', () => {
    // Axis: +Z from the origin. Ray from (5, 0, 3) looking along -X passes through (0, 0, 3).
    expect(axisParamFromRay([0, 0, 0], [0, 0, 1], [5, 0, 3], [-1, 0, 0])).toBeCloseTo(3);
  });
  it('is undefined for a ray parallel to the axis', () => {
    expect(axisParamFromRay([0, 0, 0], [0, 0, 1], [1, 0, 0], [0, 0, 1])).toBeNull();
  });
});

describe('value helpers', () => {
  it('snaps and clamps dragged values', () => {
    expect(snapToStep(2.37, 0.5)).toBeCloseTo(2.5);
    expect(snapToStep(2.37, 0)).toBe(2.37);
    expect(draggedValue(2, 1, 4.1, 0.5, 0.001)).toBeCloseTo(5);
    expect(draggedValue(2, 1, -9, 0.5, 0.001)).toBe(0.001);
    expect(draggedValue(2, 1, -9, 0.5, -Infinity)).toBeCloseTo(-8);
  });
  it('picks a 1-2-5 step from the part scale', () => {
    expect(stepForScale(100)).toBe(5);
    expect(stepForScale(10)).toBe(0.5);
    expect(stepForScale(0)).toBe(1);
  });
  it('parses value box text', () => {
    expect(parseValueText(' 12,5 ')).toBe(12.5);
    expect(parseValueText('-3')).toBe(-3);
    expect(parseValueText('')).toBeNull();
    expect(parseValueText('abc')).toBeNull();
  });
});

describe('resolveExtrudeMode', () => {
  it('infers join outward, cut inward, new without a body', () => {
    expect(resolveExtrudeMode('auto', 5, true)).toBe('join');
    expect(resolveExtrudeMode('auto', -5, true)).toBe('cut');
    expect(resolveExtrudeMode('auto', 5, false)).toBe('new');
  });
  it('lets an explicit choice win but never joins or cuts nothing', () => {
    expect(resolveExtrudeMode('cut', 5, true)).toBe('cut');
    expect(resolveExtrudeMode('new', -5, true)).toBe('new');
    expect(resolveExtrudeMode('join', 5, false)).toBe('new');
  });
});

describe('handle drag gesture', () => {
  it('turns pointer rays into snapped values and reports whether anything moved', () => {
    const drag = createHandleDrag({ origin: [0, 0, 0], axis: [0, 0, 1], step: 1, minimum: -Infinity });
    const rayAtHeight = (z: number): { origin: readonly [number, number, number]; direction: readonly [number, number, number] } => ({
      origin: [5, 0, z] as const,
      direction: [-1, 0, 0] as const,
    });
    expect(drag.move(rayAtHeight(1))).toBeNull();
    expect(drag.begin(rayAtHeight(2), 2)).toBe(true);
    expect(drag.move(rayAtHeight(5.2))).toBe(5);
    expect(drag.end()).toBe(true);
    expect(drag.begin(rayAtHeight(2), 2)).toBe(true);
    expect(drag.end()).toBe(false);
  });
  it('refuses a ray looking straight down the axis', () => {
    const drag = createHandleDrag({ origin: [0, 0, 0], axis: [0, 0, 1], step: 1, minimum: 0 });
    expect(drag.begin({ origin: [1, 0, 0], direction: [0, 0, 1] }, 1)).toBe(false);
  });
});

function docWithProfileAndBody(): { doc: CadDocument; rectId: string; boxId: string } {
  const rect = execute(createEmptyDocument(), 'draw_rectangle', { width: 10, height: 10 });
  const rectId = rect.affected[0] as string;
  const box = execute(rect.document, 'add_box', { size: [10, 10, 4], position: [0, 0, -2] });
  return { doc: box.document, rectId, boxId: box.affected[0] as string };
}

describe('feature plans', () => {
  it('sweeps a profile box up or down', () => {
    const swept = sweptBounds({ min: [0, 0, 0], max: [4, 4, 0] }, -3);
    expect(swept.min[2]).toBe(-3);
    expect(swept.max[2]).toBe(0);
  });

  it('plans a plain extrusion as one extrude_profile call when no body is in reach', () => {
    const rect = execute(createEmptyDocument(), 'draw_rectangle', { width: 10, height: 10 });
    const plan = planForSession(rect.document, { kind: 'extrude', targetId: rect.affected[0] as string, value: 6, modeChoice: 'auto' });
    expect(plan?.mode).toBe('new');
    expect(plan?.commit.name).toBe('extrude_profile');
    expect(plan?.commit.params).toMatchObject({ depth: 6, axis: [0, 0, 1] });
  });

  it('joins outward and cuts inward as ONE build_project (extrude then boolean)', () => {
    const { doc, rectId, boxId } = docWithProfileAndBody();
    const join = planForSession(doc, { kind: 'extrude', targetId: rectId, value: 3, modeChoice: 'auto' });
    expect(join?.mode).toBe('join');
    expect(join?.bodyId).toBe(boxId);
    expect(join?.commit.name).toBe('build_project');
    expect(JSON.stringify(join?.commit.params)).toContain('"op":"union"');
    expect(join?.preview.name).toBe('extrude_profile');

    const cut = planForSession(doc, { kind: 'extrude', targetId: rectId, value: -3, modeChoice: 'auto' });
    expect(cut?.mode).toBe('cut');
    expect(cut?.tone).toBe('cut');
    expect(cut?.commit.params).toMatchObject({
      actions: [{ params: { depth: 3, axis: [0, 0, -1] } }, { params: { op: 'subtract', b: '$tool' } }],
    });
  });

  it('plans fillet and shell with their own value param, and nothing for a zero value', () => {
    const { doc, boxId } = docWithProfileAndBody();
    expect(planForSession(doc, { kind: 'fillet', targetId: boxId, value: 0.5, modeChoice: 'auto' })?.commit).toEqual({
      name: 'fillet_edge',
      params: { id: boxId, radius: 0.5 },
    });
    expect(planForSession(doc, { kind: 'shell', targetId: boxId, value: 0.4, modeChoice: 'auto' })?.commit).toEqual({
      name: 'shell_solid',
      params: { id: boxId, thickness: 0.4 },
    });
    expect(planForSession(doc, { kind: 'fillet', targetId: boxId, value: 0, modeChoice: 'auto' })).toBeNull();
    expect(planForSession(doc, { kind: 'extrude', targetId: boxId, value: 0, modeChoice: 'auto' })).toBeNull();
  });

  it('places the handle by feature and seeds a sensible starting value', () => {
    const { doc, rectId, boxId } = docWithProfileAndBody();
    const up = handleFrame(doc, 'extrude', rectId);
    expect(up?.axis).toEqual([0, 0, 1]);
    const shell = handleFrame(doc, 'shell', boxId);
    expect(shell?.axis).toEqual([0, 0, -1]);
    expect(shell?.origin[2]).toBe(entityBoundsInDoc(doc, doc.entities[boxId]!).max[2]);
    expect(handleFrame(doc, 'fillet', 'nope')).toBeNull();
    expect(initialValue('extrude', up!)).toBeGreaterThan(0);
    expect(
      findBodyInReach(doc, { min: [20, 20, 20], max: [21, 21, 21] }, () => entityBoundsInDoc(doc, doc.entities[boxId]!), new Set()),
    ).toBeUndefined();
  });
});
