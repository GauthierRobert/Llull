// kd-trees of the resident snap tiles, built in a Web Worker. A tile is identified by its positions buffer; while its tree builds (or when
// no Worker exists: tests, a failed worker load) `treeFor` answers undefined and the snap falls back to the linear scan.

import type { KdTree } from './kdTree';
import type { SnapTile } from './pointSnap';
import type { KdBuildRequest } from './kdTree.worker';

/** Tiles under this many points are cheaper to scan than to index. */
const KD_MIN_POINTS = 1_000;

const trees = new WeakMap<Float32Array, KdTree>();
const pending = new Map<number, Float32Array>();
const requested = new WeakSet<Float32Array>();
let worker: Worker | null | undefined;
let nextKey = 1;

function workerOrNull(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof Worker === 'undefined') return (worker = null);
  try {
    const created = new Worker(new URL('./kdTree.worker.ts', import.meta.url), { type: 'module' });
    created.onmessage = (event: MessageEvent<{ key: number; tree: KdTree }>): void => {
      const source = pending.get(event.data.key);
      pending.delete(event.data.key);
      if (source !== undefined) trees.set(source, event.data.tree);
    };
    created.onerror = (): void => {
      worker = null;
      created.terminate();
      pending.clear();
    };
    return (worker = created);
  } catch {
    return (worker = null);
  }
}

/** Starts the build of every big tile that has no tree yet. */
export function requestTrees(tiles: readonly SnapTile[]): void {
  for (const tile of tiles) {
    const source = tile.positions;
    if (source.length < KD_MIN_POINTS * 3 || trees.has(source) || requested.has(source)) continue;
    const target = workerOrNull();
    if (target === null) return;
    requested.add(source);
    const key = nextKey++;
    pending.set(key, source);
    const request: KdBuildRequest = { key, positions: source };
    target.postMessage(request);
  }
}

/** The finished tree of a tile, or undefined (building, too small, no worker). */
export function treeFor(tile: SnapTile): KdTree | undefined {
  return trees.get(tile.positions);
}
