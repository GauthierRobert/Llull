import type { CadDocument, Entity, Vec3 } from '../model/types';
import type { CommandResult } from './types';
import { z, looseVec3, tolerant } from './schema';
import { rotatedEntityBounds } from './sceneRotatedBounds';
import { finiteVec3OrZero } from '../lib/vec3';
import { withEntity } from './entityOps';

export const ORIGIN: Vec3 = [0, 0, 0];

/** `entity` with its position offset by `delta` (the one translation used by every move command). */
export function translated(entity: Entity, delta: Vec3): Entity {
  return {
    ...entity,
    position: [
      entity.position[0] + delta[0],
      entity.position[1] + delta[1],
      entity.position[2] + delta[2],
    ],
  };
}

/**
 * Validate an optional rotation param.
 * Returns [0,0,0] if rotation is absent, not length-3, or contains non-finite values.
 * Never throws — malformed rotation is silently ignored and the entity is created unrotated.
 */
export function resolveRotation(rotation: unknown): Vec3 {
  return finiteVec3OrZero(rotation);
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
type PlacementAnchor = 'center' | 'min' | 'base-center';

const VALID_ANCHORS: ReadonlySet<string> = new Set<PlacementAnchor>([
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
 *                       (each command's native convention, e.g. box='center', cone='base-center').
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
function boundsText(b: { min: Vec3; max: Vec3 }): string {
  const fmt = (v: number): string => parseFloat(v.toFixed(4)).toString();
  return `world AABB min [${b.min.map(fmt).join(', ')}] max [${b.max.map(fmt).join(', ')}]`;
}

/** Default color of every placed primitive solid. */
export const DEFAULT_SOLID_COLOR = '#6b8f9c';

/** `position` param of a placed primitive; `note` is inserted before the default sentence. */
export function positionField(note = ''): z.ZodOptional<z.ZodType<Vec3>> {
  return looseVec3(
    'World-space location of the anchor point [x, y, z] in document units. ' +
      `Right-handed frame, +Z up. ${note}Defaults to [0, 0, 0].`,
  ).optional();
}

/** `anchor` param of a placed primitive; `description` names the shape and its default anchor. */
export function anchorField(description: string): z.ZodOptional<
  z.ZodCatch<
    z.ZodEnum<{
      center: 'center';
      min: 'min';
      'base-center': 'base-center';
    }>
  >
> {
  return tolerant(z.enum(['center', 'min', 'base-center']).describe(description)).optional();
}

/** `rotation` param of a placed primitive; `note` replaces the "Matches rotate_entity" lead-in. */
export function rotationField(
  note = 'Matches rotate_entity convention.',
): z.ZodOptional<z.ZodCatch<z.ZodType<Vec3>>> {
  return tolerant(
    looseVec3(
      'Extrinsic XYZ Euler angles in RADIANS [rx, ry, rz]. ' +
        `${note} Defaults to [0, 0, 0]. ` +
        'If non-finite or not length-3 the rotation is ignored and [0,0,0] is used.',
    ),
  ).optional();
}

/**
 * Reject non-finite or non-positive named dimensions: returns the failing no-op result, or `null`
 * when every value is finite and > 0. Checked in order.
 */
export function rejectNonPositive(
  doc: CadDocument,
  command: string,
  dimensions: ReadonlyArray<readonly [name: string, value: number]>,
): CommandResult | null {
  for (const [name, value] of dimensions) {
    if (!Number.isFinite(value) || value <= 0) {
      return {
        document: doc,
        summary: `${command} failed: ${name} must be finite and > 0, got ${value}.`,
        affected: [],
      };
    }
  }
  return null;
}

/** Same as `rejectNonPositive` for a `[w, h, d]` size vector (one combined summary). */
export function rejectBadSize(doc: CadDocument, command: string, size: Vec3): CommandResult | null {
  if (size.every((component) => Number.isFinite(component) && component > 0)) return null;
  return {
    document: doc,
    summary: `${command} failed: all size components must be finite and > 0, got [${size.join(', ')}].`,
    affected: [],
  };
}

/** Append `entity` and report it: `<description>; world AABB ...` with `affected: [entity.id]`. */
export function commitSolid(doc: CadDocument, entity: Entity, description: string): CommandResult {
  const newDoc = withEntity(doc, entity);
  const bounds = rotatedEntityBounds(newDoc.entities[entity.id] as Entity);
  return {
    document: newDoc,
    summary: `${description}; ${boundsText(bounds)}.`,
    affected: [entity.id],
  };
}
