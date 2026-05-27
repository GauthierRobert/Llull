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
 * Agent-facing bounds (describe_scene, creation summaries) use `worldAabb` —
 * the rotation-aware world AABB. `entityBounds` remains the unrotated local AABB
 * used by measure, query, and check commands (unchanged by W4F).
 */

import type { AnimationChannel, AnimationMode, CadDocument, Entity, EntityKind, InstanceEntity, Vec3 } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { applyEulerXYZ, isZeroRotation } from '../../lib/math3';

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
  /** World-space axis-aligned bounds (rotation-aware world AABB via worldAabb). */
  bounds: Bounds;
  /**
   * Present only when the entity has a non-zero rotation.
   * Reminds the agent that bounds is the rotated world AABB, not the local AABB.
   */
  rotated?: true;
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

export interface AnimationSummary {
  id: string;
  targetId: string;
  targetKind: 'entity' | 'group';
  channel: AnimationChannel;
  mode: AnimationMode;
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
  /** All declared animation clips in the document. */
  animations: AnimationSummary[];
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
    case 'text': {
      // Estimated width using a monospace approximation: each glyph ≈ 0.6×height.
      const estimatedWidth = e.content.length * e.height * 0.6;
      return { min: e.position, max: offset(e.position, estimatedWidth, e.height, 0) };
    }
    case 'dimension': {
      // Dimensions have no own geometry — produce a small AABB around the entity position
      // using the offset (witness-line distance) as a proxy for the annotation extent.
      const ext = e.offset ?? 5;
      return { min: offset(e.position, -ext, -ext, 0), max: offset(e.position, ext, ext, 0) };
    }
    case 'instance': {
      // Instance bounds without component access: return a point at the instance position.
      // Callers with doc access should use instanceBoundsFromDoc() for accurate bounds.
      return { min: e.position, max: e.position };
    }
    default: {
      const exhaustive: never = e;
      return { min: (exhaustive as Entity).position, max: (exhaustive as Entity).position };
    }
  }
}

/**
 * Compute the world AABB of an InstanceEntity by expanding it against its component's
 * child entities. Callers that have access to the document should prefer this over
 * `entityBounds` for `instance` kind entities.
 *
 * Falls back to a point at the instance position when the component is empty or missing.
 *
 * @pure — reads only; does not mutate
 */
export function instanceBoundsFromDoc(instance: InstanceEntity, doc: CadDocument): Bounds {
  // Inline import to avoid circular dep: assemblies.ts imports from scene.ts only
  // through lib/math3, not through scene. We reproduce the bake logic here using only
  // applyEulerXYZ which lives in lib.
  const component = doc.components[instance.componentId];
  if (!component || component.order.length === 0) {
    return { min: instance.position, max: instance.position };
  }

  // Expand each child's local AABB through the instance transform.
  const scale = instance.scale ?? ([1, 1, 1] as const);
  const [sx, sy, sz] = scale;
  const rot = instance.rotation;
  const pos = instance.position;
  const hasRotation = !isZeroRotation(rot);

  let combined: Bounds | null = null;

  for (const cid of component.order) {
    const child = component.entities[cid];
    if (!child) continue;

    const localBounds = entityBounds(child);

    // 8 corners of the child local AABB
    const lMin = localBounds.min;
    const lMax = localBounds.max;
    const corners: Vec3[] = [
      [lMin[0], lMin[1], lMin[2]],
      [lMax[0], lMin[1], lMin[2]],
      [lMin[0], lMax[1], lMin[2]],
      [lMax[0], lMax[1], lMin[2]],
      [lMin[0], lMin[1], lMax[2]],
      [lMax[0], lMin[1], lMax[2]],
      [lMin[0], lMax[1], lMax[2]],
      [lMax[0], lMax[1], lMax[2]],
    ];

    for (const c of corners) {
      // Scale
      const scaled: Vec3 = [c[0] * sx, c[1] * sy, c[2] * sz];
      // Rotate around component origin
      const rotated: Vec3 = hasRotation ? applyEulerXYZ(scaled, [0, 0, 0], rot) : scaled;
      // Translate
      const world: Vec3 = [rotated[0] + pos[0], rotated[1] + pos[1], rotated[2] + pos[2]];

      if (!combined) {
        combined = { min: [...world] as unknown as Vec3, max: [...world] as unknown as Vec3 };
      } else {
        combined = {
          min: [Math.min(combined.min[0], world[0]), Math.min(combined.min[1], world[1]), Math.min(combined.min[2], world[2])],
          max: [Math.max(combined.max[0], world[0]), Math.max(combined.max[1], world[1]), Math.max(combined.max[2], world[2])],
        };
      }
    }
  }

  return combined ?? { min: instance.position, max: instance.position };
}

