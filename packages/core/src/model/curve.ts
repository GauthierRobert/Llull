/**
 * Exact curve pieces shared by 2D profiles (`Vec2`) and 3D sweep paths (`Vec3`).
 * - line: [start, end]
 * - arc: [start, through, end] — circular arc through three distinct, non-collinear points
 * - bezier: cubic [start, control1, control2, end]
 * - ellipse: exact QUARTER of an ellipse [start, center, end]; u = start - center and v = end - center are conjugate semi-diameters (u, v not
 *   collinear; perpendicular and unequal for a 2:1 head knuckle), P(t) = center + cos(πt/2)·u + sin(πt/2)·v. Affine-invariant: scaling, rotating,
 *   reversing ([end, center, start]) or placing in 3D keeps it exact. Any elliptic arc is a chain of such quarters.
 * @invariant in a chain each segment starts at the previous segment's end point
 * @see packages/core/src/geometry/curveSegments.ts
 */
export type CurveSegment<P> =
  | { readonly type: 'line'; readonly points: readonly [P, P] }
  | { readonly type: 'arc'; readonly points: readonly [P, P, P] }
  | { readonly type: 'bezier'; readonly points: readonly [P, P, P, P] }
  | { readonly type: 'ellipse'; readonly points: readonly [P, P, P] };
