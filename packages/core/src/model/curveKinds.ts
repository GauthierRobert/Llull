/** 3D curve entity kinds: not solids (no volume, no kernel leaf) and not planar sketches. Geometry is LOCAL to `position` / `rotation`. */

export const CURVE_KINDS = ['nurbs_curve'] as const;

export type CurveKind = (typeof CURVE_KINDS)[number];

const CURVE_KIND_SET: ReadonlySet<string> = new Set(CURVE_KINDS);

/** True for a 3D curve entity: it has no volume and no area, so solid-only commands refuse it. */
export function isCurve3D<E extends { readonly kind: string }>(entity: E): entity is Extract<E, { readonly kind: CurveKind }> {
  return CURVE_KIND_SET.has(entity.kind);
}
