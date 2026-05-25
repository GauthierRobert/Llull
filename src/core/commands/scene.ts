/**
 * Scene inspection — a read-only structured snapshot of the document.
 *
 * @layer core/commands
 *
 * `computeSceneSnapshot` is a pure function an agent (or the UI) uses to ORIENT
 * before editing: how many entities, of what kind, where, on which layers. It is
 * surfaced as the read-only `describe_scene` command (no mutation, result in
 * `data`) and is also embedded in the `build_project` report so an agent sees the
 * final scene in the same round-trip.
 *
 * Bounds are world-space axis-aligned boxes computed from each primitive's
 * extents at its `position`. Entity `rotation` is NOT applied — bounds are an
 * orientation aid, not an exact oriented bounding box.
 */

import type { CadDocument, Entity, EntityKind, Vec3 } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';

// ---------------------------------------------------------------------------
// Snapshot types
// ---------------------------------------------------------------------------

/** World-space axis-aligned bounding box. */
export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export interface EntitySummary {
  id: string;
  kind: EntityKind;
  layerId: string;
  position: Vec3;
  /** World-space axis-aligned bounds (rotation not applied). */
  bounds: Bounds;
}

export interface LayerSummary {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  /** Number of entities currently assigned to this layer. */
  entityCount: number;
}

export interface GroupSummary {
  id: string;
  name: string;
  memberIds: string[];
}

/** Structured, AI-readable snapshot of the whole document. */
export interface SceneSnapshot {
  entityCount: number;
  entities: EntitySummary[];
  layers: LayerSummary[];
  groups: GroupSummary[];
  /** Combined bounds of all entities, or null when the document is empty. */
  bounds: Bounds | null;
  selection: string[];
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

function offset(p: Vec3, dx: number, dy: number, dz: number): Vec3 {
  return [p[0] + dx, p[1] + dy, p[2] + dz];
}

/** World-space AABB of one entity, matching how the viewport places each kind. */
export function entityBounds(e: Entity): Bounds {
  switch (e.kind) {
    case 'box': {
      const [w, h, d] = e.size;
      return { min: offset(e.position, -w / 2, -h / 2, -d / 2), max: offset(e.position, w / 2, h / 2, d / 2) };
    }
    case 'cylinder':
      // three.js CylinderGeometry: axis is Y, centered at origin.
      return {
        min: offset(e.position, -e.radius, -e.height / 2, -e.radius),
        max: offset(e.position, e.radius, e.height / 2, e.radius),
      };
    case 'sphere':
      return { min: offset(e.position, -e.radius, -e.radius, -e.radius), max: offset(e.position, e.radius, e.radius, e.radius) };
    case 'extrusion': {
      const xs = e.profile.map((pt) => pt[0]);
      const ys = e.profile.map((pt) => pt[1]);
      const minX = xs.length ? Math.min(...xs) : 0;
      const maxX = xs.length ? Math.max(...xs) : 0;
      const minY = ys.length ? Math.min(...ys) : 0;
      const maxY = ys.length ? Math.max(...ys) : 0;
      // ExtrudeGeometry extrudes along +Z from the profile plane.
      return { min: offset(e.position, minX, minY, 0), max: offset(e.position, maxX, maxY, e.depth) };
    }
    case 'mesh': {
      const p = e.mesh.positions;
      if (p.length < 3) return { min: e.position, max: e.position };
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = 0; i + 2 < p.length; i += 3) {
        const x = p[i] as number, y = p[i + 1] as number, z = p[i + 2] as number;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }
      return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
    }
    case 'cone':
      // Base circle centered at position in XY; apex at position+height in Z.
      return {
        min: offset(e.position, -e.radius, -e.radius, 0),
        max: offset(e.position, e.radius, e.radius, e.height),
      };
    case 'torus':
      // Torus ring in XY plane: outer extent is ringRadius+tubeRadius; tube extends ±tubeRadius in Z.
      return {
        min: offset(e.position, -(e.ringRadius + e.tubeRadius), -(e.ringRadius + e.tubeRadius), -e.tubeRadius),
        max: offset(e.position, e.ringRadius + e.tubeRadius, e.ringRadius + e.tubeRadius, e.tubeRadius),
      };
    case 'wedge': {
      // Wedge lower-front-left corner is at position; bounding box is the full size.
      const [ww, wh, wd] = e.size;
      return { min: e.position, max: offset(e.position, ww, wh, wd) };
    }
    case 'pyramid': {
      // Base centered at position; apex at position+height in Z.
      const hw = e.baseWidth / 2;
      const hd = e.baseDepth / 2;
      return {
        min: offset(e.position, -hw, -hd, 0),
        max: offset(e.position, hw, hd, e.height),
      };
    }
    case 'line': {
      const minX = Math.min(e.start[0], e.end[0]);
      const maxX = Math.max(e.start[0], e.end[0]);
      const minY = Math.min(e.start[1], e.end[1]);
      const maxY = Math.max(e.start[1], e.end[1]);
      return { min: offset(e.position, minX, minY, 0), max: offset(e.position, maxX, maxY, 0) };
    }
    case 'polyline': {
      if (e.points.length === 0) return { min: e.position, max: e.position };
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of e.points) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      return { min: offset(e.position, minX, minY, 0), max: offset(e.position, maxX, maxY, 0) };
    }
    case 'arc':
    case 'circle':
      // Conservative: full center±radius box (arcs are not angle-trimmed here).
      return {
        min: offset(e.position, e.center[0] - e.radius, e.center[1] - e.radius, 0),
        max: offset(e.position, e.center[0] + e.radius, e.center[1] + e.radius, 0),
      };
    case 'rectangle':
      // Origin at lower-left; extends +X (width), +Y (height).
      return { min: e.position, max: offset(e.position, e.width, e.height, 0) };
    case 'point':
      return { min: e.position, max: e.position };
    case 'ellipse':
      return {
        min: offset(e.position, e.center[0] - e.radiusX, e.center[1] - e.radiusY, 0),
        max: offset(e.position, e.center[0] + e.radiusX, e.center[1] + e.radiusY, 0),
      };
    case 'spline': {
      if (e.points.length === 0) return { min: e.position, max: e.position };
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of e.points) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      return { min: offset(e.position, minX, minY, 0), max: offset(e.position, maxX, maxY, 0) };
    }
    default: {
      const exhaustive: never = e;
      return { min: (exhaustive as Entity).position, max: (exhaustive as Entity).position };
    }
  }
}

