/**
 * 2D drafting commands. Each is a pure function over the document.
 *
 * 2D geometry is LOCAL to the entity work plane (Vec2 coordinates).
 * BaseEntity.position places the work-plane origin in 3D space
 * (default plane: z=0, normal +Z).
 *
 * Spline convention: Catmull-Rom interpolating spline with centripetal
 * parameterization. `points` are through-points; the curve passes through
 * each one. For closed splines the point array is treated as periodic.
 * Tessellation is delegated to the viewport renderer.
 *
 * @layer core/commands
 */

export {
  drawLine,
  drawPolyline,
  drawArc,
  drawCircle,
  drawRectangle,
  drawPoint,
} from './draw2dBasic';
export { drawEllipse, drawSpline, drawInvolute } from './draw2dCurves';
export { drawBeltAround } from './draw2dBelt';
