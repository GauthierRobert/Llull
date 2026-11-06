/**
 * The camera of render_animation (FR-MOV-16, TR-MOV-06): one fixed framed camera, a saved viewpoint, a walkthrough followed in video time, or an orbit
 * (turntable) about the centre of the scene. `resolveCamera` checks the request against the document before any work is done; `buildCameraPlan` turns it
 * into the camera of every frame once the bounds of the motion are known.
 */

import type { CadDocument } from '../../../model/types';
import type { Vec3 } from '../../../model/vectors';
import type { ViewpointCamera } from '../../../model/review';
import { boundsCenter, type Bounds } from '../../../geometry/bounds';
import { add3, cross3, dot3, len3, normalize3, scale3, sub3 } from '../../../lib/vec3';
import { reviewOf } from '../../review/reviewModel';
import type { ViewName } from '../camera';
import { walkthroughCameraAt, type CameraPath } from '../walkthroughCamera';
import { framedCamera, orbitFramedCamera } from './framing';
import { own, refusal, type AnimationWarning, type SourceRefusal } from './types';

export interface CameraRequest {
  readonly view?: Exclude<ViewName, 'custom'> | undefined;
  readonly direction?: Vec3 | undefined;
  readonly viewpointId?: string | undefined;
  readonly walkthroughId?: string | undefined;
  readonly path?: CameraPath | undefined;
  readonly orbit?: { readonly turns: number; readonly axis?: Vec3 | undefined } | undefined;
}

interface FramedBase {
  readonly view: ViewName;
  readonly direction: Vec3 | undefined;
}

export type ResolvedCamera =
  | ({ readonly mode: 'fixed' } & FramedBase)
  | { readonly mode: 'viewpoint'; readonly camera: ViewpointCamera }
  | {
      readonly mode: 'walkthrough';
      readonly cameras: readonly ViewpointCamera[];
      readonly seconds: readonly number[];
      readonly path: CameraPath;
      readonly durationS: number;
    }
  | {
      readonly mode: 'orbit';
      readonly base: FramedBase | { readonly camera: ViewpointCamera };
      readonly turns: number;
      readonly axis: Vec3;
    };

export type CameraMode = ResolvedCamera['mode'];

export interface CameraPlan {
  readonly mode: CameraMode;
  /** True when the camera differs between frames (the overlays are then projected frame by frame). */
  readonly moves: boolean;
  readonly cameraAt: (frame: number) => ViewpointCamera;
  readonly warnings: readonly AnimationWarning[];
}

const MAX_TURNS = 100;
const invalid = (message: string): SourceRefusal => refusal('MOV_CAMERA_INVALID', message);
const finiteNonZero = (v: Vec3): boolean => v.every(Number.isFinite) && len3(v) > 1e-9;

/** The request checked against the document, or the refusal (MOV_CAMERA_INVALID for illegal combinations, MOV_UNKNOWN_ID for missing ids). */
export function resolveCamera(doc: CadDocument, request: CameraRequest): ResolvedCamera | SourceRefusal {
  const { view, direction, viewpointId, walkthroughId, orbit, path } = request;
  const chosen = [view !== undefined || direction !== undefined, viewpointId !== undefined, walkthroughId !== undefined].filter(
    Boolean,
  ).length;
  if (view !== undefined && direction !== undefined) return invalid('camera gives both view and direction');
  if (chosen > 1) return invalid('camera gives more than one of view / direction, viewpointId and walkthroughId');
  if (direction !== undefined && !finiteNonZero(direction)) return invalid('camera.direction must be a finite, non-zero [x, y, z]');
  if (path !== undefined && walkthroughId === undefined) return invalid('camera.path applies to walkthroughId only');
  if (orbit !== undefined && walkthroughId !== undefined)
    return invalid('camera.orbit cannot be combined with walkthroughId (the walkthrough is the path)');
  const axis: Vec3 = orbit?.axis ?? [0, 0, 1];
  if (orbit !== undefined) {
    if (!(Number.isFinite(orbit.turns) && orbit.turns !== 0 && Math.abs(orbit.turns) <= MAX_TURNS))
      return invalid(`camera.orbit.turns must be a finite, non-zero number of turns, at most ${MAX_TURNS} in magnitude`);
    if (!finiteNonZero(axis)) return invalid('camera.orbit.axis must be a finite, non-zero [x, y, z]');
  }
  if (walkthroughId !== undefined) return resolveWalkthrough(doc, walkthroughId, path ?? 'linear');
  let base: FramedBase | { readonly camera: ViewpointCamera };
  if (viewpointId === undefined) base = { view: direction === undefined ? (view ?? 'iso') : 'custom', direction };
  else {
    const viewpoint = own(reviewOf(doc).viewpoints, viewpointId);
    if (viewpoint === undefined) return refusal('MOV_UNKNOWN_ID', `camera: no viewpoint '${viewpointId}' (list_viewpoints)`, [viewpointId]);
    base = { camera: viewpoint.camera };
  }
  if (orbit !== undefined) return { mode: 'orbit', base, turns: orbit.turns, axis: normalize3(axis) };
  return 'camera' in base ? { mode: 'viewpoint', camera: base.camera } : { mode: 'fixed', ...base };
}

