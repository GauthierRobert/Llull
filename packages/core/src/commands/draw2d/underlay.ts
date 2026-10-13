/**
 * Image underlays: a scanned drawing placed on a work plane, calibrated to real units, and read
 * back as model coordinates ("trace from a drawing"). Geometry lives in
 * `geometry/imageUnderlay.ts`; these commands validate and commit it.
 *
 * @layer core/commands
 */

import { type CadDocument, type ImageEntity, type Vec3, DEFAULT_LAYER_ID } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, nameField, vec2, vec3, z } from '../schema';
import { nextId } from '../../lib/id';
import { ORIGIN } from '../../lib/vec3';
import { parseImageDataUrl } from '../../lib/imageDataUrl';
import { calibrateUnderlay, pixelToWorld } from '../../geometry/imageUnderlay';
import { commitEntity } from '../entity/commitEntity';
import { replaceEntity } from '../entity/entityOps';
import { entityOfKind } from '../entity/entityOfKind';
import { changed, failer, noop, report } from '../noop';
import { MAX_IMAGE_DATA_URL_LENGTH, MAX_IMAGE_PIXEL_SIDE, MAX_PROFILE_POINTS } from '../limits';
import { ROTATION_CONVENTION } from '../solids/shared';
import { toDegrees } from '../../lib/angle';
import { roundTo } from '../../lib/compactNumber';

const DEFAULT_OPACITY = 0.5;

const PIXEL_CONVENTION =
  'Image pixel coordinates [px, py]: origin at the TOP-left corner of the picture, +px right, ' +
  '+py DOWN (as read off the image); fractional values are fine.';

const formatPoint = (point: readonly number[]): string =>
  `[${point.map((value) => roundTo(value, 6)).join(', ')}]`;

/** The image entity `id`, or a no-op result explaining why there is none. */
function underlayOf(doc: CadDocument, id: string, command: string): ImageEntity | CommandResult {
  const found = entityOfKind(doc, id, ['image']);
  return typeof found === 'string' ? noop(doc, `${command}: ${found}.`) : found;
}

const isImage = (value: ImageEntity | CommandResult): value is ImageEntity => 'kind' in value;

const opacityField = (note: string): z.ZodOptional<z.ZodNumber> =>
  z.number().describe(`Opacity in [0, 1] (0 = invisible, 1 = opaque). ${note}`).optional();

/**
 * @command add_image_underlay
 * @pure
 * @affects creates 1 image entity
 * @invariant width = pixelWidth × unitsPerPixel; height keeps the image aspect ratio
 * @failure not a png/jpeg base64 data URL, too large, both width and pixelSize, non-positive size,
 *   opacity outside [0, 1] -> no-op, affected:[]
 */
