/**
 * Camera control commands — write `document.camera` so an MCP agent or the UI
 * can frame the model deterministically without touching entity geometry.
 *
 * @layer core/commands
 *
 * All three commands are pure (return a new doc) and annotated `metaHistory:true`
 * so `execute()` does NOT append a FeatureStep — camera orientation is view state,
 * not a replayable geometry step.
 *
 * Convention (matches +Z-up sphericalToCartesian in Viewport3D.tsx):
 *   polar   = 0      → camera directly above along +Z
 *   polar   = π/2   → camera in the XY plane
 *   azimuth          → angle in XY plane measured from +Y toward +X
 *
 * Direction preset azimuths/polars (+Z-up right-handed):
 *   front   → azimuth=0,     polar=π/2   (looking along -Y)
 *   back    → azimuth=π,     polar=π/2   (looking along +Y)
 *   right   → azimuth=π/2,   polar=π/2   (looking along -X)
 *   left    → azimuth=-π/2,  polar=π/2   (looking along +X)
 *   top     → azimuth=0,     polar=0.01  (overhead; avoid gimbal lock at polar=0)
 *   bottom  → azimuth=0,     polar=π-0.01 (below; avoid gimbal lock at polar=π)
 *   iso     → azimuth=π/4,   polar=π/4   (classic isometric)
 *   current → preserve existing azimuth/polar; only adjust distance/target
 */

import type { CameraState, Vec3 } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { computeSceneSnapshot } from './scene';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default half-FOV in radians used by the viewport PerspectiveCamera (fov=60°). */
const DEFAULT_FOV_DEG = 60;
const HALF_FOV_RAD = (DEFAULT_FOV_DEG / 2) * (Math.PI / 180);

/**
 * Direction presets → { azimuth, polar } in radians.
 * Follows +Z-up spherical convention matching Viewport3D.tsx.
 */
const DIRECTION_PRESETS: Record<string, { azimuth: number; polar: number }> = {
  front:   { azimuth: 0,               polar: Math.PI / 2 },
  back:    { azimuth: Math.PI,         polar: Math.PI / 2 },
  right:   { azimuth: Math.PI / 2,     polar: Math.PI / 2 },
  left:    { azimuth: -Math.PI / 2,    polar: Math.PI / 2 },
  top:     { azimuth: 0,               polar: 0.01 },
  bottom:  { azimuth: 0,               polar: Math.PI - 0.01 },
  iso:     { azimuth: Math.PI / 4,     polar: Math.PI / 4 },
};

// ---------------------------------------------------------------------------
// set_camera
// ---------------------------------------------------------------------------

interface SetCameraParams {
  target?: [number, number, number];
  azimuth?: number;
  polar?: number;
  distance?: number;
}

/**
 * @command set_camera
 * @pure
 * @layer core/commands
 * @affects nothing — writes only document.camera; affected:[]
 * @invariant distance, if provided, must be > 0
 * @failure distance <= 0 → no-op with explanatory summary
 */
export const setCamera: CommandDefinition<SetCameraParams> = {
  name: 'set_camera',
  description:
    'Set one or more camera fields (target, azimuth, polar, distance). ' +
    'Unspecified fields are preserved. ' +
    'target is [x,y,z] world-space orbit centre. ' +
    'azimuth is horizontal angle in radians (XY plane, measured from +Y toward +X). ' +
    'polar is vertical angle in radians (0 = overhead along +Z, π/2 = eye-level). ' +
    'distance is the radius of the orbit sphere; must be > 0. ' +
    'Does NOT add to feature history.',
  annotations: { metaHistory: true, idempotent: true },
  paramsSchema: {
    type: 'object',
    properties: {
      target: {
        type: 'array',
        description: 'World-space orbit target [x, y, z]. Omit to keep current target.',
        items: { type: 'number' },
      },
      azimuth: {
        type: 'number',
        description:
          'Horizontal orbit angle in radians measured in the XY plane from +Y toward +X. ' +
          '0 = front view (+Y direction), π/2 = right view (+X direction). Omit to keep current value.',
      },
      polar: {
        type: 'number',
        description:
          'Vertical orbit angle in radians. 0 = overhead (along +Z), π/2 = eye-level. ' +
          'Clamped to (0.01, π−0.01) to avoid gimbal lock. Omit to keep current value.',
      },
      distance: {
        type: 'number',
        description: 'Orbit radius — distance from target to camera eye. Must be > 0. Omit to keep current value.',
      },
    },
    required: [],
  },
  run: (doc, params): CommandResult => {
    const p = (params ?? {}) as SetCameraParams;

    if (p.distance !== undefined && p.distance <= 0) {
      return {
        document: doc,
        summary: `set_camera: distance must be > 0 (got ${p.distance}). Camera unchanged.`,
        affected: [],
      };
    }

    const prev: CameraState = doc.camera;
    const next: CameraState = {
      target: p.target !== undefined ? (p.target as Vec3) : prev.target,
      azimuth: p.azimuth !== undefined ? p.azimuth : prev.azimuth,
      polar:   p.polar   !== undefined ? p.polar   : prev.polar,
      distance: p.distance !== undefined ? p.distance : prev.distance,
    };

    const changed = ([] as string[]).concat(
      p.target   !== undefined ? ['target']   : [],
      p.azimuth  !== undefined ? ['azimuth']  : [],
      p.polar    !== undefined ? ['polar']    : [],
      p.distance !== undefined ? ['distance'] : [],
    );

    if (changed.length === 0) {
      return {
        document: doc,
        summary: 'set_camera: no fields specified; camera unchanged.',
        affected: [],
      };
    }

    return {
      document: { ...doc, camera: next },
      summary: `set_camera: updated ${changed.join(', ')}. target=${JSON.stringify(next.target)}, azimuth=${next.azimuth.toFixed(3)}, polar=${next.polar.toFixed(3)}, distance=${next.distance.toFixed(3)}.`,
      affected: [],
    };
  },
};