function resolveWalkthrough(doc: CadDocument, id: string, path: CameraPath): ResolvedCamera | SourceRefusal {
  const walkthrough = own(reviewOf(doc).walkthroughs, id);
  if (walkthrough === undefined) return refusal('MOV_UNKNOWN_ID', `camera: no walkthrough '${id}' (create_walkthrough)`, [id]);
  const cameras: ViewpointCamera[] = [];
  for (const key of walkthrough.keys) {
    const viewpoint = own(reviewOf(doc).viewpoints, key.viewpointId);
    if (viewpoint === undefined)
      return refusal('MOV_UNKNOWN_ID', `camera: walkthrough '${id}' references the missing viewpoint '${key.viewpointId}'`, [
        key.viewpointId,
      ]);
    cameras.push(viewpoint.camera);
  }
  const seconds = walkthrough.keys.map((key) => key.seconds);
  return { mode: 'walkthrough', cameras, seconds, path, durationS: seconds.slice(0, -1).reduce((sum, s) => sum + s, 0) };
}

/** Rodrigues rotation of `v` by `angle` radians about the unit `axis` through the origin. */
function rotateAbout(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  return add3(add3(scale3(v, cos), scale3(cross3(axis, v), sin)), scale3(axis, dot3(axis, v) * (1 - cos)));
}

/** `camera` turned by `angle` about the line through `pivot` along the unit `axis`. */
function orbitCamera(camera: ViewpointCamera, pivot: Vec3, axis: Vec3, angle: number): ViewpointCamera {
  return {
    ...camera,
    eye: add3(pivot, rotateAbout(sub3(camera.eye, pivot), axis, angle)),
    direction: rotateAbout(camera.direction, axis, angle),
    up: rotateAbout(camera.up, axis, angle),
  };
}

const seconds4 = (s: number): number => +s.toFixed(4);

/**
 * The camera of every frame of a `frames`-frame run at `fps`, given the bounds of the whole motion.
 * @invariant fixed / viewpoint: one value for all frames; walkthrough: the camera of `render_walkthrough` at t = frame / fps; orbit: frame k is turned by
 *   2π · turns · k / (frames − 1) about the axis through the centre of `bounds` (frame 0 is the base camera, a single frame is not turned)
 */
export function buildCameraPlan(
  resolved: ResolvedCamera,
  bounds: Bounds,
  width: number,
  height: number,
  fps: number,
  frames: number,
): CameraPlan {
  switch (resolved.mode) {
    case 'fixed': {
      const camera = framedCamera(resolved.view, resolved.direction, bounds, width, height);
      return { mode: 'fixed', moves: false, cameraAt: () => camera, warnings: [] };
    }
    case 'viewpoint':
      return { mode: 'viewpoint', moves: false, cameraAt: () => resolved.camera, warnings: [] };
    case 'walkthrough': {
      const lastT = (frames - 1) / fps;
      const matches = Math.abs(resolved.durationS - lastT) <= 0.5 / fps;
      const warnings: AnimationWarning[] = matches
        ? []
        : [
            {
              code: 'MOV_CAMERA_PATH_DURATION',
              message:
                `the walkthrough lasts ${seconds4(resolved.durationS)} s but the video ${seconds4(lastT)} s: ` +
                (resolved.durationS < lastT
                  ? 'the camera holds on the last key at the end'
                  : 'the video ends before the camera reaches the last key'),
            },
          ];
      return {
        mode: 'walkthrough',
        moves: true,
        cameraAt: (frame) => walkthroughCameraAt(resolved.cameras, resolved.seconds, frame / fps, resolved.path),
        warnings,
      };
    }
    case 'orbit': {
      const base =
        'camera' in resolved.base
          ? resolved.base.camera
          : orbitFramedCamera(resolved.base.view, resolved.base.direction, bounds, width, height);
      const pivot = boundsCenter(bounds);
      const angleOf = (frame: number): number => (frames > 1 ? (2 * Math.PI * resolved.turns * frame) / (frames - 1) : 0);
      return { mode: 'orbit', moves: true, cameraAt: (frame) => orbitCamera(base, pivot, resolved.axis, angleOf(frame)), warnings: [] };
    }
  }
}
