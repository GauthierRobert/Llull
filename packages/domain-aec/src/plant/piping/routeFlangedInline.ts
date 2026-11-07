/**
 * Two inline parts that sit between flanges (plant 05 ISO M6c, route import): a mid-line flanged joint and an instrument.
 * - `flangedJoint`: flange - gasket - flange with one gasket and one bolt set, from the spec's flange set at the run size (weld neck on a butt-weld pipe). It occupies
 *   `gasket + 2 x hub` of the leg; the joint stays one flanged joint of the run. Nothing is stored beyond its position and tag.
 * - `instrument`: a body of a given face-to-face length (project data, not a spec row: a flow element, orifice assembly, thermowell run ...) with flanged ends (a flange set
 *   from the spec on each face, as a flanged valve) or butt-weld ends. The length is stored on the component and the part is listed as not from the catalogue (unverified).
 * @invariant pure; every flange, gasket and bolt row comes from the line spec at the run size; the instrument's own length and end type are the only stored dimensions
 * @failure no flange / gasket / bolt row, no FL-FL rule, no BW rule -> the code of the lookup; an instrument without a positive length -> RTE_SIZE_MISMATCH
 */

import type { Vec3 } from '@core/model/vectors';
import type { EndType, InlineComponent, PartPort } from '@aec/plant/types';
import { scale3 } from '@lib/vec3';
import { fail, isFailure, type DerivationFailure, type DerivedInline } from './deriveTypes';
import { resolveFlangeSet, type FlangeFace, type FlangeSet } from './flangeSet';
import { flangeParts, mintSet } from './routeEnds';
import { at, joinOf, partOf, type Env, type Mint, type Slot } from './routeEnv';
import type { CatalogueRow } from './specLookup';

export const FLANGED_JOINT = 'flangedJoint';
export const INSTRUMENT = 'instrument';

const connectionMissing = (env: Env, comp: InlineComponent): DerivationFailure =>
  fail('RTE_NO_CONNECTION_RULE', `spec ${env.lookup.id} has no FL-FL connection rule for ${comp.type} ${comp.id}`, [comp.id], ['inline'], {
    endType: 'FL',
  });

/**
 * The slot of a mid-line flanged joint of run size `dn`: flange A (upstream), the gasket centred on the component centre, flange B (downstream).
 * @failure see the module comment
 */
export function flangedJointSlot(env: Env, comp: InlineComponent, dn: number, mint: Mint): Slot | DerivationFailure {
  const { lookup, run } = env;
  if (lookup.connection('FL', 'FL') === null) return connectionMissing(env, comp);
  const pipe = env.pipeAt(dn);
  if (isFailure(pipe)) return pipe;
  const resolved = resolveFlangeSet(lookup, {}, dn, pipe.row.pipeEnd ?? 'BW');
  if ('code' in resolved) return fail(resolved.code, resolved.message, [...resolved.ids, comp.id], ['inline'], resolved.detail);
  const set = resolved;
  const g = set.gasketThickness;
  const face: FlangeFace = {
    ...(set.flange.rating === undefined ? {} : { rating: set.flange.rating }),
    ...(set.flange.facing === undefined ? {} : { facing: set.flange.facing }),
  };
  const up = mintSet(mint);
  const downFlange = mint('flange');
  const reach = g / 2 + set.hub;
  return {
    interval: {
      id: comp.id,
      start: comp.centreDistance - reach,
      end: comp.centreDistance + reach,
      gap: set.join.gapMm,
      kind: 'inline',
      join: set.join,
    },
    leg: comp.leg,
    before: up.flange,
    after: downFlange,
    dnOut: dn,
    build: (origin, u) => {
      const centre = at(origin, u, comp.centreDistance);
      const faces: readonly [Vec3, Vec3] = [at(centre, u, -g / 2), at(centre, u, g / 2)];
      const upstream = flangeParts(run.id, up, set, face, faces[1], scale3(u, -1), pipe.od, false);
      // The downstream set's gasket and bolts are the upstream ones: the joint has one of each.
      const downstream = flangeParts(run.id, { ...up, flange: downFlange }, set, face, faces[0], u, pipe.od, true).filter(
        (part) => part.id === downFlange,
      );
      const parts = [...upstream, ...downstream];
      const inline: DerivedInline = {
        id: comp.id,
        type: comp.type,
        ...(comp.tag === undefined ? {} : { tag: comp.tag }),
        leg: comp.leg,
        centreDistance: comp.centreDistance,
        dn,
        lengthMm: g,
        centre,
        faces,
        partIds: parts.map((part) => part.id),
        valvePartId: up.flange,
        stemHeightMm: null,
      };
      return {
        parts,
        joints: [
          {
            kind: lookup.connection('FL', 'FL')?.joint ?? 'flanged',
            parts: [up.flange, downFlange],
            position: centre,
            gapMm: g,
            accessories: [up.gasket, up.bolts],
          },
        ],
        inline,
      };
    },
  };
}

