/**
 * The outline of a text entity as the commands see it (03 WRP): its font outline, bent along its `onCurve` curve when it has one. One place for `text_outline`, `extrude_profile` and the
 * sketch outlines of wrap / emboss, so a text on a curve is the same shape everywhere.
 * @failure the curve is missing, no 2D curve, in another plane, or too short for the text -> a coded `{ code, message }`
 */

import type { CadDocument, Entity, TextEntity, Vec2 } from '../../model/types';
import { inverseEulerXYZ } from '../../lib/eulerRotation';
import type { ParsedFont } from '../../lib/font/font';
import { segmentOfCurve, sampleSegment } from '../../geometry/planeSegments';
import { curveMapper } from '../../geometry/textOnCurve';
import { outlineErrorCode, textOutline, type TextOutline } from '../../geometry/textOutline';
import { entityCurves } from '../solids/sketchCurves';

/** Points sampled on every piece of the curve the text follows. */
const SAMPLES_PER_PIECE = 48;
const ROTATION_TOLERANCE = 1e-9;

/** The entity's plane coordinates: its local frame plus the entity position expressed in its own plane. */
export function planeShift(entity: Entity): Vec2 {
  const [x, y] = inverseEulerXYZ(entity.position, entity.rotation);
  return [x, y];
}

export interface TextOutlineFailure {
  readonly code: string;
  readonly message: string;
}

export const isOutlineFailure = (value: TextOutline | TextOutlineFailure): value is TextOutlineFailure => 'code' in value;

export function outlineOfText(
  doc: CadDocument,
  entity: TextEntity,
  font: ParsedFont,
  overrides: { readonly kerning?: boolean } = {},
): TextOutline | TextOutlineFailure {
  const source = overrides.kerning === undefined ? entity : { ...entity, kerning: overrides.kerning };
  const link = entity.onCurve;
  let mapper;
  if (link !== undefined) {
    const curve = doc.entities[link.curveId];
    const parts = curve === undefined ? null : entityCurves(curve);
    if (curve === undefined || parts === null)
      return {
        code: 'WRP_TEXT_CURVE_INVALID',
        message: `text '${entity.id}' follows '${link.curveId}', which is ${curve === undefined ? 'not in the document' : `a ${curve.kind}, not a 2D curve`}`,
      };
    if (curve.rotation.some((angle, k) => Math.abs(angle - (entity.rotation[k] as number)) > ROTATION_TOLERANCE))
      return {
        code: 'WRP_TEXT_CURVE_PLANE',
        message: `text '${entity.id}' and its curve '${link.curveId}' lie in different planes (rotations differ); put them on the same sketch plane`,
      };
    const [dx, dy] = planeShift(curve);
    const polyline = parts.curves.flatMap((piece, k) =>
      sampleSegment(segmentOfCurve(piece), SAMPLES_PER_PIECE)
        .slice(k === 0 ? 0 : 1)
        .map((p): Vec2 => [p[0] + dx, p[1] + dy]),
    );
    mapper = curveMapper(polyline, entity.anchor ?? 'left', link.offset ?? 0, link.reverse === true, planeShift(entity));
    if (mapper === null) return { code: 'WRP_TEXT_CURVE_INVALID', message: `the curve '${link.curveId}' has no length` };
  }
  const outline = textOutline(source, font, mapper?.map);
  return 'error' in outline ? { code: outlineErrorCode(outline.error), message: outline.message } : outline;
}
