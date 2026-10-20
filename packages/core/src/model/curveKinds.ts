/** 3D curve entity kinds: not solids (no volume, no kernel leaf) and not planar sketches. Geometry is LOCAL to `position` / `rotation`. */

export const CURVE_KINDS = ['nurbs_curve'] as const;

export type CurveKind = (typeof CURVE_KINDS)[number];

const CURVE_KIND_SET: ReadonlySet<string> = new Set(CURVE_KINDS);

/** True for a 3D curve entity: it has no volume and no area, so solid-only commands refuse it. */
export function isCurve3D<E extends { readonly kind: string }>(entity: E): entity is Extract<E, { readonly kind: CurveKind }> {
  return CURVE_KIND_SET.has(entity.kind);
}

/** Open surface sheets: faces without a volume (`isSheet`); a closed shell would be a solid and is a mesh / B-rep kind instead. */
export const SHEET_KINDS = ['nurbs_surface'] as const;

export type SheetKind = (typeof SHEET_KINDS)[number];

const SHEET_KIND_SET: ReadonlySet<string> = new Set(SHEET_KINDS);

/** True for a surface sheet entity: it has area but no volume, so solid-only commands (booleans, mass, STEP solids) refuse it. */
export function isSheet<E extends { readonly kind: string }>(entity: E): entity is Extract<E, { readonly kind: SheetKind }> {
  return SHEET_KIND_SET.has(entity.kind);
}
