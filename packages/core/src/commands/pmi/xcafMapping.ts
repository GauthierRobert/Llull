/**
 * PmiItem <-> AP242 transport mapping (03 GDT TECHNICAL_SPEC §6.1, M6): the pure translation between the 03 model and the neutral `ExchangePmi`
 * vocabulary of the 04 XCH transport v2 (XCAF DimTol on faces). Faces are 0-based `TopExp::MapShapes` indices of one product shape.
 * @invariant a written dimension carries the nominal MEASURED from the B-rep (the stated nominal for angular / curve-length sizes) and deviations as
 *   magnitudes (nominal - minus <= x <= nominal + plus); limits also travel as the range, fits as the ISO 286 class; material condition, spherical zone,
 *   zone / size modifiers and the datum boundary (MMB / LMB) travel in the v2 vocabulary
 * @failure what the STEP writer refuses (projected zones, maximum values, composite links, all-around / all-over, a datum boundary that differs between
 *   frames, IT0 / IT1, E / GC size codes) is never sent and is listed as lost with its reason; an item the transport cannot represent is listed as skipped
 */

import type { ExchangePmi } from '../../geometry/kernelExchange';
import type { DatumReference, GeometricCharacteristic, PmiFeature, PmiItem, PmiTolerance, ZoneModifier } from '../../model/pmi';
import type { Vec3 } from '../../model/types';
import type { PmiDraft } from './applySet';
import {
  SIZE_FROM_TRANSPORT,
  SIZE_MODIFIER_FROM_TRANSPORT,
  SIZE_MODIFIER_TO_TRANSPORT,
  SIZE_TO_TRANSPORT,
  ZONE_FROM_TRANSPORT,
  ZONE_NOT_WRITTEN,
  ZONE_TO_TRANSPORT,
  type DimensionModifier,
  type ToleranceModifier,
  classOfFit,
  fitCodeOf,
} from './xcafVocabulary';

type Tolerance = ExchangePmi['tolerances'][number];
type Dimension = ExchangePmi['dimensions'][number];
type Datum = ExchangePmi['datums'][number];
type Characteristic = Tolerance['characteristic'];

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

/** Deviations of `tolerance` around `nominal` as the transport magnitudes; null = basic (no tolerance). */
function deviations(tolerance: PmiTolerance, nominal: number): { plus: number; minus: number } | null {
  if (tolerance.type === 'basic') return null;
  if (tolerance.type === 'limits') return { plus: tolerance.upper - nominal, minus: nominal - tolerance.lower };
  return { plus: tolerance.upper, minus: -tolerance.lower };
}

/** The tolerance fields of a transport dimension (deviations, limits as range, fit as class) and what of the model's tolerance cannot be written. */
function toleranceFields(tolerance: PmiTolerance, nominal: number): { fields: Partial<Dimension>; lost: string[] } {
  const deviation = deviations(tolerance, nominal);
  const fields: { -readonly [K in keyof Dimension]?: Dimension[K] } = deviation === null ? {} : { tolerance: deviation };
  const lost: string[] = [];
  if (tolerance.type === 'limits') {
    // limits travel as the range alone: OCC reads a range written next to deviations back with the wrong lower bound
    delete fields.tolerance;
    fields.range = { lower: tolerance.lower, upper: tolerance.upper };
  }
  if (tolerance.type === 'fit') {
    const cls = classOfFit(tolerance.code);
    if (typeof cls === 'string') lost.push(`tolerance.code (${cls})`);
    else fields.classOfTolerance = cls;
  }
  return { fields, lost };
}

export interface ExportedPmi {
  /** Null when no item could be written. */
  readonly pmi: ExchangePmi | null;
  /** Ids written. */
  readonly written: readonly string[];
  /** Items the transport cannot carry, with the reason. */
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
  /** Written items that lose attributes the transport or its STEP writer cannot carry, each with the reason. */
  readonly lossy: readonly { readonly id: string; readonly lost: readonly string[] }[];
}

const mutable = (points: readonly Vec3[]): [number, number, number][] => points.map((p): [number, number, number] => [p[0], p[1], p[2]]);

