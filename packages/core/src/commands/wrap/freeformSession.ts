/**
 * The chart of a freeform (B-spline) face for the face commands (03 WRP, TECHNICAL_SPEC §14.10): the exact B-spline of the face from the kernel, checked to be in the
 * face's own (u, v), and the geodesic or parametric chart built on it.
 * @failure no kernel B-spline for the face, a B-spline in other parameters than the face's, a periodic or degenerate surface, method develop -> `{ code, message, path }`
 */

import type { ChartPlacement, FaceChart } from '../../geometry/chartFrame';
import { buildFreeformChart } from '../../geometry/freeformChart';
import type { ShapeHandle } from '../../geometry/kernel';
import type { FaceProjection, FaceQueryPort } from '../../geometry/kernelPorts';

/** What the chart needs of the picked face (a `FaceSession` has it). */
interface FreeformFace {
  readonly face: number;
  readonly query: FaceQueryPort;
  readonly shape: ShapeHandle;
  readonly diagonal: number;
}

export interface FreeformFailure {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export function freeformChartOf(
  session: FreeformFace,
  method: 'develop' | 'geodesic' | 'parametric',
  hit: FaceProjection,
  placement: ChartPlacement,
): { readonly chart: FaceChart } | FreeformFailure {
  const fail = (code: string, message: string, path = 'face'): FreeformFailure => ({ code, message, path });
  if (method === 'develop')
    return fail(
      'WRP_FACE_NOT_DEVELOPABLE',
      `face ${session.face} is a freeform surface: it cannot be developed without stretch; use method geodesic or parametric and read data.distortion`,
      'placement.method',
    );
  const data = session.query.bspline(session.shape, session.face);
  if (data === null)
    return fail(
      'WRP_METHOD_UNAVAILABLE',
      `face ${session.face} is a freeform surface and the kernel gives no B-spline for it, so no chart can be built`,
    );
  const built = buildFreeformChart(data, hit.uv, placement, method);
  if ('error' in built) return fail('WRP_METHOD_UNAVAILABLE', `face ${session.face}: ${built.error}`);
  const at = built.pointAt(hit.uv);
  const deviation = Math.hypot(at[0] - hit.point[0], at[1] - hit.point[1], at[2] - hit.point[2]);
  if (!(deviation <= 1e-6 * session.diagonal))
    return fail(
      'WRP_METHOD_UNAVAILABLE',
      `face ${session.face}: the kernel's B-spline of this freeform face is not in the face's own (u, v) (it misses the anchor by ${deviation.toPrecision(3)}), so no chart can be built`,
    );
  return { chart: built };
}
