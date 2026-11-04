// Message protocol of the plant BVH worker (pure): request { key, boxes } -> answer { key, buffers } with the tree's buffers transferred.

import { buildInstanceBvh, exportInstanceBvh, type InstanceBvhBuffers } from '@core/geometry/instanceBvh';

export interface BvhBuildRequest {
  readonly key: number;
  /** Packed boxes (`packBoxes`), 6 numbers per box. Transferred to the worker. */
  readonly boxes: Float64Array;
}

export interface BvhBuildAnswer {
  readonly key: number;
  readonly buffers: InstanceBvhBuffers;
}

/** Builds the tree of a request; `transfer` is the list for `postMessage`. */
export function answerBuild(request: BvhBuildRequest): { readonly answer: BvhBuildAnswer; readonly transfer: ArrayBuffer[] } {
  const buffers = exportInstanceBvh(buildInstanceBvh(request.boxes));
  return { answer: { key: request.key, buffers }, transfer: buffers.transfer };
}
