/**
 * Inline components (02 RTE §5.3, §5.4): flanged or welded valves and concentric reducers placed in a leg. A flanged valve pulls in a flange set
 * (weld-neck flange, gasket, bolt set) on each face and occupies `face-to-face + 2 x (gasket + hub)` of the leg; a reducer occupies its end-to-end
 * length and changes the run size from its centre on. Every dimension comes from the spec's catalogue row.
 */

import type { Vec3 } from '@core/model/vectors';
import type { EndType, InlineComponent, Joint, PartPort } from '@aec/plant/types';
import { dot3, scale3, sub3 } from '@lib/vec3';
import type { ComponentType } from '../catalog/types';
import { fittingEnd, type Join } from './connections';
import { fail, isFailure, type DerivationFailure, type DerivedInline } from './deriveTypes';
import { resolveFlangeSet, type FlangeFace, type FlangeSet } from './flangeSet';
import { unitVector } from './legs';
import { flangeParts, mintSet, type FlangeSetIds } from './routeEnds';
import { at, joinOf, partOf, type Env, type Mint, type Slot } from './routeEnv';
import { inlineInOrder, isReducer, isValve, startDn } from './runSizes';
import { isMiss } from './specLookup';

/** Catalogue types `insert_inline_component` accepts (eccentric reducers, strainers and the like come with 02 V1). */
export const INLINE_TYPES = [
  'valveGate',
  'valveGlobe',
  'valveCheck',
  'valveBall',
  'valveButterfly',
  'valvePlug',
  'reducerConcentric',
] as const satisfies readonly ComponentType[];

/** Unit stem direction used when none is given: perpendicular to the pipe, up (+Z), or +X on a vertical pipe. */
export function defaultStem(direction: Vec3): Vec3 {
  const up: Vec3 = Math.abs(direction[2]) < 0.999 ? [0, 0, 1] : [1, 0, 0];
  return unitVector(sub3(up, scale3(direction, dot3(up, direction))));
}

const noComponent = (message: string, comp: InlineComponent, ids: readonly string[] = []): DerivationFailure =>
  fail('RTE_SPEC_NO_COMPONENT', message, [comp.id, ...ids], ['inline']);

interface Located {
  readonly comp: InlineComponent;
  readonly dnIn: number;
  readonly dnOut: number;
}

