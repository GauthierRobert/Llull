/** The `nurbs_surface` branch of inspect_nurbs: exact definition, domain, continuity classes and bounds of a sheet. */

import type { CadDocument, NurbsSurfaceEntity } from '../../model/types';
import type { CommandResult } from '../types';
import { report } from '../noop';
import { surfaceDomain } from '../../lib/nurbs/surface';
import { surfacePoleExtent } from '../../geometry/nurbsSurface';
import { sig, sigVec } from './surfaceShared';

const interior = (knots: ReadonlyArray<number>, multiplicities: ReadonlyArray<number>, degree: number): unknown[] =>
  knots.slice(1, -1).map((knot, index) => {
    const multiplicity = multiplicities[index + 1] as number;
    return { knot, multiplicity, continuity: `C${degree - multiplicity}` };
  });

/**
 * @affects none; data = { id, type: 'nurbs_surface', degreeU, degreeV, poleCount, rational, domain, knotsU, multiplicitiesU, knotsV, multiplicitiesV, interiorContinuity, bounds, unit }
 */
export function inspectSurface(doc: CadDocument, entity: NurbsSurfaceEntity): CommandResult {
  const { surface } = entity;
  const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
  const extent = surfacePoleExtent(surface);
  const poleCount = [surface.poles.length, surface.poles[0]?.length ?? 0] as const;
  const data = {
    id: entity.id,
    type: 'nurbs_surface',
    degreeU: surface.degreeU,
    degreeV: surface.degreeV,
    poleCount,
    rational: surface.weights !== undefined,
    domain: { u: [u0, u1], v: [v0, v1] },
    knotsU: surface.knotsU,
    multiplicitiesU: surface.multiplicitiesU,
    knotsV: surface.knotsV,
    multiplicitiesV: surface.multiplicitiesV,
    interiorContinuity: {
      u: interior(surface.knotsU, surface.multiplicitiesU, surface.degreeU),
      v: interior(surface.knotsV, surface.multiplicitiesV, surface.degreeV),
    },
    bounds: { min: sigVec(extent.min), max: sigVec(extent.max), frame: 'entity-local pole box (add the entity position)' },
    unit: doc.units,
    unverified: false,
    provenance: { method: 'exact definition read from the entity', reference: 'Piegl & Tiller, The NURBS Book', inputs: { id: entity.id } },
  };
  return report(
    doc,
    `inspect_nurbs ${entity.id}: surface ${surface.degreeU}x${surface.degreeV}, ${poleCount[0]} x ${poleCount[1]} poles, ${data.rational ? 'rational' : 'non-rational'}, ` +
      `domain u [${sig(u0)}, ${sig(u1)}] v [${sig(v0)}, ${sig(v1)}].`,
    data,
  );
}
