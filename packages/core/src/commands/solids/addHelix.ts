/** add_helix: an exact helix / planar spiral as a `nurbs_curve` that keeps its design intent (SWG M3). */

import type { CommandResult } from '../types';
import { defineCommand, looseVec3, z } from '../schema';
import { tableRejection } from '../noop';
import { nextId } from '../../lib/id';
import { ORIGIN, finiteVec3OrZero, isVec3, len3, scale3 } from '../../lib/vec3';
import { compactNumber as fmt } from '../../lib/compactNumber';
import { lawIssue } from '../../lib/law/evaluate';
import type { ScalarLaw } from '../../lib/law/types';
import { helixCurve, helixDifferentials, helixHeightAt, helixLength } from '../../lib/helix/helix';
import type { HelixDefinition } from '../../lib/helix/types';
import { newEntity } from '../entity/newEntity';
import { commitEntity } from '../entity/commitEntity';
import { curveStyleFields, DEFAULT_CURVE_COLOR } from '../surface/shared';
import { existingLayerOrDefault } from './shared';
import { parseLaw } from '../../lib/law/parse';
import { lawField } from './sweepLaws';

const MAX_TURNS = 200;

const refuse = tableRejection({
  SWG_HELIX_PARAMS: 'give exactly two of pitch, turns, height (or pitchLaw with turns); a spiral takes turns with endRadius or pitch',
  SWG_HELIX_RADIUS: 'use positive radii; a taper must stay above zero over the whole height',
  SWG_LAW_INVALID: 'fix pitchLaw: a table needs t strictly increasing from 0 to 1',
  SWG_LAW_NONPOSITIVE: 'keep the pitch strictly positive over the whole helix',
  SWG_FIT_TOLERANCE: 'loosen tolerance: the NURBS display curve could not reach it within its span budget',
});

/**
 * @affects creates 1 nurbs_curve entity carrying its HelixDefinition (`analytic`); position = the helix origin
 * @invariant the poles lie within `tolerance` of the exact helix (reported as data.fitDeviation); the start point is at startAngleRad on the radius circle
 * @failure not exactly two of pitch / turns / height -> SWG_HELIX_PARAMS; radius <= 0 or a taper through the axis -> SWG_HELIX_RADIUS;
 *   bad / non-positive pitch law -> SWG_LAW_INVALID / SWG_LAW_NONPOSITIVE; fit not reached -> SWG_FIT_TOLERANCE
 */