function valveSlot(env: Env, { comp, dnIn }: Located, mint: Mint): Slot | DerivationFailure {
  const { lookup, run } = env;
  const row = lookup.component({ types: [comp.type as ComponentType], dn: dnIn });
  if (isMiss(row)) return fail(row.miss, row.detail, [...row.ids, comp.id], ['inline']);
  const length = row.dims['faceToFace'];
  if (length === undefined || !(length > 0))
    return noComponent(`valve row ${row.key} has no faceToFace dimension (${row.source})`, comp, [row.key]);
  const pipe = env.pipeAt(dnIn);
  if (isFailure(pipe)) return pipe;
  const flanged = row.ends.includes('FL');
  const end: EndType = flanged ? 'FL' : row.ends.includes('BW') ? 'BW' : (row.ends[0] ?? 'BW');
  if (flanged && lookup.connection('FL', 'FL') === null)
    return fail(
      'RTE_NO_CONNECTION_RULE',
      `spec ${lookup.id} has no FL-FL connection rule for valve ${comp.id} (${row.key})`,
      [comp.id],
      ['inline'],
      { endType: end },
    );
  const face: FlangeFace = {
    ...(row.rating === undefined ? {} : { rating: row.rating }),
    ...(row.facing === undefined ? {} : { facing: row.facing }),
  };
  let set: FlangeSet | null = null;
  let join: Join;
  if (flanged) {
    const resolved = resolveFlangeSet(lookup, face, dnIn, pipe.row.pipeEnd ?? 'BW');
    if ('code' in resolved) return fail(resolved.code, resolved.message, [...resolved.ids, comp.id], ['inline'], resolved.detail);
    set = resolved;
    join = resolved.join;
  } else {
    const welded = joinOf(env, end, dnIn, row.dims, row.key, [comp.id, row.key], ['inline']);
    if (isFailure(welded)) return welded;
    join = welded;
  }
  const up = set === null ? null : mintSet(mint);
  const valveId = mint('valve');
  const down = set === null ? null : mintSet(mint);
  const reach = length / 2 + (set?.length ?? 0);
  return {
    interval: { id: comp.id, start: comp.centreDistance - reach, end: comp.centreDistance + reach, gap: join.gapMm, kind: 'inline', join },
    leg: comp.leg,
    before: up?.flange ?? valveId,
    after: down?.flange ?? valveId,
    dnOut: dnIn,
    build: (origin, u) => {
      const centre = at(origin, u, comp.centreDistance);
      const faces: readonly [Vec3, Vec3] = [at(centre, u, -length / 2), at(centre, u, length / 2)];
      const port = (position: Vec3, direction: Vec3): PartPort => ({ position, direction, dn: dnIn, endType: end, ...face });
      const stem =
        comp.stemDirection !== undefined && Math.hypot(...comp.stemDirection) > 0 ? unitVector(comp.stemDirection) : defaultStem(u);
      const valve = partOf(run.id, valveId, 'valve', row, [port(faces[0], scale3(u, -1)), port(faces[1], u)], {
        centre,
        componentId: comp.id,
        stemDirection: stem,
        ...(comp.tag === undefined ? {} : { tag: comp.tag }),
        dims: { ...row.dims, outsideDiameter: pipe.od },
      });
      const sets =
        set === null || up === null || down === null
          ? null
          : {
              before: flangeParts(run.id, up, set, face, faces[0], scale3(u, -1), pipe.od, false),
              after: flangeParts(run.id, down, set, face, faces[1], u, pipe.od, true),
            };
      const joint = (flange: FlangeSetIds, parts: readonly [string, string], position: Vec3): Omit<Joint, 'id'> => ({
        kind: lookup.connection('FL', 'FL')?.joint ?? 'flanged',
        parts,
        position,
        gapMm: set?.gasketThickness ?? 0,
        accessories: [flange.gasket, flange.bolts],
      });
      const parts = sets === null ? [valve] : [...sets.before, valve, ...sets.after];
      const inline: DerivedInline = {
        id: comp.id,
        type: comp.type,
        ...(comp.tag === undefined ? {} : { tag: comp.tag }),
        leg: comp.leg,
        centreDistance: comp.centreDistance,
        dn: dnIn,
        lengthMm: length,
        centre,
        faces,
        partIds: parts.map((part) => part.id),
        valvePartId: valveId,
        stemDirection: stem,
        stemHeightMm: row.dims['stemHeight'] ?? null,
      };
      return {
        parts,
        joints:
          up === null || down === null ? [] : [joint(up, [up.flange, valveId], faces[0]), joint(down, [valveId, down.flange], faces[1])],
        inline,
      };
    },
  };
}

