// B-rep face handle editing (04 DIR M1), UI-only: whether the mode is on, the operation, the picked face and the drag value in flight.
// The document changes only when a drag commits ONE command through `dispatch`; the ghost comes from the backend preview.

import { create } from 'zustand';
import type { Vec3 } from '@core/model/types';
import type { FaceOp, FacePick } from '@ui/viewport/3d/faceEdit/faceEditModel';

interface FaceHover {
  /** Triangle indices of the coplanar patch under the pointer (into the target's triangles). */
  readonly region: readonly number[];
}

interface FaceEditState {
  active: boolean;
  op: FaceOp;
  /** The entity the pick belongs to; a pick of another entity is stale. */
  entityId: string | null;
  pick: FacePick | null;
  /** Triangle indices of the picked patch. */
  region: readonly number[];
  hover: FaceHover | null;
  /** Move feature: a point on each further face of the feature (Shift-click); the picked face is the first. */
  also: readonly Vec3[];
  /** Move feature: the displacement of the drag in flight. */
  vector: Vec3 | null;
  /** Signed drag value in flight (length, or degrees for a draft); null = not dragging. */
  value: number | null;
  start(): void;
  stop(): void;
  setOp(op: FaceOp): void;
  setPick(entityId: string, pick: FacePick, region: readonly number[]): void;
  clearPick(): void;
  setHover(hover: FaceHover | null): void;
  setValue(value: number | null): void;
  addFeatureFace(point: Vec3, region: readonly number[]): void;
  setVector(vector: Vec3 | null): void;
}

const NO_PICK = { entityId: null, pick: null, region: [], hover: null, value: null, also: [], vector: null } as const;

export const useFaceEditStore = create<FaceEditState>()((set) => ({
  active: false,
  op: 'push_pull',
  ...NO_PICK,
  start: () => set({ active: true, ...NO_PICK }),
  stop: () => set({ active: false, ...NO_PICK }),
  setOp: (op) => set({ op, value: null, vector: null, also: [] }),
  setPick: (entityId, pick, region) => set({ entityId, pick, region, value: null }),
  clearPick: () => set({ ...NO_PICK }),
  setHover: (hover) => set({ hover }),
  setValue: (value) => set(value === null ? { value, vector: null } : { value }),
  addFeatureFace: (point, region) =>
    set((state) => ({
      also: [...state.also, point],
      region: [...state.region, ...region.filter((index) => !state.region.includes(index))],
    })),
  setVector: (vector) => set({ vector }),
}));