// ---------------------------------------------------------------------------
// look_at
// ---------------------------------------------------------------------------

interface LookAtParams {
  target: [number, number, number];
  azimuth?: number;
  polar?: number;
}

/**
 * @command look_at
 * @pure
 * @layer core/commands
 * @affects nothing — writes only document.camera; affected:[]
 * @invariant distance is preserved; only target (and optionally azimuth/polar) change
 * @failure no params or bad target → no-op
 */
export const lookAt: CommandDefinition<LookAtParams> = {
  name: 'look_at',
  description:
    'Orbit the camera to look at a specific world-space point without changing the orbit distance. ' +
    'Provide target [x, y, z] to set the orbit centre. ' +
    'Optionally override azimuth and/or polar to also change camera direction. ' +
    'distance is preserved. Use set_camera to change distance explicitly. ' +
    'Does NOT add to feature history.',
  annotations: { metaHistory: true, idempotent: true },
  paramsSchema: {
    type: 'object',
    properties: {
      target: {
        type: 'array',
        description: 'World-space point [x, y, z] to set as the orbit centre.',
        items: { type: 'number' },
      },
      azimuth: {
        type: 'number',
        description:
          'Optional horizontal orbit angle in radians (measured from +Y toward +X in the XY plane). ' +
          'Omit to keep the current azimuth.',
      },
      polar: {
        type: 'number',
        description:
          'Optional vertical orbit angle in radians (0 = overhead, π/2 = eye-level). ' +
          'Omit to keep the current polar angle.',
      },
    },
    required: ['target'],
  },
  run: (doc, params): CommandResult => {
    const p = (params ?? {}) as LookAtParams;

    if (
      !Array.isArray(p.target) ||
      p.target.length !== 3 ||
      p.target.some((v) => typeof v !== 'number' || !isFinite(v))
    ) {
      return {
        document: doc,
        summary: `look_at: target must be a finite [x,y,z] array. Camera unchanged.`,
        affected: [],
      };
    }

    const prev: CameraState = doc.camera;
    const next: CameraState = {
      target:   p.target as Vec3,
      azimuth:  p.azimuth !== undefined ? p.azimuth : prev.azimuth,
      polar:    p.polar   !== undefined ? p.polar   : prev.polar,
      distance: prev.distance,
    };

    return {
      document: { ...doc, camera: next },
      summary: `look_at: target set to ${JSON.stringify(next.target)}, azimuth=${next.azimuth.toFixed(3)}, polar=${next.polar.toFixed(3)}, distance preserved at ${next.distance.toFixed(3)}.`,
      affected: [],
    };
  },
};

// ---------------------------------------------------------------------------
// fit_view
// ---------------------------------------------------------------------------

type FitDirection = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso' | 'current';

interface FitViewParams {
  direction?: FitDirection;
  padding?: number;
}

/**
 * @command fit_view
 * @pure
 * @layer core/commands
 * @affects nothing — writes only document.camera; affected:[]
 * @invariant target = scene-bounds centre; distance = boundsRadius / sin(fov/2) * padding
 * @failure empty doc → falls back to sensible default framing; unknown direction → no-op
 */
