/** The description of `create_curve_on_face` (kept apart: the command file stays short). */

export const curveOnFaceDescription =
  'Create a curve lying on a face of a solid (a nurbs_curve with `onFace`) without a sketch. mode geodesic: the shortest-path curve between two points `from` and `to` of the face; ' +
  'on a plane, cylinder or cone it is the straight line of the face development (a cylinder gives a helix, length sqrt((r dtheta)^2 + dz^2)), on a sphere a great-circle arc (up to a ' +
  'quarter great circle), on a torus a geodesic found by shooting (nearest the straight (u, v) line, not necessarily the shortest). mode isoparametric: u or v constant through ' +
  '`through`, `direction` names the varying parameter, trimmed to the face. mode uv: a cubic through the (u, v) points `uv` in the kernel parameters of the face (any face kind). ' +
  'Result data.curve: id, length3d and chartLength (document units), fitTolerance (measured deviation of the fitted 3D curve), exact. Freeform faces support isoparametric and uv ' +
  'only (geodesic refuses with WRP_METHOD_UNAVAILABLE). Refusals: WRP_ANCHOR_OFF_FACE (a point farther than 1e-3 x the solid diagonal from the face), WRP_GEODESIC_FAILED ' +
  '(coincident or too distant points, a path through the cone apex, no shooting solution), WRP_OUTSIDE_FACE (the curve leaves the trimmed face), WRP_PARAM_INVALID (missing mode ' +
  'parameters). Needs the exact (native) kernel. Next: split_face_by_curves, check_wrap, render_view.';