export const addImageUnderlay = defineCommand({
  name: 'add_image_underlay',
  description:
    'Place a raster image (a scanned drawing, a photo of a sketch) on a 2D work plane as a ' +
    'semi-transparent underlay to trace over. The lower-left corner of the image sits at `position`; ' +
    'size it with `width` (document units) OR `pixelSize` (document units per pixel, e.g. 1.5 for ' +
    '1.5 mm/px); with neither, 1 unit per pixel. Then use calibrate_underlay (two pixel points + their ' +
    'real distance) to fix the scale, origin and orientation, and image_to_world to convert pixel ' +
    'coordinates read off the picture into model coordinates for draw_polyline / extrude_profile / ' +
    `revolve_profile. Accepts PNG or JPEG base64 data URLs up to ${MAX_IMAGE_DATA_URL_LENGTH} characters.`,
  params: z.object({
    dataUrl: z
      .string()
      .describe(
        'The image as a base64 data URL: "data:image/png;base64,…" or "data:image/jpeg;base64,…".',
      ),
    position: vec3(
      'World position [x, y, z] of the image lower-left corner (work-plane origin). Defaults to [0, 0, 0].',
    ).optional(),
    rotation: vec3(`${ROTATION_CONVENTION} of the work plane. Defaults to [0, 0, 0].`).optional(),
    width: z
      .number()
      .describe('Placed image width in document units (> 0); height follows the aspect ratio.')
      .optional(),
    pixelSize: z
      .number()
      .describe(
        'Document units per image pixel (> 0), e.g. 1.5 for a 1.5 mm/px scan. Excludes width.',
      )
      .optional(),
    opacity: opacityField(`Defaults to ${DEFAULT_OPACITY}.`),
    locked: z
      .boolean()
      .describe('true: the viewport never picks/selects it while tracing. Defaults to false.')
      .optional(),
    name: nameField(),
  }),
  run: (
    doc,
    {
      dataUrl,
      position = ORIGIN,
      rotation = ORIGIN,
      width,
      pixelSize,
      opacity = DEFAULT_OPACITY,
      locked = false,
      name,
    },
  ): CommandResult => {
    const fail = failer(doc, 'add_image_underlay');
    if (dataUrl.length > MAX_IMAGE_DATA_URL_LENGTH)
      return fail(
        `dataUrl is ${dataUrl.length} characters, over the ${MAX_IMAGE_DATA_URL_LENGTH} limit — downscale or recompress the image`,
      );
    const parsed = parseImageDataUrl(dataUrl);
    if (!parsed.ok) return fail(parsed.error);
    const { pixelWidth, pixelHeight } = parsed;
    if (Math.max(pixelWidth, pixelHeight) > MAX_IMAGE_PIXEL_SIDE)
      return fail(
        `image is ${pixelWidth}×${pixelHeight} px; the largest side may be ${MAX_IMAGE_PIXEL_SIDE} px`,
      );
    if (width !== undefined && pixelSize !== undefined)
      return fail('give width OR pixelSize, not both');
    const unitsPerPixel = width !== undefined ? width / pixelWidth : (pixelSize ?? 1);
    if (!Number.isFinite(unitsPerPixel) || unitsPerPixel <= 0)
      return fail(`width/pixelSize must be > 0 (got ${width ?? pixelSize})`);
    if (!(opacity >= 0 && opacity <= 1)) return fail(`opacity must be in [0, 1] (got ${opacity})`);

    const id = nextId('image');
    const entity: ImageEntity = {
      id,
      kind: 'image',
      dataUrl,
      pixelWidth,
      pixelHeight,
      width: pixelWidth * unitsPerPixel,
      height: pixelHeight * unitsPerPixel,
      opacity,
      locked,
      position,
      rotation,
      layerId: DEFAULT_LAYER_ID,
      color: '#ffffff',
      ...(name !== undefined && name !== '' ? { name } : {}),
    };
    return commitEntity(
      doc,
      entity,
      `Added ${parsed.mime} underlay ${id} (${pixelWidth}×${pixelHeight} px) as ` +
        `${roundTo(entity.width, 6)}×${roundTo(entity.height, 6)} units (${roundTo(unitsPerPixel, 6)} units/px) ` +
        `at ${formatPoint(position)}, opacity ${opacity}${locked ? ', locked' : ''}.`,
    );
  },
});

/**
 * @command calibrate_underlay
 * @pure
 * @affects modifies 1 image entity (width, height, position, rotation[2] when align is set)
 * @invariant |pixelToWorld(B) − pixelToWorld(A)| = distance afterwards
 * @failure missing/non-image id, distance <= 0, pixelA = pixelB -> no-op, affected:[]
 */
export const calibrateUnderlayCommand = defineCommand({
  name: 'calibrate_underlay',
  description:
    'Set an image underlay to true scale from a known dimension: two points in IMAGE PIXEL ' +
    'coordinates and the real distance between them (document units). The scale becomes ' +
    'distance / pixel distance units per pixel (uniform). By default pixelA keeps its world position; ' +
    'pass `origin` to pin a pixel to a world point instead (e.g. the drawing datum to [0, 0, 0]). ' +
    'Pass `align` "x" or "y" to rotate the image in its plane (by the smallest angle) so the A→B ' +
    'segment runs along that axis — this also de-skews a crooked scan. ' +
    PIXEL_CONVENTION,
  params: z.object({
    id: z.string().describe('Id of the image underlay to calibrate.'),
    pixelA: vec2(`First reference point. ${PIXEL_CONVENTION}`),
    pixelB: vec2('Second reference point, same pixel convention as pixelA.'),
    distance: z
      .number()
      .describe('Real distance between pixelA and pixelB, in document units (> 0).'),
    origin: z
      .object({
        pixel: vec2('Image pixel [px, py] to pin (same convention as pixelA).'),
        world: vec3('World point [x, y, z] that pixel maps to after calibration.'),
      })
      .describe(
        'Optional: pin an image pixel to a world point. Defaults to pixelA staying where it is.',
      )
      .optional(),
    align: z
      .enum(['none', 'x', 'y'])
      .describe('Rotate in-plane so A→B lies along the work-plane "x" or "y" axis. Default "none".')
      .optional(),
  }),
  run: (doc, { id, pixelA, pixelB, distance, origin, align = 'none' }): CommandResult => {
    const image = underlayOf(doc, id, 'calibrate_underlay');
    if (!isImage(image)) return image;
    const result = calibrateUnderlay(image, {
      pixelA,
      pixelB,
      distance,
      ...(origin !== undefined ? { origin } : {}),
      ...(align !== 'none' ? { align } : {}),
    });
    if (!result.ok) return noop(doc, `calibrate_underlay: ${result.error}; ${id} unchanged.`);
    const { placement, unitsPerPixel, pixelDistance } = result;
    const calibrated: ImageEntity = { ...image, ...placement };
    const turned =
      placement.rotation[2] === image.rotation[2]
        ? ''
        : `, rotated in-plane to ${roundTo(toDegrees(placement.rotation[2]), 6)}°`;
    return changed(
      replaceEntity(doc, calibrated),
      `Calibrated underlay ${id}: ${roundTo(pixelDistance, 6)} px = ${distance} units → ` +
        `${roundTo(unitsPerPixel, 6)} units/px; size ${roundTo(placement.width, 6)}×${roundTo(placement.height, 6)}, ` +
        `lower-left at ${formatPoint(placement.position)}${turned}.`,
      [id],
    );
  },
});