function mergeBounds(a: Bounds, b: Bounds): Bounds {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * Build a structured, read-only snapshot of the document.
 *
 * @pure — reads the document, never mutates it.
 * @layer core/commands
 */
export function computeSceneSnapshot(doc: CadDocument): SceneSnapshot {
  const entities: EntitySummary[] = [];
  let sceneBounds: Bounds | null = null;
  const layerCounts: Record<string, number> = {};

  for (const id of doc.order) {
    const e = doc.entities[id];
    if (!e) continue;
    const bounds = entityBounds(e);
    entities.push({ id: e.id, kind: e.kind, layerId: e.layerId, position: e.position, bounds });
    sceneBounds = sceneBounds ? mergeBounds(sceneBounds, bounds) : bounds;
    layerCounts[e.layerId] = (layerCounts[e.layerId] ?? 0) + 1;
  }

  const layers: LayerSummary[] = doc.layerOrder
    .map((lid) => doc.layers[lid])
    .filter((l): l is NonNullable<typeof l> => l !== undefined)
    .map((l) => ({ id: l.id, name: l.name, visible: l.visible, locked: l.locked, entityCount: layerCounts[l.id] ?? 0 }));

  const groups: GroupSummary[] = Object.values(doc.groups ?? {}).map((g) => ({
    id: g.id,
    name: g.name,
    memberIds: [...g.memberIds],
  }));

  return {
    entityCount: entities.length,
    entities,
    layers,
    groups,
    bounds: sceneBounds,
    selection: [...doc.selection],
  };
}

// ---------------------------------------------------------------------------
// describe_scene command (read-only)
// ---------------------------------------------------------------------------

/**
 * @command describe_scene
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data is a SceneSnapshot; document === input doc
 */
export const describeScene: CommandDefinition<Record<string, never>> = {
  name: 'describe_scene',
  description:
    'Return a structured, read-only snapshot of the document (entity ids, kinds, world bounds, ' +
    'layers, groups, selection) so an agent can orient before editing. Does not modify the document. ' +
    'The snapshot is returned in the result `data` field.',
  paramsSchema: { type: 'object', properties: {}, required: [] },
  run: (doc): CommandResult => {
    const snapshot = computeSceneSnapshot(doc);
    return {
      document: doc,
      summary: `Scene: ${snapshot.entityCount} entit${snapshot.entityCount === 1 ? 'y' : 'ies'}, ${snapshot.layers.length} layer(s), ${snapshot.groups.length} group(s).`,
      affected: [],
      data: snapshot,
    };
  },
};
