/**
 * PmiItem <-> AP242 transport mapping (03 GDT TECHNICAL_SPEC §6.1, M6): the pure translation between the 03 model and the neutral `ExchangePmi`
 * vocabulary of the 04 XCH transport (XCAF DimTol on faces). Faces are 0-based `TopExp::MapShapes` indices of one product shape.
 * @invariant a written dimension carries the nominal MEASURED from the B-rep and deviations as magnitudes (nominal - minus <= x <= nominal + plus);
 *   a read tolerance with no deviation is basic; limits and fits come back as plus / minus deviations (same semantics, not the same notation)
 * @failure an item the transport cannot represent is listed with its reason, never dropped silently
 */

import type { ExchangePmi } from '../../geometry/kernelExchange';
import type { GeometricCharacteristic, PmiFeature, PmiItem, PmiTolerance } from '../../model/pmi';
import type { Vec3 } from '../../model/types';
import type { PmiDraft } from './applySet';

type Characteristic = ExchangePmi['tolerances'][number]['characteristic'];
type DimensionType = ExchangePmi['dimensions'][number]['type'];

const TO_TRANSPORT: Readonly<Record<GeometricCharacteristic, Characteristic>> = {
  straightness: 'straightness',
  flatness: 'flatness',
  roundness: 'circularity',
  cylindricity: 'cylindricity',
  profile_line: 'profile_line',
  profile_surface: 'profile_surface',
  angularity: 'angularity',
  perpendicularity: 'perpendicularity',
  parallelism: 'parallelism',
  position: 'position',
  concentricity: 'concentricity',
  coaxiality: 'coaxiality',
  symmetry: 'symmetry',
  circular_runout: 'circular_runout',
  total_runout: 'total_runout',
};

const FROM_TRANSPORT: Readonly<Record<Characteristic, GeometricCharacteristic>> = Object.fromEntries(
  Object.entries(TO_TRANSPORT).map(([model, transport]) => [transport, model]),
) as Record<Characteristic, GeometricCharacteristic>;

const SIZE_TO_TRANSPORT = {
  diameter: 'size_diameter',
  radius: 'size_radius',
  width: 'size_thickness',
  spherical_diameter: 'size_spherical_diameter',
} as const satisfies Record<string, DimensionType>;

const SIZE_FROM_TRANSPORT: Readonly<Partial<Record<DimensionType, keyof typeof SIZE_TO_TRANSPORT>>> = {
  size_diameter: 'diameter',
  size_radius: 'radius',
  size_thickness: 'width',
  size_spherical_diameter: 'spherical_diameter',
};

/** Deviations of `tolerance` around `nominal` as the transport magnitudes; null = basic (no tolerance). */
function deviations(tolerance: PmiTolerance, nominal: number): { plus: number; minus: number } | null {
  if (tolerance.type === 'basic') return null;
  if (tolerance.type === 'limits') return { plus: tolerance.upper - nominal, minus: nominal - tolerance.lower };
  return { plus: tolerance.upper, minus: -tolerance.lower };
}

const toleranceOf = (deviation: { plus: number; minus: number } | undefined): PmiTolerance =>
  deviation === undefined || (deviation.plus === 0 && deviation.minus === 0)
    ? { type: 'basic' }
    : { type: 'plusMinus', upper: deviation.plus, lower: -deviation.minus };

export interface ExportedPmi {
  /** Null when no item could be written. */
  readonly pmi: ExchangePmi | null;
  /** Ids written. */
  readonly written: readonly string[];
  /** Items the transport cannot carry, with the reason. */
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
  /** Written items that lose attributes the transport has no vocabulary for. */
  readonly lossy: readonly { readonly id: string; readonly lost: readonly string[] }[];
}

const mutable = (points: readonly Vec3[]): [number, number, number][] => points.map((p): [number, number, number] => [p[0], p[1], p[2]]);

/** The attributes of an item that the transport vocabulary drops. */
function lostAttributes(item: PmiItem): string[] {
  if (item.kind === 'size_dimension') return item.sizeModifiers === undefined || item.sizeModifiers.length === 0 ? [] : ['sizeModifiers'];
  if (item.kind !== 'geometric_tolerance') return [];
  const { zone } = item;
  return [
    ...(item.materialCondition === 'RFS' ? [] : ['materialCondition']),
    ...(item.modifiers.length === 0 ? [] : ['modifiers']),
    ...(zone.spherical === true ? ['zone.spherical'] : []),
    ...(zone.projectedLength === undefined ? [] : ['zone.projectedLength']),
    ...(zone.unequallyDisposed === undefined ? [] : ['zone.unequallyDisposed']),
    ...(zone.maxValue === undefined ? [] : ['zone.maxValue']),
    ...(item.datums.some((datum) => datum.boundary !== undefined) ? ['datum boundary'] : []),
    ...(item.compositeOf === undefined ? [] : ['compositeOf']),
  ];
}

/**
 * Transport PMI of the items attached to ONE solid; `facesOf` gives the 0-based kernel face indices of a feature (re-resolved by the caller).
 * Datum targets, surface texture and notes have no transport vocabulary (graphic / annotation PMI is V2) and are skipped.
 */