/**
 * @command set_underlay
 * @pure
 * @affects modifies 1 image entity (opacity and/or locked)
 * @failure missing/non-image id, nothing to change, opacity outside [0, 1] -> no-op, affected:[]
 */
export const setUnderlay = defineCommand({
  name: 'set_underlay',
  description:
    "Change an image underlay's display: `opacity` in [0, 1] and/or `locked` (a locked underlay " +
    'is never picked in the viewport, so tracing over it cannot select it by accident).',
  annotations: { idempotent: true },
  params: z.object({
    id: z.string().describe('Id of the image underlay.'),
    opacity: opacityField('Omit to keep the current value.'),
    locked: z.boolean().describe('Lock (true) or unlock (false). Omit to keep.').optional(),
  }),
  run: (doc, { id, opacity, locked }): CommandResult => {
    const image = underlayOf(doc, id, 'set_underlay');
    if (!isImage(image)) return image;
    if (opacity === undefined && locked === undefined)
      return noop(doc, `set_underlay: give opacity and/or locked; ${id} unchanged.`);
    if (opacity !== undefined && !(opacity >= 0 && opacity <= 1))
      return noop(
        doc,
        `set_underlay: opacity must be in [0, 1] (got ${opacity}); ${id} unchanged.`,
      );
    const next: ImageEntity = {
      ...image,
      ...(opacity !== undefined ? { opacity } : {}),
      ...(locked !== undefined ? { locked } : {}),
    };
    return changed(
      replaceEntity(doc, next),
      `Underlay ${id}: opacity ${next.opacity}, ${next.locked ? 'locked' : 'unlocked'}.`,
      [id],
    );
  },
});

/**
 * @command image_to_world
 * @pure
 * @affects nothing — read-only; data.world / data.xy align with params.points
 * @failure missing/non-image id, no points, too many points -> no-op, affected:[]
 */
export const imageToWorld = defineCommand({
  name: 'image_to_world',
  description:
    'Convert points read off an image underlay (pixel coordinates) into model coordinates. Returns ' +
    '`data.world` ([x, y, z] per point) and `data.xy` ([x, y] per point — ready for draw_polyline, ' +
    'extrude_profile or revolve_profile when the underlay lies on the XY plane), plus ' +
    '`data.unitsPerPixel`. Calibrate first (calibrate_underlay) so the numbers are true scale. ' +
    PIXEL_CONVENTION,
  annotations: { readOnly: true },
  params: z.object({
    id: z.string().describe('Id of the image underlay the pixel coordinates refer to.'),
    points: z
      .array(vec2(PIXEL_CONVENTION))
      .describe(`Pixel points [[px, py], …] to convert (1..${MAX_PROFILE_POINTS}).`),
  }),
  run: (doc, { id, points }): CommandResult => {
    const image = underlayOf(doc, id, 'image_to_world');
    if (!isImage(image)) return image;
    if (points.length === 0 || points.length > MAX_PROFILE_POINTS)
      return noop(
        doc,
        `image_to_world: give 1..${MAX_PROFILE_POINTS} points (got ${points.length}).`,
      );
    const world = points.map((pixel): Vec3 => {
      const [x, y, z] = pixelToWorld(image, pixel);
      return [roundTo(x, 6), roundTo(y, 6), roundTo(z, 6)];
    });
    const xy = world.map(([x, y]) => [x, y]);
    const unitsPerPixel = roundTo(image.width / image.pixelWidth, 6);
    return report(
      doc,
      `image_to_world: ${points.length} point(s) on ${id} (${unitsPerPixel} units/px); first ` +
        `${formatPoint(points[0] ?? [0, 0])} px → ${formatPoint(world[0] ?? [0, 0, 0])}.`,
      { world, xy, unitsPerPixel },
    );
  },
});