function reducerSlot(env: Env, { comp, dnIn, dnOut }: Located, mint: Mint): Slot | DerivationFailure {
  const { lookup, run } = env;
  if (comp.dn2 === undefined || comp.dn2 === dnIn)
    return fail(
      'RTE_SIZE_MISMATCH',
      `reducer ${comp.id} needs an outlet size dn2 different from the run size DN${dnIn}`,
      [comp.id],
      ['inline.dn2'],
    );
  const row = lookup.component({ types: ['reducerConcentric'], dn: Math.max(dnIn, dnOut), dn2: Math.min(dnIn, dnOut) });
  if (isMiss(row)) return fail(row.miss, row.detail, [...row.ids, comp.id], ['inline'], { dn: dnIn, dn2: dnOut });
  const length = row.dims['length'];
  if (length === undefined || !(length > 0))
    return noComponent(`reducer row ${row.key} has no length dimension (${row.source})`, comp, [row.key]);
  const [pipeIn, pipeOut] = [env.pipeAt(dnIn), env.pipeAt(dnOut)];
  if (isFailure(pipeIn)) return pipeIn;
  if (isFailure(pipeOut)) return pipeOut;
  const end = fittingEnd(row);
  const [joinIn, joinOut] = [
    joinOf(env, end, dnIn, row.dims, row.key, [comp.id, row.key], ['inline']),
    joinOf(env, end, dnOut, row.dims, row.key, [comp.id, row.key], ['inline']),
  ];
  if (isFailure(joinIn)) return joinIn;
  if (isFailure(joinOut)) return joinOut;
  if (joinIn.joint !== joinOut.joint || joinIn.gapMm !== joinOut.gapMm)
    return fail(
      'RTE_NO_CONNECTION_RULE',
      `reducer ${comp.id} (${row.key}) would join the DN${dnIn} pipe by ${joinIn.joint} and the DN${dnOut} pipe by ${joinOut.joint}: both sizes of the spec's pipe must take the same joint`,
      [comp.id, row.key],
      ['inline'],
    );
  const id = mint('reducer');
  const reach = length / 2;
  const port = (position: Vec3, direction: Vec3, dn: number): PartPort => ({ position, direction, dn, endType: end });
  return {
    interval: {
      id: comp.id,
      start: comp.centreDistance - reach,
      end: comp.centreDistance + reach,
      gap: joinIn.gapMm,
      kind: 'inline',
      join: joinIn,
    },
    leg: comp.leg,
    before: id,
    after: id,
    dnOut,
    build: (origin, u) => {
      const centre = at(origin, u, comp.centreDistance);
      const faces: readonly [Vec3, Vec3] = [at(centre, u, -reach), at(centre, u, reach)];
      const part = partOf(run.id, id, 'reducer', row, [port(faces[0], scale3(u, -1), dnIn), port(faces[1], u, dnOut)], {
        centre,
        componentId: comp.id,
        dn: dnIn,
        dn2: dnOut,
        ...(comp.tag === undefined ? {} : { tag: comp.tag }),
        dims: { ...row.dims, outsideDiameter: pipeIn.od, outsideDiameterOut: pipeOut.od },
      });
      const inline: DerivedInline = {
        id: comp.id,
        type: comp.type,
        ...(comp.tag === undefined ? {} : { tag: comp.tag }),
        leg: comp.leg,
        centreDistance: comp.centreDistance,
        dn: dnIn,
        dn2: dnOut,
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

/**
 * The slot of every inline component of the run, in route order; `legLengths` bound the centre distances.
 * @failure leg or centre outside the run -> RTE_INLINE_DOES_NOT_FIT; type not placeable -> RTE_SPEC_NO_COMPONENT; no spec row / dimension /
 *   connection rule, reducer size problems -> that code
 */
export function layoutInline(env: Env, legLengths: readonly number[], mint: Mint): Slot[] | DerivationFailure {
  const slots: Slot[] = [];
  let dn = startDn(env.run, env.line.dn);
  for (const comp of inlineInOrder(env.run)) {
    const length = legLengths[comp.leg];
    if (length === undefined || !(comp.centreDistance > 0) || !(comp.centreDistance < length))
      return fail(
        'RTE_INLINE_DOES_NOT_FIT',
        `${comp.type} ${comp.id} sits ${comp.centreDistance} mm along leg ${comp.leg}, which is not inside the run (${length === undefined ? 'no such leg' : `leg length ${+length.toFixed(4)} mm`})`,
        [comp.id, env.run.id],
        ['inline'],
        { leg: comp.leg, centreDistance: comp.centreDistance },
      );
    const located: Located = { comp, dnIn: dn, dnOut: isReducer(comp) && comp.dn2 !== undefined ? comp.dn2 : dn };
    const slot = isValve(comp) ? valveSlot(env, located, mint) : isReducer(comp) ? reducerSlot(env, located, mint) : null;
    if (slot === null)
      return noComponent(`${comp.type} cannot be placed inline (valves and concentric reducers: ${INLINE_TYPES.join(', ')})`, comp);
    if (isFailure(slot)) return slot;
    slots.push(slot);
    dn = located.dnOut;
  }
  return slots;
}
