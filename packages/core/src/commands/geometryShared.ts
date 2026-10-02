import type { CadDocument, Entity, Vec3 } from '../model/types';

export const ORIGIN: Vec3 = [0, 0, 0];

/**
 * Validate an optional rotation param.
 * Returns [0,0,0] if rotation is absent, not length-3, or contains non-finite values.
 * Never throws — malformed rotation is silently ignored and the entity is created unrotated.
 */
export function resolveRotation(rotation: unknown): Vec3 {
  if (!Array.isArray(rotation) || rotation.length !== 3) return [0, 0, 0];
  const [rx, ry, rz] = rotation as unknown[];
  if (!Number.isFinite(rx) || !Number.isFinite(ry) || !Number.isFinite(rz)) return [0, 0, 0];
  return [rx as number, ry as number, rz as number];
}

/**
 * Placement anchor values.
 *
 * These control how the caller's `position` input is interpreted for a 3D-creation
 * command. The anchor names the point on the entity's LOCAL, UNROTATED AABB that must
 * land at the caller's `position`. The stored `position` (persisted on the entity) is
 * then the one that achieves this in the entity's own coordinate space, i.e. the offset
 * is applied BEFORE rotation. Rotation is applied by the viewport about the stored
 * origin exactly as it is today — this is an intentional, documented interaction.
 *
 * Right-handed frame, +Z up (document convention).
 *
 * | value         | anchor point (in local AABB)                                 |
 * |---------------|--------------------------------------------------------------|
 * | 'center'      | geometric center: mid X, mid Y, mid Z                        |
 * | 'min'         | min corner: min X, min Y, min Z                               |
 * | 'base-center' | center of the bottom face: mid X, mid Y, min Z                |
 */
export type PlacementAnchor = 'center' | 'min' | 'base-center';

export const VALID_ANCHORS: ReadonlySet<string> = new Set<PlacementAnchor>([
  'center',
  'min',
  'base-center',
]);

/**
 * Compute the stored `position` so that the requested anchor lands at `inputPosition`.
 *
 * The offset is computed in the LOCAL, UNROTATED frame. Rotation is NOT applied here —
 * it is applied later by the viewport about the stored origin.
 *
 * @param halfExtents  [hx, hy, hz]: half-extents of the AABB measured from its CENTER
 *                     (the entity spans ±hx in X, ±hy in Y, ±hz in Z about the AABB center).
 *                     Always positive. Independent of `defaultAnchor` — always center-relative,
 *                     so callers pass e.g. `height/2`, not the full height.
 * @param defaultAnchor  The anchor that the stored `position` natively represents
 *                       (each command's pre-W4B convention, e.g. box='center', cone='base-center').
 * @param requestedAnchor  The anchor the CALLER named; unknown values fall back to `defaultAnchor`.
 * @param inputPosition    The world-space position the caller wants the named anchor to land at.
 * @returns The stored `position` to persist on the entity.
 */
export function resolvePosition(
  halfExtents: Vec3,
  defaultAnchor: PlacementAnchor,
  requestedAnchor: unknown,
  inputPosition: Vec3,
): Vec3 {
  const anchor: PlacementAnchor =
    typeof requestedAnchor === 'string' && VALID_ANCHORS.has(requestedAnchor)
      ? (requestedAnchor as PlacementAnchor)
      : defaultAnchor;

  if (anchor === defaultAnchor) return inputPosition;

  const [hx, hy, hz] = halfExtents;

  // Anchor point relative to AABB center (canonical frame):
  // center      → [0,    0,    0   ]
  // min         → [-hx, -hy,  -hz  ]
  // base-center → [0,    0,   -hz  ]  (bottom face center; min-Z = aabbCenter.z − hz)

  function anchorOffsetFromCenter(a: PlacementAnchor): Vec3 {
    switch (a) {
      case 'center':
        return [0, 0, 0];
      case 'min':
        return [-hx, -hy, -hz];
      case 'base-center':
        return [0, 0, -hz];
    }
  }

  // Derivation (all offsets relative to AABB center):
  //   anchorPoint(a) = aabbCenter + anchorOffsetFromCenter(a)
  //   storedOrigin   = aabbCenter + anchorOffsetFromCenter(defaultAnchor)   [by definition]
  //   We want: storedOrigin + (anchorPoint(requested) - storedOrigin) = inputPosition
  //     ↔ anchorPoint(requested) = inputPosition
  //     ↔ aabbCenter + anchorOffsetFromCenter(requested) = inputPosition
  //     ↔ aabbCenter = inputPosition - anchorOffsetFromCenter(requested)
  //   And storedOrigin = aabbCenter + anchorOffsetFromCenter(defaultAnchor)
  //     = inputPosition - anchorOffsetFromCenter(requested) + anchorOffsetFromCenter(defaultAnchor)

  const defOffset = anchorOffsetFromCenter(defaultAnchor);
  const reqOffset = anchorOffsetFromCenter(anchor);

  return [
    inputPosition[0] - reqOffset[0] + defOffset[0],
    inputPosition[1] - reqOffset[1] + defOffset[1],
    inputPosition[2] - reqOffset[2] + defOffset[2],
  ];
}

/** Format an AABB for inclusion in a command summary. */
export function boundsText(b: { min: Vec3; max: Vec3 }): string {
  const fmt = (v: number): string => parseFloat(v.toFixed(4)).toString();
  return `world AABB min [${b.min.map(fmt).join(', ')}] max [${b.max.map(fmt).join(', ')}]`;
}

/** Helper: clone the document shallowly with new entity maps. Keeps commands pure. */
export function withEntity(doc: CadDocument, entity: Entity): CadDocument {
  return {
    ...doc,
    entities: { ...doc.entities, [entity.id]: entity },
    order: [...doc.order, entity.id],
  };
}

/**
 * @command add_box
 * @pure
 * @layer core/commands
 * @affects creates 1 box entity
 * @invariant all size components > 0
 * @failure any size component <= 0 or non-finite -> no-op, affected:[]
 * @failure malformed rotation -> entity still created with rotation [0,0,0]
 * @failure unknown anchor value -> falls back to default anchor 'center', no throw
 */
