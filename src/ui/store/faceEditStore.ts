// B-rep face handle editing (04 DIR M1), UI-only: whether the mode is on, the operation, the picked face and the drag value in flight.
// The document changes only when a drag commits ONE command through `dispatch`; the ghost comes from the backend preview.

import { create } from 'zustand';
import type { Entity, Vec3 } from '@core/model/types';
import type { FaceOp, FacePick } from '@ui/viewport/3d/faceEdit/faceEditModel';
import type { FaceLabels } from '@ui/viewport/3d/faceEdit/facePicking';

interface FaceHover {
  /** Triangle indices of the face under the pointer (into the target's triangles). */
  readonly region: readonly number[];
}

/** A further face of a feature move: a point on it and its triangles. */
interface FeatureFace {
  readonly point: Vec3;
  readonly region: readonly number[];
}

interface FaceEditState {
  active: boolean;
  op: FaceOp;
  /** The entity the pick belongs to; a pick of another entity is stale. */
  entityId: string | null;
  pick: FacePick | null;
  /** Triangle indices of the picked face (plus the faces added to a feature move). */
  region: readonly number[];
  /** Triangle indices of the picked face alone. */
  baseRegion: readonly number[];
  hover: FaceHover | null;
  /** Move feature: the further faces of the feature (Shift-click adds, Shift-click again removes); the picked face is the first. */
  extras: readonly FeatureFace[];
  /** Move feature: a point on each further face (the `extras` points, in order). */
  also: readonly Vec3[];
  /** Move feature: the displacement of the drag in flight. */
  vector: Vec3 | null;
  /** Signed drag value in flight (length, or degrees for a draft); null = not dragging. */
  value: number | null;
  /** The kernel's face of every display triangle of one entity version; null until `inspect_face_triangles` answered (or when it cannot). */
  labels: { readonly entity: Entity; readonly value: FaceLabels } | null;
  start(): void;
  stop(): void;
  setOp(op: FaceOp): void;
  setPick(entityId: string, pick: FacePick, region: readonly number[]): void;
  clearPick(): void;
  setHover(hover: FaceHover | null): void;
  setValue(value: number | null): void;
  addFeatureFace(point: Vec3, region: readonly number[]): void;
  setVector(vector: Vec3 | null): void;
  setLabels(labels: { readonly entity: Entity; readonly value: FaceLabels } | null): void;
}

const NO_PICK = {
  entityId: null,
  pick: null,
  region: [],
  baseRegion: [],
  hover: null,
  value: null,
  extras: [],
  also: [],
  vector: null,
} as const;

const union = (base: readonly number[], faces: readonly FeatureFace[]): number[] => [
  ...new Set([...base, ...faces.flatMap((face) => face.region)]),
];

export const useFaceEditStore = create<FaceEditState>()((set) => ({
  active: false,
  op: 'push_pull',
  ...NO_PICK,
  labels: null,
  start: () => set({ active: true, ...NO_PICK }),
  stop: () => set({ active: false, ...NO_PICK, labels: null }),
  setOp: (op) => set((state) => ({ op, value: null, vector: null, extras: [], also: [], region: state.baseRegion })),
  setPick: (entityId, pick, region) => set({ entityId, pick, region, baseRegion: region, value: null, vector: null, extras: [], also: [] }),
  clearPick: () => set({ ...NO_PICK }),
  setHover: (hover) => set({ hover }),
  setValue: (value) => set(value === null ? { value, vector: null } : { value }),
  addFeatureFace: (point, region) =>
    set((state) => {
      // the picked face itself is already part of the feature: a Shift-click on it adds nothing
      if (region.some((index) => state.baseRegion.includes(index))) return state;
      const taken = state.extras.find((face) => face.region.some((index) => region.includes(index)));
      const extras = taken === undefined ? [...state.extras, { point, region }] : state.extras.filter((face) => face !== taken);
      return { extras, also: extras.map((face) => face.point), region: union(state.baseRegion, extras) };
    }),
  setVector: (vector) => set({ vector }),
  setLabels: (labels) => set({ labels }),
}));