/** The row an instrument part is listed under: not a catalogue row, so it is never verified (`type` is nominal: the part's `typeKey` is `instrument`). */
const instrumentRow = (env: Env, dn: number, end: EndType, length: number): CatalogueRow => ({
  key: `${env.lookup.id}/INSTRUMENT/${dn}`,
  type: 'union',
  dn,
  ends: [end],
  dims: { faceToFace: length },
  unverified: true,
  source: 'instrument: the face-to-face length and end type are stored with the component (project data, not a spec row)',
});

/**
 * The slot of an instrument of run size `dn`, `comp.lengthMm` long face to face, flanged (`endType` FL, the default) or butt welded (BW).
 * @failure no positive `lengthMm` -> RTE_SIZE_MISMATCH; flanged: see flangedJointSlot; butt weld: the BW-BW rule is missing
 */
export function instrumentSlot(env: Env, comp: InlineComponent, dn: number, mint: Mint): Slot | DerivationFailure {
  const { lookup, run } = env;
  const length = comp.lengthMm;
  if (length === undefined || !(length > 0))
    return fail(
      'RTE_SIZE_MISMATCH',
      `instrument ${comp.id} needs a positive lengthMm (its face-to-face length)`,
      [comp.id],
      ['inline.lengthMm'],
    );
  const pipe = env.pipeAt(dn);
  if (isFailure(pipe)) return pipe;
  const end: EndType = comp.endType ?? 'FL';
  const row = instrumentRow(env, dn, end, length);
  let set: FlangeSet | null = null;
  let join;
  if (end === 'FL') {
    if (lookup.connection('FL', 'FL') === null) return connectionMissing(env, comp);
    const resolved = resolveFlangeSet(lookup, {}, dn, pipe.row.pipeEnd ?? 'BW');
    if ('code' in resolved) return fail(resolved.code, resolved.message, [...resolved.ids, comp.id], ['inline'], resolved.detail);
    set = resolved;
    join = resolved.join;
  } else {
    const welded = joinOf(env, end, dn, {}, row.key, [comp.id], ['inline']);
    if (isFailure(welded)) return welded;
    join = welded;
  }
  const face: FlangeFace =
    set === null
      ? {}
      : {
          ...(set.flange.rating === undefined ? {} : { rating: set.flange.rating }),
          ...(set.flange.facing === undefined ? {} : { facing: set.flange.facing }),
        };
  const up = set === null ? null : mintSet(mint);
  const bodyId = mint('inline');
  const down = set === null ? null : mintSet(mint);
  const reach = length / 2 + (set === null ? 0 : set.length);
  return {
    interval: { id: comp.id, start: comp.centreDistance - reach, end: comp.centreDistance + reach, gap: join.gapMm, kind: 'inline', join },
    leg: comp.leg,
    before: up?.flange ?? bodyId,
    after: down?.flange ?? bodyId,
    dnOut: dn,
    build: (origin, u) => {
      const centre = at(origin, u, comp.centreDistance);
      const faces: readonly [Vec3, Vec3] = [at(centre, u, -length / 2), at(centre, u, length / 2)];
      const port = (position: Vec3, direction: Vec3): PartPort => ({ position, direction, dn, endType: end, ...face });
      const body = partOf(run.id, bodyId, 'inline', row, [port(faces[0], scale3(u, -1)), port(faces[1], u)], {
        centre,
        componentId: comp.id,
        typeKey: INSTRUMENT,
        ...(comp.tag === undefined ? {} : { tag: comp.tag }),
        dims: { ...row.dims, outsideDiameter: pipe.od },
      });
      const sets =
        set === null || up === null || down === null
          ? []
          : [
              ...flangeParts(run.id, up, set, face, faces[0], scale3(u, -1), pipe.od, false),
              body,
              ...flangeParts(run.id, down, set, face, faces[1], u, pipe.od, true),
            ];
      const parts = sets.length === 0 ? [body] : sets;
      const inline: DerivedInline = {
        id: comp.id,
        type: comp.type,
        ...(comp.tag === undefined ? {} : { tag: comp.tag }),
        leg: comp.leg,
        centreDistance: comp.centreDistance,
        dn,
        lengthMm: length,
        centre,
        faces,
        partIds: parts.map((part) => part.id),
        valvePartId: bodyId,
        stemHeightMm: null,
      };
      const rule = lookup.connection('FL', 'FL')?.joint ?? 'flanged';
      const flanged = (
        ids: NonNullable<typeof up>,
        pair: readonly [string, string],
        position: Vec3,
      ): ReturnType<Slot['build']>['joints'][number] => ({
        kind: rule,
        parts: pair,
        position,
        gapMm: set === null ? 0 : set.gasketThickness,
        accessories: [ids.gasket, ids.bolts],
      });
      return {
        parts,
        joints:
          up === null || down === null ? [] : [flanged(up, [up.flange, bodyId], faces[0]), flanged(down, [bodyId, down.flange], faces[1])],
        inline,
      };
    },
  };
}
