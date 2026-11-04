// Builds a tile's kd-tree off the main thread. Request: { key, positions }; answer: { key, tree } with the tree's buffers transferred.

import { buildKdTree } from './kdTree';

export interface KdBuildRequest {
  readonly key: number;
  readonly positions: Float32Array;
}

self.onmessage = (event: MessageEvent<KdBuildRequest>): void => {
  const tree = buildKdTree(event.data.positions);
  const transfer = [tree.positions.buffer, tree.bounds.buffer, tree.left.buffer, tree.right.buffer, tree.start.buffer, tree.end.buffer];
  (self as unknown as Worker).postMessage({ key: event.data.key, tree }, transfer);
};