export const addHelix = defineCommand({
  name: 'add_helix',
  description:
    'Create an exact helix (cylindrical, conical or with a variable pitch) or a planar spiral as a NURBS curve that remembers its definition: the sweep along it is built ' +
    'from the exact helix by the exact kernel (springs, threads, screws, coils, worm gears). The helix starts at position + radius along a reference direction ⟂ axis, and winds about axis (default +Z) ' +
    'right-handed (counter-clockwise rising, default) or left-handed. Give exactly two of pitch (axial advance per turn), turns and height (total axial length), or pitchLaw ' +
    '(a law of the turn fraction t in 0..1, e.g. a table: closed end turns and a wider middle) together with turns. radius is the start radius; endRadius or taperDeg ' +
    '(half angle, degrees, positive narrows along the axis) makes it conical. type "spiral" winds in the plane ⟂ axis from radius to endRadius, or by pitch (radial advance per turn) over turns. ' +
    'Lengths in document units, angles in radians (startAngleRad) except taperDeg. Returns data { length, curvatureRadiusMin, torsion, turns, pitch, height, fitDeviation, unit }. ' +
    'Next: sweep_profile with pathId (a round wire; for a flat thread section use orientation axis_plane), or add_coil for a ready spring.',
  params: z.object({
    axis: looseVec3('Direction [x, y, z] of the helix axis (non-zero). Default [0, 0, 1].').optional(),
    radius: z.number().describe('Radius at the start of the helix, document units (> 0).'),
    endRadius: z
      .number()
      .describe('Radius at the end (> 0): conical helix or spiral. Do not combine with taperDeg. Omit for a cylinder.')
      .optional(),
    taperDeg: z
      .number()
      .describe(
        'Cone half angle in degrees (helix only): the radius changes by -height * tan(taperDeg); positive narrows. Do not combine with endRadius.',
      )
      .optional(),
    pitch: z
      .number()
      .describe(
        'Axial advance per turn (helix) or radial advance per turn (spiral), document units, > 0. Give two of pitch, turns, height.',
      )
      .optional(),
    turns: z.number().describe('Number of turns, 0 < turns <= 200, fractions allowed.').optional(),
    height: z.number().describe('Total axial length of the helix, document units (> 0).').optional(),
    pitchLaw: lawField('Axial advance per turn (> 0, document units); t is the fraction of the turns'),
    type: z.enum(['helix', 'spiral']).describe('"helix" (default) rises along the axis; "spiral" stays in the plane ⟂ axis.').optional(),
    handedness: z
      .enum(['right', 'left'])
      .describe('"right" (default, counter-clockwise seen against the axis while rising) or "left".')
      .optional(),
    startAngleRad: z.number().describe('Start angle about the axis, radians, measured from the reference direction. Default 0.').optional(),
    tolerance: z
      .number()
      .describe('Largest distance between the NURBS poles and the exact helix, document units. Default 1e-6 × the larger radius.')
      .optional(),
    ...curveStyleFields(),
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, path: string): CommandResult => refuse(doc, 'add_helix', code, message, [], [path]);
    const { radius, type = 'helix', handedness = 'right', startAngleRad = 0, pitchLaw } = params;
    const axisIn = params.axis ?? [0, 0, 1];
    if (!isVec3(axisIn) || len3(axisIn) < 1e-9) return fail('SWG_HELIX_PARAMS', 'axis must be a non-zero [x, y, z]', 'axis');
    const axis = scale3(axisIn, 1 / len3(axisIn));
    if (!(Number.isFinite(radius) && radius > 0)) return fail('SWG_HELIX_RADIUS', `radius must be > 0 (got ${radius})`, 'radius');
    if (!Number.isFinite(startAngleRad)) return fail('SWG_HELIX_PARAMS', 'startAngleRad must be finite', 'startAngleRad');
    const positive = (v: number | undefined): boolean => v === undefined || (Number.isFinite(v) && v > 0);
    if (!positive(params.pitch) || !positive(params.turns) || !positive(params.height))
      return fail('SWG_HELIX_PARAMS', 'pitch, turns and height must be finite and > 0', 'pitch');
    if (params.endRadius !== undefined && params.taperDeg !== undefined)
      return fail('SWG_HELIX_PARAMS', 'give endRadius or taperDeg, not both', 'taperDeg');
    let law: ScalarLaw | undefined;
    if (pitchLaw !== undefined) {
      const parsed = parseLaw(pitchLaw);
      if (typeof parsed === 'string') return fail('SWG_LAW_INVALID', `pitchLaw: ${parsed}`, 'pitchLaw');
      const issue = lawIssue(parsed, { positive: true, length: 1 });
      if (issue !== null) return fail(issue.code, `pitchLaw: ${issue.message}`, 'pitchLaw');
      law = parsed;
    }
    const given = [params.pitch, params.turns, params.height].filter((v) => v !== undefined).length;
    let turns = params.turns;
    let pitch: number | ScalarLaw;
    if (type === 'spiral') {
      if (
        law !== undefined ||
        params.height !== undefined ||
        params.taperDeg !== undefined ||
        turns === undefined ||
        (params.endRadius === undefined) === (params.pitch === undefined)
      )
        return fail(
          'SWG_HELIX_PARAMS',
          'a spiral takes turns and exactly one of endRadius or pitch (no height, pitchLaw or taperDeg)',
          'type',
        );
      pitch = params.pitch ?? 0;
    } else if (law !== undefined) {
      if (given !== 1 || turns === undefined) return fail('SWG_HELIX_PARAMS', 'with pitchLaw give turns and no pitch / height', 'pitchLaw');
      pitch = law;
    } else {
      if (given !== 2) return fail('SWG_HELIX_PARAMS', `give exactly two of pitch, turns, height (got ${given})`, 'pitch');
      turns ??= (params.height as number) / (params.pitch as number);
      pitch = params.pitch ?? (params.height as number) / turns;
    }
    if (!(turns > 0 && turns <= MAX_TURNS))
      return fail('SWG_HELIX_PARAMS', `turns must be in (0, ${MAX_TURNS}] (got ${fmt(turns)})`, 'turns');
    const base: HelixDefinition = {
      type,
      origin: ORIGIN,
      axis,
      radius,
      endRadius: radius,
      turns,
      pitch,
      handedness,
      startAngle: startAngleRad,
    };
    const height = helixHeightAt(base, 1);
    let endRadius = params.endRadius ?? radius;
    if (type === 'spiral' && params.endRadius === undefined) endRadius = radius + (pitch as number) * turns;
    if (params.taperDeg !== undefined) endRadius = radius - height * Math.tan((params.taperDeg * Math.PI) / 180);
    if (!(Number.isFinite(endRadius) && endRadius > 0))
      return fail('SWG_HELIX_RADIUS', `the end radius would be ${fmt(endRadius)}: the helix must stay at a positive radius`, 'endRadius');
    const tolerance = params.tolerance ?? 1e-6 * Math.max(radius, endRadius);
    if (!(Number.isFinite(tolerance) && tolerance > 0))
      return fail('SWG_FIT_TOLERANCE', `tolerance must be > 0 (got ${tolerance})`, 'tolerance');
    const definition: HelixDefinition = { ...base, endRadius };
    const fitted = helixCurve(definition, tolerance);
    if (fitted.deviation > tolerance)
      return fail(
        'SWG_FIT_TOLERANCE',
        `the NURBS curve deviates ${fitted.deviation.toExponential(2)} from the helix (tolerance ${tolerance.toExponential(2)})`,
        'tolerance',
      );
    const id = nextId('helix');
    const entity = {
      ...newEntity('nurbs_curve', id, { curve: fitted.curve }, finiteVec3OrZero(params.position), params.color ?? DEFAULT_CURVE_COLOR, {
        layerId: existingLayerOrDefault(doc, params.layerId),
        name: params.name,
      }),
      analytic: definition,
    };
    const length = helixLength(definition);
    const { curvatureRadiusMin, torsionMean } = helixDifferentials(definition);
    const meanPitch = type === 'helix' ? height / turns : 0;
    return {
      ...commitEntity(
        doc,
        entity,
        `add_helix: created ${type} "${id}" — ${handedness}-hand, ${fmt(turns)} turns, radius ${fmt(radius)}${endRadius === radius ? '' : ` to ${fmt(endRadius)}`}` +
          `${type === 'helix' ? `, height ${fmt(height)}` : ''}, length ${fmt(length)} (${fitted.spans} cubic spans, fit ${fitted.deviation.toExponential(1)})`,
      ),
      data: {
        length,
        curvatureRadiusMin,
        torsion: torsionMean,
        turns,
        pitch: meanPitch,
        height,
        fitDeviation: fitted.deviation,
        spans: fitted.spans,
        unit: doc.units,
      },
    };
  },
});
