import type { BaseEntity, CadDocument, Entity, Vec3 } from '../model/types';
import type { CommandResult } from './types';
import { z, looseVec3, tolerant } from './schema';
import { rotatedEntityBounds } from './sceneRotatedBounds';
import { add3, finiteVec3OrZero } from '../lib/vec3';
import { nextId } from '../lib/id';
import { commitEntity } from './commitEntity';
import { newEntity } from './newEntity';
import { noop } from './noop';
import { compactNumber } from '../lib/compactNumber';
import { isVec2 } from '../lib/vec2';

/** `entity` with its position offset by `delta` (the one translation used by every move command). */
export function translated(entity: Entity, delta: Vec3): Entity {
  return { ...entity, position: add3(entity.position, delta) };
}

/**
 * Which point of the entity's local, UNROTATED AABB lands at the caller's `position` (right-handed,
 * +Z up). The stored `position` is the one that achieves this before rotation; the viewport rotates
 * about the stored origin.
 *
 * | value         | anchor point                                   |
 * |---------------|------------------------------------------------|
 * | 'center'      | geometric center: mid X, mid Y, mid Z          |
 * | 'min'         | min corner: min X, min Y, min Z                |
 * | 'base-center' | center of the bottom face: mid X, mid Y, min Z |
 */
type PlacementAnchor = 'center' | 'min' | 'base-center';

const VALID_ANCHORS: ReadonlySet<string> = new Set<PlacementAnchor>([
  'center',
  'min',
  'base-center',
]);

/** Offset of `anchor` from the AABB center, given the positive half-extents `[hx, hy, hz]`. */
function anchorOffsetFromCenter(anchor: PlacementAnchor, [hx, hy, hz]: Vec3): Vec3 {
  switch (anchor) {
    case 'center':
      return [0, 0, 0];
    case 'min':
      return [-hx, -hy, -hz];
    case 'base-center':
      return [0, 0, -hz];
  }
}

/**
 * The `position` to store so that the requested anchor lands at `inputPosition`:
 * `inputPosition − offset(requested) + offset(defaultAnchor)`, offsets measured from the AABB center.
 * @param halfExtents center-relative half-extents (e.g. `height / 2`, not the full height)
 * @param defaultAnchor the anchor the stored position natively represents (box 'center', cone 'base-center')
 * @param requestedAnchor the caller's anchor; anything but a valid anchor falls back to `defaultAnchor`
 */
function resolvePosition(
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

  const requestedOffset = anchorOffsetFromCenter(anchor, halfExtents);
  const defaultOffset = anchorOffsetFromCenter(defaultAnchor, halfExtents);
  return [
    inputPosition[0] - requestedOffset[0] + defaultOffset[0],
    inputPosition[1] - requestedOffset[1] + defaultOffset[1],
    inputPosition[2] - requestedOffset[2] + defaultOffset[2],
  ];
}

/** `world AABB min [...] max [...]` for command summaries. */
export function boundsText(b: { min: Vec3; max: Vec3 }): string {
  return `world AABB min [${b.min.map(compactNumber).join(', ')}] max [${b.max.map(compactNumber).join(', ')}]`;
}

/** Default color of every placed primitive solid. */
export const DEFAULT_SOLID_COLOR = '#6b8f9c';

/** Default color of extrusions and component instances. */
export const EXTRUSION_COLOR = '#c8553d';

/** Shared `.describe()` lead-in naming the rotation convention of every `rotation` param. */
export const ROTATION_CONVENTION =
  'three.js intrinsic XYZ Euler angles in RADIANS [rx, ry, rz] (equivalent to rotating about world Z first, then world Y, then world X)';

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
      `${ROTATION_CONVENTION}. ` +
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
      return noop(doc, `${command} failed: ${name} must be finite and > 0, got ${value}.`);
    }
  }
  return null;
}

/** Same as `rejectNonPositive` for a `[w, h, d]` size vector (one combined summary). */
export function rejectBadSize(doc: CadDocument, command: string, size: Vec3): CommandResult | null {
  if (
    Array.isArray(size) &&
    size.length === 3 &&
    size.every((component) => Number.isFinite(component) && component > 0)
  ) {
    return null;
  }
  return noop(
    doc,
    `${command} failed: size must be 3 components [w, h, d], all finite and > 0, got [${Array.isArray(size) ? size.join(', ') : String(size)}].`,
  );
}

/**
 * Reject a 2D profile whose points are not all finite `[x, y]` pairs: the failing no-op naming
 * the first bad point, or `null` when valid (length is checked by the caller).
 */
export function rejectBadProfile(
  doc: CadDocument,
  command: string,
  profile: ReadonlyArray<unknown>,
): CommandResult | null {
  const index = profile.findIndex((point) => !isVec2(point));
  if (index < 0) return null;
  return noop(
    doc,
    `${command} failed: profile point ${index} must be a finite [x, y] pair, got ${JSON.stringify(profile[index])}; no-op.`,
  );
}

/** Append `entity` and report it: `<description>; world AABB ...` with `affected: [entity.id]`. */
export function commitSolid(doc: CadDocument, entity: Entity, description: string): CommandResult {
  return commitEntity(doc, entity, `${description}; ${boundsText(rotatedEntityBounds(entity))}.`);
}

/**
 * Create a primitive solid of `kind` with a fresh `idPrefix` id and report it via `commitSolid`.
 * `position` is interpreted through `anchor` (see `PlacementAnchor`), `rotation` is sanitised.
 * @param describe summary text for the new id, before the `; world AABB ...` suffix
 */
export function placeSolid<K extends Entity['kind']>(
  doc: CadDocument,
  spec: {
    readonly kind: K;
    readonly idPrefix: string;
    readonly geometry: Omit<Extract<Entity, { kind: K }>, keyof BaseEntity>;
    readonly halfExtents: Vec3;
    readonly defaultAnchor: PlacementAnchor;
    readonly anchor: unknown;
    readonly position: Vec3;
    readonly rotation: unknown;
    readonly color: string;
    readonly describe: (id: string) => string;
  },
): CommandResult {
  const storedPosition = resolvePosition(
    spec.halfExtents,
    spec.defaultAnchor,
    spec.anchor,
    spec.position,
  );
  const id = nextId(spec.idPrefix);
  const entity = newEntity(spec.kind, id, spec.geometry, storedPosition, spec.color, {
    rotation: finiteVec3OrZero(spec.rotation),
  });
  return commitSolid(doc, entity, spec.describe(id));
}
