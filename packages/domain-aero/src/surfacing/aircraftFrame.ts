/** set_aircraft_frame and the frame maps used by the fuselage commands (aircraft FS / BL / WL <-> document coordinates). */

import { defineCommand, vec3, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import type { AircraftFrame } from '@core/model/aero';
import { DOCUMENT_UNITS, type CadDocument, type Vec3 } from '@core/model/types';
import type { NurbsCurveData } from '@lib/nurbs/types';
import { add3, cross3, dot3, len3, scale3, sub3 } from '@lib/vec3';
import { aeroOf, withFrame } from './aeroState';
import { refuseAero } from './codes';

export const IDENTITY_FRAME: AircraftFrame = { datum: [0, 0, 0], fsAxis: [1, 0, 0], blAxis: [0, 1, 0], wlAxis: [0, 0, 1] };
const AXIS_TOLERANCE = 1e-6;

/** The frame of the document (the identity frame until `set_aircraft_frame`). */
export const frameOf = (doc: CadDocument): AircraftFrame => aeroOf(doc).frame ?? IDENTITY_FRAME;

const isIdentity = (frame: AircraftFrame): boolean =>
  frame === IDENTITY_FRAME ||
  (frame.datum.every((v) => v === 0) &&
    frame.fsAxis.join() === '1,0,0' &&
    frame.blAxis.join() === '0,1,0' &&
    frame.wlAxis.join() === '0,0,1');

/** Document position of the aircraft-frame point (fs, bl, wl). */
export const toDocument = (frame: AircraftFrame, [fs, bl, wl]: Vec3): Vec3 =>
  add3(add3(add3(frame.datum, scale3(frame.fsAxis, fs)), scale3(frame.blAxis, bl)), scale3(frame.wlAxis, wl));

/** Aircraft-frame coordinates (fs, bl, wl) of a document position (the axes are orthonormal, so the inverse is a projection). */
export const toAircraft = (frame: AircraftFrame, point: Vec3): Vec3 => {
  const offset = sub3(point, frame.datum);
  return [dot3(offset, frame.fsAxis), dot3(offset, frame.blAxis), dot3(offset, frame.wlAxis)];
};

/** `curve` (poles in aircraft coordinates) in document coordinates; the same object under the identity frame. */
export function curveToDocument(frame: AircraftFrame, curve: NurbsCurveData): NurbsCurveData {
  return isIdentity(frame) ? curve : { ...curve, poles: curve.poles.map((pole) => toDocument(frame, pole)) };
}

/** Why the axes are not an orthonormal right-handed triple, or null. */
export function frameViolation(frame: AircraftFrame): string | null {
  const { fsAxis, blAxis, wlAxis } = frame;
  for (const [name, axis] of [
    ['fsAxis', fsAxis],
    ['blAxis', blAxis],
    ['wlAxis', wlAxis],
  ] as const)
    if (Math.abs(len3(axis) - 1) > AXIS_TOLERANCE) return `${name} must have unit length (got ${len3(axis)})`;
  if (
    Math.abs(dot3(fsAxis, blAxis)) > AXIS_TOLERANCE ||
    Math.abs(dot3(fsAxis, wlAxis)) > AXIS_TOLERANCE ||
    Math.abs(dot3(blAxis, wlAxis)) > AXIS_TOLERANCE
  )
    return 'the axes must be mutually perpendicular';
  const handedness = dot3(cross3(fsAxis, blAxis), wlAxis);
  return handedness > 0 ? null : 'the axes must be right-handed (fsAxis x blAxis = wlAxis)';
}

/**
 * @affects sets doc.aero.frame (no entity); affected: []
 * @invariant fsAxis, blAxis, wlAxis unit length, mutually perpendicular, right-handed; units equal the document units
 * @failure axes not orthonormal right-handed -> AERO_FRAME_NOT_ORTHONORMAL; units differing from the document units -> AERO_PARAM_INVALID
 */
export const setAircraftFrame = defineCommand({
  name: 'set_aircraft_frame',
  description:
    'Define the aircraft coordinate frame used by fuselage stations (FS, BL, WL): a document position is datum + fs * fsAxis + bl * blAxis + ' +
    'wl * wlAxis. `datum` is the document position of FS = BL = WL = 0; the three axes are unit vectors, mutually perpendicular and right-handed ' +
    '(fsAxis x blAxis = wlAxis). Default frame when never set: datum [0, 0, 0], FS along +x (aft), BL along +y (right), WL along +z (up). Applies to ' +
    'fuselages lofted AFTER this call (loft_fuselage) and to fuselage_section_at; existing geometry is not moved. `units` must equal the document units ' +
    '(set_units first); it documents the unit of the datum and of every station value.',
  params: z.object({
    datum: vec3('Document position [x, y, z] of FS = 0, BL = 0, WL = 0, in document units.'),
    fsAxis: vec3('Unit direction [x, y, z] of increasing fuselage station (usually aft). Default use [1, 0, 0].'),
    blAxis: vec3('Unit direction [x, y, z] of increasing buttock line (usually to the right). Default use [0, 1, 0].'),
    wlAxis: vec3('Unit direction [x, y, z] of increasing water line (up). Must equal fsAxis x blAxis. Default use [0, 0, 1].'),
    units: z
      .enum(DOCUMENT_UNITS)
      .describe('Length unit of datum and stations: "mm", "cm", "m", "in" or "ft"; must equal the document units.'),
  }),
  run: (doc, { datum, fsAxis, blAxis, wlAxis, units }): CommandResult => {
    if (units !== doc.units)
      return refuseAero(
        doc,
        'set_aircraft_frame',
        'AERO_PARAM_INVALID',
        `units "${units}" differ from the document units "${doc.units}"; run set_units first`,
        [],
        ['params.units'],
      );
    if (![datum, fsAxis, blAxis, wlAxis].every((v) => v.every(Number.isFinite)))
      return refuseAero(doc, 'set_aircraft_frame', 'AERO_PARAM_INVALID', 'datum and axes must be finite', [], ['params.datum']);
    const frame: AircraftFrame = { datum, fsAxis, blAxis, wlAxis };
    const violation = frameViolation(frame);
    if (violation !== null)
      return refuseAero(
        doc,
        'set_aircraft_frame',
        'AERO_FRAME_NOT_ORTHONORMAL',
        violation,
        [],
        ['params.fsAxis', 'params.blAxis', 'params.wlAxis'],
      );
    return changed(
      withFrame(doc, frame),
      `set_aircraft_frame: datum [${datum.join(', ')}] ${units}, FS ${fsAxis.join(',')}, BL ${blAxis.join(',')}, WL ${wlAxis.join(',')}.`,
      [],
    );
  },
});
