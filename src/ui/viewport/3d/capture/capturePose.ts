// Temporary camera of a `capture_viewport` frame (ASC M6a): framing of the visible bounds, never the user's camera. Document coordinates, Z-up.

import type { CadDocument, Vec3 } from '@core/model/types';
import { cameraForView } from '@core/commands/render/camera';
import { fitFraming } from '@core/geometry/viewFraming';
import type { ViewportCaptureRequest } from '@core/model/viewportCapture';
import { mergedEntityBounds } from '../fitBounds';

export interface CapturePose {
  readonly position: Vec3;
  readonly target: Vec3;
  readonly up: Vec3;
  /** Eye distance to the target (clipping planes follow it). */
  readonly distance: number;
}

const FRAME_MARGIN = 1.15;
const EMPTY_SCENE_RADIUS = 1;

/** Ids of the entities a frame shows: on a visible layer and not on a layer the request hides. */
function shownIds(doc: CadDocument, hideLayers: ReadonlySet<string>): string[] {
  return doc.order.filter((id) => {
    const layerId = doc.entities[id]?.layerId;
    return layerId !== undefined && doc.layers[layerId]?.visible !== false && !hideLayers.has(layerId);
  });
}

/** Pose that frames the shown entities (`zoom` 1 = they fit) from the requested direction; an empty scene is framed around the origin. */
export function capturePose(request: ViewportCaptureRequest, doc: CadDocument): CapturePose {
  const bounds = mergedEntityBounds(doc, shownIds(doc, new Set(request.hideLayers)));
  const aspect = request.width / request.height;
  const framing = bounds
    ? fitFraming(bounds, aspect, FRAME_MARGIN, { degenerateBelow: 0, degenerateRadius: EMPTY_SCENE_RADIUS })
    : { center: [0, 0, 0] as Vec3, distance: EMPTY_SCENE_RADIUS * 4 };
  const target: Vec3 = request.target !== undefined ? [request.target[0], request.target[1], request.target[2]] : framing.center;
  const distance = framing.distance / request.zoom;
  const placed = cameraForView(request.direction !== undefined ? 'custom' : request.view, [0, 0, 0], 1, request.direction);
  const length = Math.hypot(...placed.position);
  const direction = placed.position.map((component) => component / length);
  return {
    position: [target[0] + direction[0]! * distance, target[1] + direction[1]! * distance, target[2] + direction[2]! * distance],
    target,
    up: placed.up,
    distance,
  };
}