const BOUNDARY = { MMB: 'maximum_material_requirement', LMB: 'least_material_requirement' } as const;

/** The boundary of each datum label: the first one a frame states (a transport datum carries one). */
function boundaries(items: readonly PmiItem[]): Map<string, 'MMB' | 'LMB'> {
  const found = new Map<string, 'MMB' | 'LMB'>();
  for (const item of items)
    if (item.kind === 'geometric_tolerance')
      for (const reference of item.datums)
        if (reference.boundary !== undefined && !found.has(reference.label)) found.set(reference.label, reference.boundary);
  return found;
}

/** The transport tolerance of a frame, and what of it is lost. */
function toleranceOf(
  item: Extract<PmiItem, { kind: 'geometric_tolerance' }>,
  faces: readonly number[],
  datumBoundary: Map<string, 'MMB' | 'LMB'>,
): { tolerance: Tolerance; lost: string[] } {
  const { zone } = item;
  const lost: string[] = [];
  const modifiers: ToleranceModifier[] = [];
  for (const modifier of item.modifiers) {
    const mapped = ZONE_TO_TRANSPORT[modifier];
    if (mapped === undefined) lost.push(`modifiers.${modifier} (${ZONE_NOT_WRITTEN[modifier] ?? 'no transport modifier'})`);
    else modifiers.push(mapped);
  }
  if (zone.projectedLength !== undefined) lost.push('zone.projectedLength (the STEP writer refuses projected zones)');
  if (zone.unequallyDisposed !== undefined) lost.push('zone.unequallyDisposed (the STEP writer refuses non-uniform zones)');
  if (zone.maxValue !== undefined) lost.push('zone.maxValue (the STEP writer carries no maximum value)');
  if (item.compositeOf !== undefined) lost.push('compositeOf (the transport has no composite segment link)');
  for (const reference of item.datums)
    if (datumBoundary.get(reference.label) !== reference.boundary && datumBoundary.has(reference.label))
      lost.push(`datum ${reference.label} boundary (a transport datum carries one boundary; the first frame's is written)`);
  const spherical = zone.spherical === true;
  const tolerance: Tolerance = {
    characteristic: TO_TRANSPORT[item.characteristic],
    value: zone.value,
    diameterZone: zone.diametral === true && !spherical,
    ...(spherical ? { sphericalZone: true } : {}),
    faces,
    datums: item.datums.map((datum) => datum.label),
    ...(item.materialCondition === 'RFS'
      ? {}
      : { materialRequirement: item.materialCondition === 'MMC' ? ('maximum' as const) : ('least' as const) }),
    ...(modifiers.length === 0 ? {} : { modifiers }),
  };
  return { tolerance, lost };
}

/**
 * Transport PMI of the items attached to ONE solid; `facesOf` gives the 0-based kernel face indices of a feature (re-resolved by the caller).
 * Datum targets, surface texture and notes have no transport vocabulary (graphic / annotation PMI is V2) and are skipped.
 */
