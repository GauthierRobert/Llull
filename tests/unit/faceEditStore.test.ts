import { beforeEach, describe, expect, it } from 'vitest';
import { useFaceEditStore } from '@ui/store/faceEditStore';
import type { FacePick } from '@ui/viewport/3d/faceEdit/faceEditModel';
import { faceCommand } from '@ui/viewport/3d/faceEdit/faceEditModel';

const pick = (z: number): FacePick => ({ point: [0, 0, z], normal: [0, 0, 1], lever: z });
const store = (): ReturnType<typeof useFaceEditStore.getState> => useFaceEditStore.getState();

describe('face edit store: feature move picks', () => {
  beforeEach(() => {
    store().stop();
    store().start();
    store().setOp('move_feature');
  });

  it('a new pick forgets the faces Shift-clicked before it, so the command never names faces the user did not pick', () => {
    store().setPick('e1', pick(1), [0, 1]);
    store().addFeatureFace([5, 0, 0], [10, 11]);
    store().addFeatureFace([6, 0, 0], [20]);
    expect(store().also).toEqual([
      [5, 0, 0],
      [6, 0, 0],
    ]);
    expect(store().region).toEqual([0, 1, 10, 11, 20]);
    store().setVector([1, 0, 0]);
    store().setPick('e1', pick(3), [30, 31]);
    expect(store().also).toEqual([]);
    expect(store().extras).toEqual([]);
    expect(store().vector).toBeNull();
    expect(store().region).toEqual([30, 31]);
    const command = faceCommand('move_feature', 'e1', store().pick as FacePick, 1, { also: store().also, vector: [1, 0, 0] });
    expect(command?.params['facesNear']).toEqual([[0, 0, 3]]);
  });

  it('Shift-clicking an added face again removes it and its triangles; the picked face itself stays', () => {
    store().setPick('e1', pick(1), [0, 1]);
    store().addFeatureFace([5, 0, 0], [10, 11]);
    store().addFeatureFace([5, 0.2, 0], [11, 12]);
    expect(store().also).toEqual([]);
    expect(store().region).toEqual([0, 1]);
    store().addFeatureFace([5, 0, 0], [10, 11]);
    store().addFeatureFace([6, 0, 0], [20]);
    expect(store().region).toEqual([0, 1, 10, 11, 20]);
  });

  it('changing the operation, or stopping, drops the added faces; the kernel labels outlive a cleared pick but not the mode', () => {
    store().setPick('e1', pick(1), [0, 1]);
    store().addFeatureFace([5, 0, 0], [10]);
    store().setOp('offset');
    expect(store().also).toEqual([]);
    expect(store().region).toEqual([0, 1]);
    const labels = { entity: { id: 'e1' } as never, value: { faceOfTriangle: [0], trianglesOfFace: new Map([[0, [0]]]) } };
    store().setLabels(labels);
    store().clearPick();
    expect(store().labels).toBe(labels);
    store().stop();
    expect(store().labels).toBeNull();
  });
});