export function toExchangePmi(items: readonly PmiItem[], facesOf: (feature: PmiFeature) => readonly number[]): ExportedPmi {
  const skipped: { id: string; reason: string }[] = [];
  const lossy: { id: string; lost: readonly string[] }[] = [];
  const written: string[] = [];
  const datums: { label: string; faces: readonly number[] }[] = [];
  for (const item of items) {
    if (item.kind !== 'datum_feature') continue;
    const faces = facesOf(item.feature);
    if (faces.length === 0) skipped.push({ id: item.id, reason: 'the feature resolves to no face' });
    else {
      datums.push({ label: item.label, faces });
      written.push(item.id);
    }
  }
  const known = new Set(datums.map((datum) => datum.label));
  const tolerances: ExchangePmi['tolerances'][number][] = [];
  const dimensions: ExchangePmi['dimensions'][number][] = [];
  const byId = new Map(items.map((item) => [item.id, item] as const));
  const note = (item: PmiItem): void => {
    written.push(item.id);
    const lost = lostAttributes(item);
    if (lost.length > 0) lossy.push({ id: item.id, lost });
  };
  for (const item of items) {
    if (item.kind === 'geometric_tolerance') {
      const target =
        'feature' in item.target ? item.target.feature : (byId.get(item.target.pmiId) as { feature?: PmiFeature } | undefined)?.feature;
      const faces = target === undefined ? [] : facesOf(target);
      const unknown = item.datums.filter((datum) => !known.has(datum.label)).map((datum) => datum.label);
      if (faces.length === 0) skipped.push({ id: item.id, reason: 'the target resolves to no face' });
      else if (unknown.length > 0) skipped.push({ id: item.id, reason: `datum ${unknown.join(', ')} is not a written datum feature` });
      else {
        tolerances.push({
          characteristic: TO_TRANSPORT[item.characteristic],
          value: item.zone.value,
          diameterZone: item.zone.diametral === true,
          faces,
          datums: item.datums.map((datum) => datum.label),
        });
        note(item);
      }
    } else if (item.kind === 'size_dimension') {
      const faces = facesOf(item.feature);
      const measured = item.feature.ofSize?.measured;
      if (faces.length === 0 || measured === undefined) skipped.push({ id: item.id, reason: 'the feature resolves to no measured face' });
      else {
        const nominal = item.sizeKind === 'radius' ? measured / 2 : measured;
        const deviation = deviations(item.tolerance, nominal);
        dimensions.push({
          type: SIZE_TO_TRANSPORT[item.sizeKind],
          value: nominal,
          ...(deviation === null ? {} : { tolerance: deviation }),
          faces,
        });
        note(item);
      }
    } else if (item.kind === 'location_dimension') {
      const [from, to] = [facesOf(item.from), facesOf(item.to)];
      if (from.length === 0 || to.length === 0) skipped.push({ id: item.id, reason: 'a feature resolves to no face' });
      else {
        const deviation = deviations(item.tolerance, item.measured);
        dimensions.push({
          type: item.measure === 'angle' ? 'location_angular' : 'location_linear_distance',
          value: item.measured,
          ...(deviation === null ? {} : { tolerance: deviation }),
          faces: from,
          facesSecond: to,
        });
        note(item);
      }
    } else if (item.kind !== 'datum_feature') {
      skipped.push({ id: item.id, reason: `a ${item.kind.replace('_', ' ')} has no semantic AP242 transport form` });
    }
  }
  const empty = datums.length === 0 && tolerances.length === 0 && dimensions.length === 0;
  return { pmi: empty ? null : { datums, tolerances, dimensions }, written, skipped, lossy };
}

export interface ImportedPmiDrafts {
  /** Drafts in application order: datums, then frames, then dimensions. */
  readonly drafts: readonly PmiDraft[];
  /** Source items with no model form (unknown dimension type) or no mappable face. */
  readonly unmapped: number;
}

/**
 * `apply_pmi_set` drafts of one solid's transport PMI (document units); `pointsOf` maps face indices to one world point ON each face, null
 * when an index names no face of the solid (the item is then unmapped).
 */
export function fromExchangePmi(pmi: ExchangePmi, pointsOf: (faces: readonly number[]) => readonly Vec3[] | null): ImportedPmiDrafts {
  const drafts: PmiDraft[] = [];
  let unmapped = 0;
  for (const datum of pmi.datums) {
    const facesNear = pointsOf(datum.faces);
    if (facesNear === null || facesNear.length === 0) unmapped += 1;
    else drafts.push({ kind: 'datum_feature', label: datum.label, facesNear: mutable(facesNear) });
  }
  for (const tolerance of pmi.tolerances) {
    const facesNear = pointsOf(tolerance.faces);
    if (facesNear === null || facesNear.length === 0) unmapped += 1;
    else
      drafts.push({
        kind: 'geometric_tolerance',
        characteristic: FROM_TRANSPORT[tolerance.characteristic],
        zone: { value: tolerance.value, ...(tolerance.diameterZone ? { diametral: true } : {}) },
        datums: [...tolerance.datums],
        facesNear: mutable(facesNear),
      });
  }
  for (const dimension of pmi.dimensions) {
    const first = pointsOf(dimension.faces);
    const sizeKind = SIZE_FROM_TRANSPORT[dimension.type];
    if (sizeKind !== undefined) {
      if (first === null || first.length === 0) unmapped += 1;
      else
        drafts.push({
          kind: 'size_dimension',
          sizeKind,
          tolerance: toleranceOf(dimension.tolerance),
          nominal: dimension.value,
          facesNear: mutable(first),
        });
      continue;
    }
    const second = pointsOf(dimension.facesSecond ?? []);
    const measure = dimension.type === 'location_angular' ? 'angle' : dimension.type === 'location_linear_distance' ? 'distance' : null;
    if (measure === null || first === null || first.length === 0 || second === null || second.length === 0) unmapped += 1;
    else
      drafts.push({
        kind: 'location_dimension',
        measure,
        tolerance: toleranceOf(dimension.tolerance),
        nominal: dimension.value,
        from: mutable(first),
        to: mutable(second),
      });
  }
  return { drafts, unmapped };
}