export function toExchangePmi(items: readonly PmiItem[], facesOf: (feature: PmiFeature) => readonly number[]): ExportedPmi {
  const skipped: { id: string; reason: string }[] = [];
  const lossy: { id: string; lost: readonly string[] }[] = [];
  const written: string[] = [];
  const boundary = boundaries(items);
  const datums: Datum[] = [];
  for (const item of items) {
    if (item.kind !== 'datum_feature') continue;
    const faces = facesOf(item.feature);
    if (faces.length === 0) skipped.push({ id: item.id, reason: 'the feature resolves to no face' });
    else {
      const edge = boundary.get(item.label);
      datums.push({ label: item.label, faces, ...(edge === undefined ? {} : { modifiers: [BOUNDARY[edge]] }) });
      written.push(item.id);
    }
  }
  const known = new Set(datums.map((datum) => datum.label));
  const tolerances: Tolerance[] = [];
  const dimensions: Dimension[] = [];
  const byId = new Map(items.map((item) => [item.id, item] as const));
  const note = (item: PmiItem, lost: readonly string[]): void => {
    written.push(item.id);
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
        const frame = toleranceOf(item, faces, boundary);
        tolerances.push(frame.tolerance);
        note(item, frame.lost);
      }
    } else if (item.kind === 'size_dimension') {
      const faces = facesOf(item.feature);
      const unmeasured = item.sizeKind === 'angular' || item.sizeKind === 'curve_length';
      const measured = item.feature.ofSize?.measured;
      const nominal = unmeasured
        ? item.nominal
        : measured === undefined
          ? undefined
          : item.sizeKind === 'radius' || item.sizeKind === 'spherical_radius'
            ? measured / 2
            : measured;
      if (faces.length === 0 || nominal === undefined) skipped.push({ id: item.id, reason: 'the feature resolves to no measured face' });
      else {
        const { fields, lost } = toleranceFields(item.tolerance, nominal);
        const modifiers: DimensionModifier[] = [];
        for (const code of item.sizeModifiers ?? []) {
          const mapped = SIZE_MODIFIER_TO_TRANSPORT[code];
          if (mapped === undefined) lost.push(`sizeModifiers.${code} (no ISO 14405 modifier in the transport)`);
          else modifiers.push(mapped);
        }
        dimensions.push({
          type: SIZE_TO_TRANSPORT[item.sizeKind],
          value: nominal,
          ...fields,
          ...(modifiers.length === 0 ? {} : { modifiers }),
          faces,
        });
        note(item, lost);
      }
    } else if (item.kind === 'location_dimension') {
      const [from, to] = [facesOf(item.from), facesOf(item.to)];
      if (from.length === 0 || to.length === 0) skipped.push({ id: item.id, reason: 'a feature resolves to no face' });
      else {
        const { fields, lost } = toleranceFields(item.tolerance, item.measured);
        dimensions.push({
          type: item.measure === 'angle' ? 'location_angular' : 'location_linear_distance',
          value: item.measured,
          ...fields,
          faces: from,
          facesSecond: to,
        });
        note(item, lost);
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
  /** Source items with no mappable face (or a dimension type with no model form). */
  readonly unmapped: number;
}

const unmodelled = (attributes: readonly string[]): { unmodelled?: string[] } =>
  attributes.length === 0 ? {} : { unmodelled: [...attributes] };

/** The nominal a read dimension states; with a range OCC stores the mid-range as the value, which says nothing about the nominal. */
const statedNominal = (dimension: Dimension): { nominal?: number } => (dimension.range === undefined ? { nominal: dimension.value } : {});

/** The tolerance of a read dimension: limits from the range, a fit from the class, else deviations (none = basic). */
function readTolerance(dimension: Dimension): PmiTolerance {
  const deviation = dimension.tolerance;
  if (dimension.range !== undefined) return { type: 'limits', upper: dimension.range.upper, lower: dimension.range.lower };
  const code = dimension.classOfTolerance === undefined ? null : fitCodeOf(dimension.classOfTolerance);
  if (code !== null) return { type: 'fit', code, upper: deviation?.plus ?? 0, lower: -(deviation?.minus ?? 0) };
  return deviation === undefined || (deviation.plus === 0 && deviation.minus === 0)
    ? { type: 'basic' }
    : { type: 'plusMinus', upper: deviation.plus, lower: -deviation.minus };
}

/**
 * `apply_pmi_set` drafts of one solid's transport PMI (document units); `pointsOf` maps face indices to one world point ON each face, null
 * when an index names no face of the solid (the item is then unmapped). Attributes the model has no field for are listed in `unmodelled`.
 */
export function fromExchangePmi(pmi: ExchangePmi, pointsOf: (faces: readonly number[]) => readonly Vec3[] | null): ImportedPmiDrafts {
  const drafts: PmiDraft[] = [];
  let unmapped = 0;
  const boundary = new Map<string, DatumReference['boundary']>();
  for (const datum of pmi.datums) {
    const facesNear = pointsOf(datum.faces);
    const lost: string[] = [];
    for (const modifier of datum.modifiers ?? []) {
      if (modifier === 'maximum_material_requirement') boundary.set(datum.label, 'MMB');
      else if (modifier === 'least_material_requirement') boundary.set(datum.label, 'LMB');
      else lost.push(`datum modifier ${modifier}`);
    }
    if (datum.modifierWithValue !== undefined) lost.push(`datum modifier ${datum.modifierWithValue.kind} ${datum.modifierWithValue.value}`);
    if (facesNear === null || facesNear.length === 0) unmapped += 1;
    else drafts.push({ kind: 'datum_feature', label: datum.label, ...unmodelled(lost), facesNear: mutable(facesNear) });
  }
  for (const tolerance of pmi.tolerances) {
    const facesNear = pointsOf(tolerance.faces);
    if (facesNear === null || facesNear.length === 0) {
      unmapped += 1;
      continue;
    }
    const lost: string[] = [];
    const modifiers: ZoneModifier[] = [];
    let condition: 'MMC' | 'LMC' | undefined =
      tolerance.materialRequirement === undefined ? undefined : tolerance.materialRequirement === 'maximum' ? 'MMC' : 'LMC';
    for (const modifier of tolerance.modifiers ?? []) {
      if (modifier === 'maximum_material_requirement') condition ??= 'MMC';
      else if (modifier === 'least_material_requirement') condition ??= 'LMC';
      else {
        const mapped = ZONE_FROM_TRANSPORT[modifier];
        if (mapped === undefined) lost.push(`modifier ${modifier}`);
        else modifiers.push(mapped);
      }
    }
    const zone = {
      value: tolerance.value,
      ...(tolerance.diameterZone ? { diametral: true } : {}),
      ...(tolerance.sphericalZone === true ? { spherical: true } : {}),
    };
    const extra: { projectedLength?: number; unequallyDisposed?: number; maxValue?: number } = {};
    if (tolerance.zoneModifier === 'projected' && tolerance.zoneModifierValue !== undefined)
      extra.projectedLength = tolerance.zoneModifierValue;
    else if (tolerance.zoneModifier === 'non_uniform' && tolerance.zoneModifierValue !== undefined)
      extra.unequallyDisposed = tolerance.zoneModifierValue;
    else if (tolerance.zoneModifier !== undefined) lost.push(`zone modifier ${tolerance.zoneModifier}`);
    if (tolerance.maxValue !== undefined) extra.maxValue = tolerance.maxValue;
    drafts.push({
      kind: 'geometric_tolerance',
      characteristic: FROM_TRANSPORT[tolerance.characteristic],
      zone: { ...zone, ...extra },
      ...(condition === undefined ? {} : { materialCondition: condition }),
      ...(modifiers.length === 0 ? {} : { modifiers }),
      datums: tolerance.datums.map((label) => ({
        label,
        ...(boundary.get(label) === undefined ? {} : { boundary: boundary.get(label) as 'MMB' | 'LMB' }),
      })),
      ...unmodelled(lost),
      facesNear: mutable(facesNear),
    });
  }
  for (const dimension of pmi.dimensions) {
    const first = pointsOf(dimension.faces);
    const sizeKind = SIZE_FROM_TRANSPORT[dimension.type];
    const lost: string[] = dimension.qualifier === undefined ? [] : [`dimension qualifier ${dimension.qualifier}`];
    const codes: NonNullable<Extract<PmiDraft, { kind: 'size_dimension' }>['sizeModifiers']> = [];
    for (const modifier of dimension.modifiers ?? []) {
      const code = SIZE_MODIFIER_FROM_TRANSPORT[modifier];
      if (sizeKind !== undefined && code !== undefined) codes.push(code);
      else lost.push(`dimension modifier ${modifier}`);
    }
    if (sizeKind !== undefined) {
      if (first === null || first.length === 0) unmapped += 1;
      else
        drafts.push({
          kind: 'size_dimension',
          sizeKind,
          tolerance: readTolerance(dimension),
          ...statedNominal(dimension),
          ...(codes.length === 0 ? {} : { sizeModifiers: codes }),
          ...unmodelled(lost),
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
        tolerance: readTolerance(dimension),
        ...statedNominal(dimension),
        ...unmodelled(lost),
        from: mutable(first),
        to: mutable(second),
      });
  }
  return { drafts, unmapped };
}