export const fitView: CommandDefinition<FitViewParams> = {
  name: 'fit_view',
  description:
    'Frame the entire document in the camera so all entities are visible. ' +
    'direction presets the viewing angle: ' +
    '"front" (looking along -Y), "back" (+Y), "right" (-X), "left" (+X), ' +
    '"top" (overhead +Z), "bottom" (below -Z), "iso" (isometric, default), ' +
    '"current" (keep existing azimuth/polar, only adjust distance and target). ' +
    'padding multiplies the computed distance so geometry has breathing room (default 1.2). ' +
    'When the document is empty a default view is applied with an explanatory summary. ' +
    'Does NOT add to feature history.',
  annotations: { metaHistory: true, idempotent: true },
  paramsSchema: {
    type: 'object',
    properties: {
      direction: {
        type: 'string',
        description:
          'Viewing direction preset. One of: front, back, left, right, top, bottom, iso, current. ' +
          'Defaults to "iso". "current" keeps the existing azimuth and polar; only target and distance change.',
        enum: ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso', 'current'],
      },
      padding: {
        type: 'number',
        description:
          'Scale factor applied to the computed distance so geometry is not edge-clipped. ' +
          'Default 1.2. Values < 1 crop the view; > 2 shows it very small. Must be > 0.',
      },
    },
    required: [],
  },
  run: (doc, params): CommandResult => {
    const p = (params ?? {}) as FitViewParams;
    const direction: FitDirection = p.direction ?? 'iso';
    const padding: number = p.padding ?? 1.2;

    if (!['front', 'back', 'left', 'right', 'top', 'bottom', 'iso', 'current'].includes(direction)) {
      return {
        document: doc,
        summary: `fit_view: unknown direction "${direction}". Valid values: front, back, left, right, top, bottom, iso, current. Camera unchanged.`,
        affected: [],
      };
    }

    if (padding <= 0) {
      return {
        document: doc,
        summary: `fit_view: padding must be > 0 (got ${padding}). Camera unchanged.`,
        affected: [],
      };
    }

    // Compute scene bounds using the shared scene snapshot helper.
    const snapshot = computeSceneSnapshot(doc);
    const bounds = snapshot.bounds;

    let target: Vec3;
    let distance: number;

    if (!bounds) {
      // Empty document — use a sensible default view.
      target = [0, 0, 0];
      distance = 10;
      const preset = direction === 'current' ? null : DIRECTION_PRESETS[direction];
      const azimuth = preset ? preset.azimuth : doc.camera.azimuth;
      const polar   = preset ? preset.polar   : doc.camera.polar;
      const next: CameraState = { target, azimuth, polar, distance };
      return {
        document: { ...doc, camera: next },
        summary: `fit_view (${direction}): document is empty — applied default framing: target=[0,0,0], distance=${distance}. azimuth=${azimuth.toFixed(3)}, polar=${polar.toFixed(3)}.`,
        affected: [],
      };
    }

    // Scene has geometry — compute the bounding sphere centre and radius.
    const cx = (bounds.min[0] + bounds.max[0]) / 2;
    const cy = (bounds.min[1] + bounds.max[1]) / 2;
    const cz = (bounds.min[2] + bounds.max[2]) / 2;
    target = [cx, cy, cz];

    const dx = (bounds.max[0] - bounds.min[0]) / 2;
    const dy = (bounds.max[1] - bounds.min[1]) / 2;
    const dz = (bounds.max[2] - bounds.min[2]) / 2;
    const boundsRadius = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // Avoid degenerate distance for a single-point scene (e.g. lone PointEntity).
    const safeRadius = boundsRadius < 0.001 ? 1 : boundsRadius;
    distance = (safeRadius / Math.sin(HALF_FOV_RAD)) * padding;

    const preset = direction === 'current' ? null : DIRECTION_PRESETS[direction];
    const azimuth = preset ? preset.azimuth : doc.camera.azimuth;
    const polar   = preset ? preset.polar   : doc.camera.polar;

    const next: CameraState = { target, azimuth, polar, distance };
    return {
      document: { ...doc, camera: next },
      summary: `fit_view (${direction}): target=${JSON.stringify(target.map((v) => +v.toFixed(3)))}, distance=${distance.toFixed(3)}, azimuth=${azimuth.toFixed(3)}, polar=${polar.toFixed(3)}, padding=${padding}.`,
      affected: [],
    };
  },
};
