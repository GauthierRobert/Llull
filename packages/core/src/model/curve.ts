/**
 * Exact curve pieces shared by 2D profiles (`Vec2`) and 3D sweep paths (`Vec3`).
 * - line: [start, end]
 * - arc: [start, through, end] — circular arc through three distinct, non-collinear points
 * - bezier: cubic [start, control1, control2, end]
 * @invariant in a chain each segment starts at the previous segment's end point
 * @see packages/core/src/geometry/curveSegments.ts
 */
export type CurveSegment<P> =
  | { readonly type: 'line'; readonly points: readonly [P, P] }
  | { readonly type: 'arc'; readonly points: readonly [P, P, P] }
  | { readonly type: 'bezier'; readonly points: readonly [P, P, P, P] };
