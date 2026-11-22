/**
 * Spectacle (figure-8) blind (plant 01 PSC / 02 RTE, 05 ISO): a plate with a solid disc, an open ring and a web between them, held between two flanges. The row comes
 * ONLY from the spec's catalogues (a user-imported `spectacleBlind` family; the bundled catalogue has none): `thickness`, `discDiameterClosed`, `discDiameterOpen`,
 * `webLength` and, when the plate has one, `handleLength`. The state (`open` = the ring is in the line, `closed` = the solid disc is) is stored with the component or run end.
 * - inline: flange - gasket - plate - gasket - flange, one bolt set; occupies `plate + 2 x gasket + 2 x hub` of the leg centred on the component.
 * - run end: flange set + the plate against its gasket, the run end point is the outer face of the plate (as a blind flange).
 * @invariant pure; no dimension is invented: a row without a positive thickness / diameters / web length is refused by name
 * @failure no spectacleBlind row in the spec -> RTE_SPEC_NO_COMPONENT; a row lacking a dimension -> RTE_SPEC_NO_COMPONENT naming it; no FL-FL rule -> RTE_NO_CONNECTION_RULE
 */

import type { Vec3 } from '@core/model/vectors';
import type { InlineComponent, PartPort } from '@aec/plant/types';
import { scale3 } from '@lib/vec3';
import { fail, isFailure, type DerivationFailure, type DerivedInline } from './deriveTypes';
import { resolveFlangeSet, type FlangeFace, type FlangeSet } from './flangeSet';
import { flangeParts, mintSet } from './routeEnds';
import { at, partOf, type Env, type Mint, type Slot } from './routeEnv';
import { SPECTACLE_BLIND, spectacleRow, type SpectacleState } from './spectacleRow';

const faceOf = (set: FlangeSet): FlangeFace => ({
  ...(set.flange.rating === undefined ? {} : { rating: set.flange.rating }),
  ...(set.flange.facing === undefined ? {} : { facing: set.flange.facing }),
});

/**
 * The slot of a spectacle blind of run size `dn` between two flanges: flange A, gasket, plate, gasket, flange B.
 * @failure see the module comment
 */
export function spectacleSlot(env: Env, comp: InlineComponent, dn: number, mint: Mint): Slot | DerivationFailure {
  const { lookup, run } = env;
  if (lookup.connection('FL', 'FL') === null)
    return fail(
      'RTE_NO_CONNECTION_RULE',
      `spec ${lookup.id} has no FL-FL connection rule for ${comp.type} ${comp.id}`,
      [comp.id],
      ['inline'],
      { endType: 'FL' },
    );
  const pipe = env.pipeAt(dn);
  if (isFailure(pipe)) return pipe;
  const resolved = resolveFlangeSet(lookup, {}, dn, pipe.row.pipeEnd ?? 'BW');
  if ('code' in resolved) return fail(resolved.code, resolved.message, [...resolved.ids, comp.id], ['inline'], resolved.detail);
  const set = resolved;
  const row = spectacleRow(env, dn, set, [comp.id], ['inline']);
  if (isFailure(row)) return row;
  const state: SpectacleState = comp.state ?? 'closed';
  const [t, g] = [row.dims['thickness'] as number, set.gasketThickness];
  const face = faceOf(set);
  const up = mintSet(mint);
  const plateId = mint('inline');
  const downGasket = mint('gasket');
  const downFlange = mint('flange');
  const reach = t / 2 + g + set.hub;
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
      const faces: readonly [Vec3, Vec3] = [at(centre, u, -t / 2), at(centre, u, t / 2)];
      const port = (position: Vec3, direction: Vec3): PartPort => ({ position, direction, dn, endType: 'FL' as const, ...face });
      const plate = partOf(run.id, plateId, 'inline', row, [port(faces[0], scale3(u, -1)), port(faces[1], u)], {
        centre,
        componentId: comp.id,
        typeKey: SPECTACLE_BLIND,
        state,
        ...(comp.tag === undefined ? {} : { tag: comp.tag }),
        dims: { ...row.dims, outsideDiameter: pipe.od },
      });
      const upstream = flangeParts(run.id, up, set, face, faces[0], scale3(u, -1), pipe.od, false);
      const downstream = flangeParts(
        run.id,
        { ...up, gasket: downGasket, flange: downFlange },
        set,
        face,
        faces[1],
        u,
        pipe.od,
        true,
      ).filter((part) => part.id !== up.bolts);
      const parts = [...upstream, plate, ...downstream];
      const inline: DerivedInline = {
        id: comp.id,
        type: comp.type,
        ...(comp.tag === undefined ? {} : { tag: comp.tag }),
        leg: comp.leg,
        centreDistance: comp.centreDistance,
        dn,
        lengthMm: t + 2 * g,
        centre,
        faces,
        partIds: parts.map((part) => part.id),
        valvePartId: plateId,
        stemHeightMm: null,
        state,
      };
      return {
        parts,
        joints: [
          {
            kind: lookup.connection('FL', 'FL')?.joint ?? 'flanged',
            parts: [up.flange, downFlange],
            position: centre,
            gapMm: t + 2 * g,
            accessories: [up.gasket, up.bolts, downGasket, plateId],
          },
        ],
        inline,
      };
    },
  };
}
