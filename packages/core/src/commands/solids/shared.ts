import { DEFAULT_LAYER_ID, type BaseEntity, type CadDocument, type Entity, type Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { z, colorField, layerIdField, looseVec3, nameField, tolerant } from '../schema';
import { rotatedEntityBounds } from '../../geometry/rotatedBounds';
import { add3, finiteVec3OrZero, sub3 } from '../../lib/vec3';
import { nextId } from '../../lib/id';
import { commitEntity } from '../entity/commitEntity';
import { newEntity } from '../entity/newEntity';
import { idTaken } from '../../lib/explicitId';
import { noop } from '../noop';
import { compactNumber } from '../../lib/compactNumber';
import { isVec2 } from '../../lib/vec2';
import { polygonArea, polygonPerimeter } from '../../lib/polygon';
import { applyMat3, eulerFromAxis, eulerFromMat, matFromAxis, unitAxisOrNull } from '../../lib/axisRotation';

type Field<F extends (...args: never[]) => unknown> = ReturnType<F>;
type ColorField = ReturnType<typeof colorField>;

/** `entity` with its position offset by `delta` (the one translation used by every move command). */
export function translated(entity: Entity, delta: Vec3): Entity {
  return { ...entity, position: add3(entity.position, delta) };
}

/**
 * Which point of the entity's local, UNROTATED AABB lands at the caller's `position` (right-handed, +Z up): 'center' mid XYZ, 'min' min
 * corner, 'base-center' bottom-face center (mid X/Y, min Z). The stored `position` achieves this before rotation.
 */
type PlacementAnchor = 'center' | 'min' | 'base-center';

const VALID_ANCHORS: ReadonlySet<string> = new Set<PlacementAnchor>(['center', 'min', 'base-center']);

/** Offset of `anchor` from the AABB center, given the positive half-extents `[hx, hy, hz]`. */
function anchorOffsetFromCenter(anchor: PlacementAnchor, [hx, hy, hz]: Vec3): Vec3 {
  return anchor === 'center' ? [0, 0, 0] : anchor === 'min' ? [-hx, -hy, -hz] : [0, 0, -hz];
}

/**
 * The `position` to store so that the requested anchor lands at `inputPosition`: `inputPosition − offset(requested) +
 * offset(defaultAnchor)`, offsets measured from the AABB center.
 * @param halfExtents center-relative half-extents (e.g. `height / 2`, not the full height)
 * @param defaultAnchor the anchor the stored position natively represents (box 'center', cone 'base-center')
 * @param requestedAnchor the caller's anchor; anything but a valid anchor falls back to `defaultAnchor`
 */
function resolvePosition(halfExtents: Vec3, defaultAnchor: PlacementAnchor, requestedAnchor: unknown, inputPosition: Vec3): Vec3 {
  const anchor: PlacementAnchor =
    typeof requestedAnchor === 'string' && VALID_ANCHORS.has(requestedAnchor) ? (requestedAnchor as PlacementAnchor) : defaultAnchor;
  if (anchor === defaultAnchor) return inputPosition;
  return add3(sub3(inputPosition, anchorOffsetFromCenter(anchor, halfExtents)), anchorOffsetFromCenter(defaultAnchor, halfExtents));
}

/** `world AABB min [...] max [...]` for command summaries. */
export function boundsText(b: { min: Vec3; max: Vec3 }): string {
  return `world AABB min [${b.min.map(compactNumber).join(', ')}] max [${b.max.map(compactNumber).join(', ')}]`;
}

/** Default color of placed primitive solids / of extrusions and component instances. */
export const DEFAULT_SOLID_COLOR = '#6b8f9c';

export const EXTRUSION_COLOR = '#c8553d';

/** Shared `.describe()` lead-in naming the rotation convention of every `rotation` param. */
export const ROTATION_CONVENTION =
  'three.js intrinsic XYZ Euler angles in RADIANS [rx, ry, rz] (equivalent to rotating about world Z first, then world Y, then world X)';

/** `position` param of a placed primitive; `note` is inserted before the default sentence. */
export function positionField(note = ''): z.ZodOptional<z.ZodType<Vec3>> {
  return looseVec3(
    'World-space location of the anchor point [x, y, z] in document units. ' + `Right-handed frame, +Z up. ${note}Defaults to [0, 0, 0].`,
  ).optional();
}

type AnchorName = PlacementAnchor;

const STANDARD_ANCHOR_TEXT: Record<AnchorName, string> = {
  center: 'geometric center',
  min: 'min-XYZ corner of the AABB',
  'base-center': 'center of the bottom face (mid X/Y, min Z)',
};

/** `anchor` param of a placed primitive; lists `defaultAnchor` first, `details` overrides per-anchor text. */
export function anchorField(
  shape: string,
  defaultAnchor: AnchorName,
  details: Partial<Record<AnchorName, string>> = {},
): z.ZodOptional<z.ZodCatch<z.ZodEnum<{ center: 'center'; min: 'min'; 'base-center': 'base-center' }>>> {
  const order: AnchorName[] = [defaultAnchor, ...(['center', 'min', 'base-center'] as const).filter((name) => name !== defaultAnchor)];
  const lines = order.map(
    (name) => `"${name}"${name === defaultAnchor ? ' (default)' : ''}: ${details[name] ?? STANDARD_ANCHOR_TEXT[name]}. `,
  );
  const description =
    `Which point on the ${shape} the position refers to. ${lines.join('')}` +
    `Unknown values fall back to "${defaultAnchor}". ` +
    'Offset is applied in the local UNROTATED frame; viewport rotates about the stored origin.';
  return tolerant(z.enum(['center', 'min', 'base-center']).describe(description)).optional();
}

/** `rotation` param of a placed primitive; `note` replaces the "Matches rotate_entity" lead-in. */
export function rotationField(note = 'Matches rotate_entity convention.'): z.ZodOptional<z.ZodCatch<z.ZodType<Vec3>>> {
  return tolerant(
    looseVec3(
      `${ROTATION_CONVENTION}. ` +
        `${note} Defaults to [0, 0, 0]. ` +
        'If non-finite or not length-3 the rotation is ignored and [0,0,0] is used.',
    ),
  ).optional();
}

/** position / anchor / rotation / color params of a placed solid (`anchorField` arguments). */
export function placedSolidFields(
  shape: string,
  defaultAnchor: AnchorName,
  details: Partial<Record<AnchorName, string>> = {},
  rotation = rotationField(),
): { position: Field<typeof positionField>; anchor: Field<typeof anchorField>; rotation: Field<typeof rotationField>; color: ColorField } {
  return {
    position: positionField(),
    anchor: anchorField(shape, defaultAnchor, details),
    rotation,
    color: colorField(DEFAULT_SOLID_COLOR),
  };
}

/** Fields every created solid ends with: layerId, color, id (spread into `z.object`; order is schema order). */
export function solidStyleFields(): { layerId: Field<typeof layerIdField>; color: ColorField; id: Field<typeof explicitIdField> } {
  return { layerId: layerIdField(), color: colorField(DEFAULT_SOLID_COLOR), id: explicitIdField() };
}

/** `solidStyleFields` with `name` between color and id. */
export function namedSolidStyleFields(): ReturnType<typeof solidStyleFields> & { name: Field<typeof nameField> } {
  return { layerId: layerIdField(), color: colorField(DEFAULT_SOLID_COLOR), name: nameField(), id: explicitIdField() };
}

/** Optional explicit `id` param of a created solid. */
export function explicitIdField(): z.ZodOptional<z.ZodString> {
  return z.string().describe('Optional explicit entity id. If omitted a unique id is generated.').optional();
}

/** `true` when the explicit `id` is non-empty and already names an entity. */
export function explicitIdTaken(doc: CadDocument, id: string | undefined): id is string {
  return id !== undefined && id.length > 0 && idTaken(doc.entities, id);
}

/** `layerId` when it names an existing layer, else the default layer. */
export function existingLayerOrDefault(doc: CadDocument, layerId: string | undefined): string {
  return layerId !== undefined && idTaken(doc.layers, layerId) ? layerId : DEFAULT_LAYER_ID;
}

/** `axis` param of a placed primitive: direction of the primitive's local +Z (its symmetry axis). */
export function axisField(what = 'the primitive local +Z axis (its symmetry axis)'): z.ZodOptional<z.ZodCatch<z.ZodType<Vec3>>> {
  return tolerant(
    looseVec3(
      `Optional direction [dx, dy, dz] (any non-zero length, normalized) that ${what} points along ` +
        'in world space, e.g. [1, 0, 0] lays it along +X. When given it OVERRIDES rotation (the ' +
        'rotation param is ignored and the resolved Euler angles are stored). A zero-length or malformed axis is rejected as a no-op.',
    ),
  ).optional();
}

/** Stored rotation for a command with both `axis` and `rotation` params: a given `axis` wins; `error` when it is zero-length/malformed. */
export function resolveRotation(
  axis: unknown,
  rotation: unknown,
): { readonly rotation: Vec3; readonly error?: undefined } | { readonly error: string } {
  if (axis === undefined) return { rotation: finiteVec3OrZero(rotation) };
  const euler = eulerFromAxis(axis);
  return euler ? { rotation: euler } : { error: `axis must be 3 finite numbers with non-zero length, got ${JSON.stringify(axis)}` };
}

/** World frame of an assembly built along `axis` (default +Z) at `position`: local +Z maps onto the unit axis. */
interface AxisFrame {
  readonly unitAxis: Vec3;
  /** Stored Euler rotation of the frame. */
  readonly rotation: Vec3;
  /** Local point → world point. */
  readonly worldAt: (local: Vec3) => Vec3;
  /** Local direction → world direction. */
  readonly directionAt: (local: Vec3) => Vec3;
}

/** {@link AxisFrame} for `axis` / `position` params, or the failure reason when either is malformed. */
export function axisFrame(axis: unknown, position: readonly number[]): AxisFrame | string {
  const unitAxis = axis === undefined ? ([0, 0, 1] as Vec3) : unitAxisOrNull(axis);
  if (!unitAxis) return 'axis must be 3 finite numbers with non-zero length';
  if (position.length !== 3 || !position.every(Number.isFinite)) return 'position must be 3 finite numbers';
  const origin = position as Vec3;
  const matrix = matFromAxis(unitAxis);
  const directionAt = (local: Vec3): Vec3 => applyMat3(matrix, local);
  return { unitAxis, rotation: eulerFromMat(matrix), worldAt: (local) => add3(origin, directionAt(local)), directionAt };
}

/**
 * Reject non-finite or non-positive named dimensions: returns the failing no-op result, or `null`
 * when every value is finite and > 0. Checked in order.
 */
export function rejectNonPositive(doc: CadDocument, command: string, dimensions: Readonly<Record<string, number>>): CommandResult | null {
  for (const [name, value] of Object.entries(dimensions)) {
    if (!Number.isFinite(value) || value <= 0) return noop(doc, `${command} failed: ${name} must be finite and > 0, got ${value}.`);
  }
  return null;
}

/** Same as `rejectNonPositive` for a `[w, h, d]` size vector (one combined summary). */
function rejectBadSize(doc: CadDocument, command: string, size: Vec3): CommandResult | null {
  if (Array.isArray(size) && size.length === 3 && size.every((component) => Number.isFinite(component) && component > 0)) return null;
  return noop(
    doc,
    `${command} failed: size must be 3 components [w, h, d], all finite and > 0, got [${Array.isArray(size) ? size.join(', ') : String(size)}].`,
  );
}

/**
 * Reject a 2D profile whose points are not all finite `[x, y]` pairs: the failing no-op naming
 * the first bad point, or `null` when valid (length is checked by the caller).
 */
export function rejectBadProfile(doc: CadDocument, command: string, profile: ReadonlyArray<unknown>): CommandResult | null {
  const index = profile.findIndex((point) => !isVec2(point));
  if (index < 0) return null;
  return noop(doc, `${command} failed: profile point ${index} must be a finite [x, y] pair, got ${JSON.stringify(profile[index])}; no-op.`);
}

/**
 * Reject a profile whose enclosed area vanishes relative to its perimeter (all points collinear or
 * coincident): extruding/revolving it yields a zero-volume sheet. `null` when the profile has area.
 * Expects points already validated by `rejectBadProfile`.
 */
export function rejectZeroAreaProfile(
  doc: CadDocument,
  command: string,
  profile: ReadonlyArray<readonly [number, number]>,
): CommandResult | null {
  const perimeter = polygonPerimeter(profile);
  if (polygonArea(profile) > 1e-12 * perimeter * perimeter) return null;
  return noop(doc, `${command} failed: profile encloses no area (points are collinear or coincident); no-op.`);
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
    readonly axis?: unknown;
    readonly color: string;
    readonly describe: (id: string) => string;
  },
): CommandResult {
  const resolved = resolveRotation(spec.axis, spec.rotation);
  if (resolved.error !== undefined) return noop(doc, `Add ${spec.kind} failed: ${resolved.error}.`);
  const id = nextId(spec.idPrefix);
  const position = resolvePosition(spec.halfExtents, spec.defaultAnchor, spec.anchor, spec.position);
  return commitSolid(
    doc,
    newEntity(spec.kind, id, spec.geometry, position, spec.color, { rotation: resolved.rotation }),
    spec.describe(id),
  );
}

