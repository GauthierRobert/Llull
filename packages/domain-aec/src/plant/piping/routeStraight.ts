/**
 * Straight inline fittings (02 RTE §5.3, CAT-FU): couplings and unions placed in a leg. The part occupies the row `length` of the spec's catalogue row and
 * joins the pipe on both sides by the spec's connection rule for its end type (socket weld, threaded or butt weld). Nothing is guessed: a row without
 * `length` is a refusal. The size does not change, so no `dn2`.
 * @invariant pure; the part is a generic `inline` part (no PCF component, no IFC type: the exports skip it by their own rule)
 */

import type { Vec3 } from '@core/model/vectors';
import type { PartPort } from '@aec/plant/types';
import { scale3 } from '@lib/vec3';
import type { ComponentType } from '../catalog/types';
import { fittingEnd } from './connections';
import { fail, isFailure, type DerivationFailure, type DerivedInline } from './deriveTypes';
import { at, joinOf, partOf, type Env, type Mint, type Slot } from './routeEnv';
import { isMiss } from './specLookup';
import type { InlineComponent } from '@aec/plant/types';

/** Catalogue types placed as one straight part of the leg. */
export const STRAIGHT_TYPES = ['coupling', 'union'] as const satisfies readonly ComponentType[];
export const isStraight = (component: Pick<InlineComponent, 'type'>): boolean =>
  (STRAIGHT_TYPES as readonly string[]).includes(component.type);

/**
 * The slot of a coupling or union of run size `dn`.
 * @failure no spec row -> its miss; no `length` -> RTE_SPEC_NO_COMPONENT; no connection rule for the end -> RTE_NO_CONNECTION_RULE
 */
export function straightSlot(env: Env, comp: InlineComponent, dn: number, mint: Mint): Slot | DerivationFailure {
  const { lookup, run } = env;
  const row = lookup.component({ types: [comp.type as ComponentType], dn });
  if (isMiss(row)) return fail(row.miss, row.detail, [...row.ids, comp.id], ['inline'], { dn });
  const length = row.dims['length'];
  if (length === undefined || !(length > 0))
    return fail(
      'RTE_SPEC_NO_COMPONENT',
      `${comp.type} row ${row.key} has no length dimension (${row.source})`,
      [comp.id, row.key],
      ['inline'],
    );
  const pipe = env.pipeAt(dn);
  if (isFailure(pipe)) return pipe;
  const end = fittingEnd(row);
  const join = joinOf(env, end, dn, row.dims, row.key, [comp.id, row.key], ['inline']);
  if (isFailure(join)) return join;
  const id = mint('inline');
  const reach = length / 2;
  const port = (position: Vec3, towards: Vec3): PartPort => ({ position, direction: towards, dn, endType: end });
  return {
    interval: { id: comp.id, start: comp.centreDistance - reach, end: comp.centreDistance + reach, gap: join.gapMm, kind: 'inline', join },
    leg: comp.leg,
    before: id,
    after: id,
    dnOut: dn,
    build: (origin, u) => {
      const centre = at(origin, u, comp.centreDistance);
      const faces: readonly [Vec3, Vec3] = [at(centre, u, -reach), at(centre, u, reach)];
      const part = partOf(run.id, id, 'inline', row, [port(faces[0], scale3(u, -1)), port(faces[1], u)], {
        centre,
        componentId: comp.id,
        dn,
        ...(comp.tag === undefined ? {} : { tag: comp.tag }),
        dims: { ...row.dims, outsideDiameter: pipe.od },
      });
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
        partIds: [id],
        valvePartId: id,
        stemHeightMm: null,
      };
      return { parts: [part], joints: [], inline };
    },
  };
}
