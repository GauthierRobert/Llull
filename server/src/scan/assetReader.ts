/**
 * Synchronous reader of a cloud asset written by `llull-compute cloud import` (layout: solver/crates/llull-cloud/src/asset.rs). Node blocks
 * are CRC-32 checked on read (a corrupt block reads as missing) and kept in a small LRU cache. Positions are decoded exactly as the
 * Rust store does: (rootMin + key·2^(rootBits−level) + offset)·quantum + offset.
 */

import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import path from 'node:path';
import type { CloudBounds, CloudManifest } from '@core/model/pointCloud';
import type { Vec3 } from '@core/model/vectors';
import { LruCache } from '@lib/lruCache';
import { isRecord } from '@lib/isRecord';

const RECORD_BYTES = 48;
const NO_CHILD = 0xffffffff;

export interface NodeRecord {
  readonly level: number;
  readonly key: readonly [number, number, number];
  readonly pointCount: number;
  readonly childMask: number;
  readonly byteOffset: number;
  readonly byteSize: number;
  readonly crc: number;
  readonly firstChild: number;
}

export interface NodePoints {
  readonly positions: Float64Array;
  readonly indices: Uint32Array;
}

let crcTable: Uint32Array | null = null;

/** CRC-32 (IEEE, reflected 0xEDB88320), the node block checksum. */
export function crc32(bytes: Uint8Array): number {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** The parsed manifest, or null when it is not one. */
function parseManifest(text: string): CloudManifest | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value['assetKey'] !== 'string' || typeof value['pointCount'] !== 'number' || !isRecord(value['octree']))
    return null;
  return value as unknown as CloudManifest;
}

export class AssetReader {
  private readonly cache = new LruCache<NodePoints>(64);

  private constructor(
    readonly dir: string,
    readonly manifest: CloudManifest,
    readonly nodes: readonly NodeRecord[],
  ) {}

  /** Opens an asset directory; null when a file is missing, malformed, or the manifest names another key. */
  static open(dir: string, expectedKey: string): AssetReader | null {
    try {
      const manifest = parseManifest(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      if (manifest === null || manifest.assetKey !== expectedKey) return null;
      const bytes = readFileSync(path.join(dir, 'hierarchy.bin'));
      if (bytes.length % RECORD_BYTES !== 0 || bytes.length / RECORD_BYTES !== manifest.octree.nodeCount) return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const nodes: NodeRecord[] = [];
      for (let at = 0; at < bytes.length; at += RECORD_BYTES) {
        const u32 = (offset: number): number => view.getUint32(at + offset, true);
        const u64 = (offset: number): number => u32(offset) + u32(offset + 4) * 2 ** 32;
        nodes.push({
          level: u32(0),
          key: [u32(4), u32(8), u32(12)],
          pointCount: u32(16),
          childMask: u32(20),
          byteOffset: u64(24),
          byteSize: u64(32),
          crc: u32(40),
          firstChild: u32(44),
        });
      }
      return new AssetReader(dir, manifest, nodes);
    } catch {
      return null;
    }
  }

  /** Bounds of node `i` in metres (asset frame). */
  nodeBounds(i: number): CloudBounds {
    const node = this.nodes[i];
    const { octree, quantum, offset } = this.manifest;
    if (node === undefined) return { min: [0, 0, 0], max: [0, 0, 0] };
    const edge = 2 ** (octree.rootBits - node.level);
    const low = [0, 1, 2].map((a) => ((octree.rootMin[a] ?? 0) + (node.key[a] ?? 0) * edge) * (quantum[a] ?? 0) + (offset[a] ?? 0));
    const high = [0, 1, 2].map((a) => (low[a] ?? 0) + edge * (quantum[a] ?? 0));
    return { min: [low[0] ?? 0, low[1] ?? 0, low[2] ?? 0], max: [high[0] ?? 0, high[1] ?? 0, high[2] ?? 0] };
  }

  children(i: number): number[] {
    const node = this.nodes[i];
    if (node === undefined || node.firstChild === NO_CHILD) return [];
    const count = [...node.childMask.toString(2)].filter((bit) => bit === '1').length;
    return Array.from({ length: count }, (_, k) => node.firstChild + k);
  }

  /** Spacing of node level `level` (metres). */
  spacing(level: number): number {
    return this.manifest.octree.rootSpacing / 2 ** level;
  }

  /** Positions and record indices of node `i`; null when the block is unreadable or fails its CRC. */
  readNode(i: number): NodePoints | null {
    const cached = this.cache.get(String(i));
    if (cached !== undefined) return cached;
    const node = this.nodes[i];
    if (node === undefined) return null;
    const block = Buffer.alloc(node.byteSize);
    try {
      const fd = openSync(path.join(this.dir, 'nodes.bin'), 'r');
      try {
        if (readSync(fd, block, 0, node.byteSize, node.byteOffset) !== node.byteSize) return null;
      } finally {
        closeSync(fd);
      }
    } catch {
      return null;
    }
    if (crc32(block) !== node.crc) return null;
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    const { octree, quantum, offset } = this.manifest;
    const edge = 2 ** (octree.rootBits - node.level);
    const origin = [0, 1, 2].map((a) => (octree.rootMin[a] ?? 0) + (node.key[a] ?? 0) * edge);
    const n = node.pointCount;
    const positions = new Float64Array(3 * n);
    const indices = new Uint32Array(n);
    for (let p = 0; p < n; p++) {
      for (let a = 0; a < 3; a++)
        positions[3 * p + a] = ((origin[a] ?? 0) + view.getUint32((3 * p + a) * 4, true)) * (quantum[a] ?? 0) + (offset[a] ?? 0);
      indices[p] = view.getUint32((3 * n + p) * 4, true);
    }
    const points = { positions, indices };
    this.cache.set(String(i), points);
    return points;
  }
}

/** Squared distance from `p` to a box (0 inside). */
export function boxDistance(box: CloudBounds, p: Vec3): number {
  let sum = 0;
  for (let a = 0; a < 3; a++) {
    const gap = Math.max((box.min[a] ?? 0) - (p[a] ?? 0), 0, (p[a] ?? 0) - (box.max[a] ?? 0));
    sum += gap * gap;
  }
  return Math.sqrt(sum);
}

export const boxesMeet = (a: CloudBounds, b: CloudBounds): boolean =>
  [0, 1, 2].every((k) => (a.max[k] ?? 0) >= (b.min[k] ?? 0) && (a.min[k] ?? 0) <= (b.max[k] ?? 0));