/**
 * Rotation-aware world AABB for one entity.
 *
 * Fast path: when rotation is absent or [0,0,0] returns entityBounds(e) unchanged
 * (byte-identical result — non-rotated entities are unaffected).
 *
 * Rotated path: generates the 8 corners of the local AABB, maps each through
 * applyEulerXYZ (same XYZ Euler convention as the viewport), then takes
 * component-wise min/max for the true world AABB.
 *
 * @pure
 * @affects nothing — read-only
 */
export function worldAabb(e: Entity): Bounds {
  const rot = e.rotation;
  if (!rot || isZeroRotation(rot)) return entityBounds(e);

  const local = entityBounds(e);
  const { min, max } = local;
  const pos = e.position;

  // 8 corners of the local AABB
  const corners: Vec3[] = [
    [min[0], min[1], min[2]],
    [max[0], min[1], min[2]],
    [min[0], max[1], min[2]],
    [max[0], max[1], min[2]],
    [min[0], min[1], max[2]],
    [max[0], min[1], max[2]],
    [min[0], max[1], max[2]],
    [max[0], max[1], max[2]],
  ];

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const c of corners) {
    const r = applyEulerXYZ(c, pos, rot);
    if (r[0] < minX) minX = r[0];
    if (r[1] < minY) minY = r[1];
    if (r[2] < minZ) minZ = r[2];
    if (r[0] > maxX) maxX = r[0];
    if (r[1] > maxY) maxY = r[1];
    if (r[2] > maxZ) maxZ = r[2];
  }

  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
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
    // Instances have no own geometry — their world AABB comes from expanding the
    // referenced component (entityBounds/worldAabb alone return a point for instances).
    const bounds = e.kind === 'instance' ? instanceBoundsFromDoc(e, doc) : worldAabb(e);
    const isRotated = !!e.rotation && !isZeroRotation(e.rotation);
    entities.push({
      id: e.id,
      kind: e.kind,
      layerId: e.layerId,
      position: e.position,
      bounds,
      ...(isRotated ? { rotated: true as const } : {}),
    });
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

  const animations: AnimationSummary[] = Object.values(doc.animations ?? {}).map((a) => ({
    id: a.id,
    targetId: a.targetId,
    targetKind: a.targetKind,
    channel: a.channel,
    mode: a.mode,
  }));

  return {
    entityCount: entities.length,
    entities,
    layers,
    groups,
    bounds: sceneBounds,
    selection: [...doc.selection],
    animations,
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
  annotations: { readOnly: true },
  description:
    'Return a structured, read-only snapshot of the document (entity ids, kinds, world bounds, ' +
    'layers, groups, selection) so an agent can orient before editing. Does not modify the document. ' +
    'The snapshot is returned in the result `data` field.',
  paramsSchema: { type: 'object', properties: {}, required: [] },
  run: (doc): CommandResult => {
    const snapshot = computeSceneSnapshot(doc);
    return {
      document: doc,
      summary: `Scene: ${snapshot.entityCount} entit${snapshot.entityCount === 1 ? 'y' : 'ies'}, ${snapshot.layers.length} layer(s), ${snapshot.groups.length} group(s), ${snapshot.animations.length} animation(s).`,
      affected: [],
      data: snapshot,
    };
  },
};
