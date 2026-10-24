/**
 * Flange set at a flanged (FL) port (02 RTE §5.4): the routed side gets a weld-neck flange, a gasket and a bolt set from the spec; the port's
 * rating and facing must equal the flange's. The set occupies `gasket thickness + length through hub` of the leg next to the port.
 */

import type { PortSpec } from '@aec/plant/types';
import { isMiss, type CatalogueRow, type SpecLookup, type SpecMiss } from './specLookup';

/** The part of a port a mating flange depends on: rating and facing. */
export type FlangeFace = Pick<PortSpec, 'rating' | 'facing'>;

export interface FlangeSet {
  readonly flange: CatalogueRow;
  readonly gasket: CatalogueRow;
  readonly bolts: CatalogueRow;
  /** Length through hub Y of the weld-neck flange, mm. */
  readonly hub: number;
  readonly gasketThickness: number;
  readonly studs: number;
  /** Gasket + hub: where the pipe starts, measured from the port face. */
  readonly length: number;
  /** Where the stud count came from (named when it is the flange's bolt count, not a bolt-set row). */
  readonly studSource: string;
}

export interface FlangeSetFailure {
  readonly code: 'RTE_RATING_MISMATCH' | 'RTE_FACING_MISMATCH' | SpecMiss['miss'];
  readonly message: string;
  readonly ids: readonly string[];
  readonly paths: readonly string[];
  readonly detail?: Readonly<Record<string, unknown>>;
}

const GASKET_TYPES = ['gasketSpiralWound', 'gasketSheet', 'gasketRing'] as const;
const normal = (text: string | undefined): string => (text ?? '').replace(/\s+/g, '').toUpperCase();

const noComponent = (message: string, ids: readonly string[] = []): FlangeSetFailure => ({
  code: 'RTE_SPEC_NO_COMPONENT',
  message,
  ids,
  paths: [],
});

/**
 * The mating weld-neck flange of `port`. A spec that offers the size only at another rating / facing is a mismatch, not a missing part.
 * @failure rating / facing differ -> RTE_RATING_MISMATCH / RTE_FACING_MISMATCH; no row -> the lookup's miss code
 */
function matingFlange(lookup: SpecLookup, port: FlangeFace, dn: number): CatalogueRow | FlangeSetFailure {
  const filtered = lookup.component({ types: ['flangeWeldNeck'], dn, rating: port.rating, facing: port.facing });
  const candidate = isMiss(filtered) ? lookup.component({ types: ['flangeWeldNeck'], dn }) : filtered;
  if (isMiss(candidate)) return { code: candidate.miss, message: candidate.detail, ids: candidate.ids, paths: candidate.paths };
  if (port.rating !== undefined && candidate.rating !== undefined && normal(port.rating) !== normal(candidate.rating))
    return {
      code: 'RTE_RATING_MISMATCH',
      message: `the port is ${port.rating} but spec ${lookup.id} flanges DN${dn} are ${candidate.rating} (${candidate.key})`,
      ids: [candidate.key],
      paths: [],
      detail: { portRating: port.rating, specRating: candidate.rating },
    };
  if (port.facing !== undefined && candidate.facing !== undefined && port.facing !== candidate.facing)
    return {
      code: 'RTE_FACING_MISMATCH',
      message: `the port faces ${port.facing} but spec ${lookup.id} flanges DN${dn} are ${candidate.facing} (${candidate.key})`,
      ids: [candidate.key],
      paths: [],
      detail: { portFacing: port.facing, specFacing: candidate.facing },
    };
  return isMiss(filtered) ? { code: filtered.miss, message: filtered.detail, ids: filtered.ids, paths: filtered.paths } : filtered;
}

/**
 * Weld-neck flange + gasket + bolt set for a port.
 * @failure see matingFlange; a row without lengthThroughHub / gasket thickness / stud count -> RTE_SPEC_NO_COMPONENT naming the dimension
 */
export function resolveFlangeSet(lookup: SpecLookup, port: FlangeFace, dn: number): FlangeSet | FlangeSetFailure {
  const flange = matingFlange(lookup, port, dn);
  if ('code' in flange) return flange;
  const hub = flange.dims['lengthThroughHub'];
  if (hub === undefined || !(hub > 0))
    return noComponent(
      `flange row ${flange.key} has no lengthThroughHub (Y): the flange set cannot be cut back; import a catalogue row with it (${flange.source})`,
      [flange.key],
    );
  const rating = port.rating ?? flange.rating;
  const gasket = lookup.component({ types: GASKET_TYPES, dn, rating });
  if (isMiss(gasket)) return { code: gasket.miss, message: gasket.detail, ids: gasket.ids, paths: gasket.paths };
  const gasketThickness = gasket.dims['thickness'];
  if (gasketThickness === undefined || !(gasketThickness > 0))
    return noComponent(`gasket row ${gasket.key} has no thickness: import a catalogue row with it (${gasket.source})`, [gasket.key]);
  const bolts = lookup.component({ types: ['boltSet'], dn, rating, facing: port.facing ?? flange.facing });
  if (isMiss(bolts)) return { code: bolts.miss, message: bolts.detail, ids: bolts.ids, paths: bolts.paths };
  const studs = bolts.dims['boltCount'] ?? flange.dims['boltCount'];
  if (studs === undefined || !(studs > 0))
    return noComponent(`neither bolt set ${bolts.key} nor flange ${flange.key} gives a stud count (boltCount)`, [bolts.key]);
  return {
    flange,
    gasket,
    bolts,
    hub,
    gasketThickness,
    studs,
    length: gasketThickness + hub,
    studSource: bolts.dims['boltCount'] === undefined ? `flange row ${flange.key} boltCount` : `bolt set ${bolts.key}`,
  };
}
