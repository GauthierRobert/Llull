import type { NurbsCurve2Data } from '../../lib/nurbs/curve2d';
import type { NurbsCurveData } from '../../lib/nurbs/types';

export interface SilhouetteCurve {
  readonly face: number;
  readonly kind: 'line' | 'circle' | 'fitted';
  readonly curve: NurbsCurveData;
  /** Pcurve in the kernel's own (u, v) of the face: a polyline through the projected samples. */
  readonly pcurve: NurbsCurve2Data;
  readonly length: number;
  /** Largest distance of the 3D curve (and of the pcurve edge) from the exact contour, document units (0 for a line or a circle). */
  readonly deviation: number;
}
