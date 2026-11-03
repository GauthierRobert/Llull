// Resident cloud tiles, by cloud, for the scan-point snap. A module-level registry (not a store): written by the streaming hook when its
// drawn set changes, read per frame by the gizmo drag, never rendered from.

import type { SnapTile } from './pointSnap';

const residentTiles = new Map<string, readonly SnapTile[]>();

export function setSnapTiles(cloudId: string, tiles: readonly SnapTile[]): void {
  residentTiles.set(cloudId, tiles);
}

export function clearSnapTiles(cloudId: string): void {
  residentTiles.delete(cloudId);
}

/** Every resident tile of every cloud. */
export function allSnapTiles(): readonly SnapTile[] {
  return [...residentTiles.values()].flat();
}