interface SolidPlacement {
  readonly position: Vec3;
  readonly rotation: unknown;
  readonly axis?: unknown;
  readonly color: string;
  readonly anchor: unknown;
}

/** Validate a `[w, h, d]` size and place a `box` / `wedge` ("Added <kind> <id> of size w×h×d"). */
export function placeSizedSolid(
  doc: CadDocument,
  kind: 'box' | 'wedge',
  idPrefix: string,
  defaultAnchor: PlacementAnchor,
  size: Vec3,
  placement: SolidPlacement,
): CommandResult {
  const rejected = rejectBadSize(doc, `add_${kind}`, size);
  if (rejected) return rejected;
  const [w, h, d] = size;
  return placeSolid(doc, {
    kind,
    idPrefix,
    geometry: { size },
    halfExtents: [w / 2, h / 2, d / 2],
    defaultAnchor,
    ...placement,
    describe: (id) => `Added ${kind} ${id} of size ${size.join('×')}`,
  });
}

/** Validate radius/height and place a `cylinder` / `cone` ("... with <radiusLabel> r and height h"). */
export function placeRoundSolid(
  doc: CadDocument,
  kind: 'cylinder' | 'cone',
  idPrefix: string,
  defaultAnchor: PlacementAnchor,
  radiusLabel: string,
  dims: { readonly radius: number; readonly height: number },
  placement: SolidPlacement,
): CommandResult {
  const { radius, height } = dims;
  const rejected = rejectNonPositive(doc, `add_${kind}`, dims);
  if (rejected) return rejected;
  return placeSolid(doc, {
    kind,
    idPrefix,
    geometry: { radius, height },
    halfExtents: [radius, radius, height / 2],
    defaultAnchor,
    ...placement,
    describe: (id) => `Added ${kind} ${id} with ${radiusLabel} ${radius} and height ${height}`,
  });
}
