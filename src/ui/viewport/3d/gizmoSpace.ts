// Frame of the transform gizmo. It is mounted INSIDE the floating-origin group (`position = -renderOrigin`, Viewport3D), so its target and
// the snap indicator are expressed in document coordinates: the group supplies the offset when drawing. Using render-space positions here
// would subtract the origin twice (the handle drawn at position - 2 * renderOrigin).

import type { Vec3 } from '@core/model/types';

/** Position of the gizmo target (and snap indicator) for a document position, in the frame of its parent group. */
export const gizmoFramePosition = (documentPosition: Readonly<Vec3>): Vec3 => [
  documentPosition[0],
  documentPosition[1],
  documentPosition[2],
];
