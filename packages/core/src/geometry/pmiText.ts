/**
 * Text rendering of PMI items (03 GDT TECHNICAL_SPEC §5.4): the grammar of `list_pmi`, the sheet painter and the viewport label.
 * FCF := symbol "|" [Ø|SØ] value [Ⓜ|Ⓛ] [modifiers] [UZ v] { "|" datum [Ⓜ|Ⓛ] }. Display uses Unicode symbols; `ascii` gives a plain fallback.
 */

import type { GeometricCharacteristic, GeometricTolerancePmi, PmiItem, PmiTolerance, SizeDimensionPmi, ZoneModifier } from '../model/pmi';

const CHARACTERISTIC_SYMBOLS: Readonly<Record<GeometricCharacteristic, readonly [unicode: string, ascii: string]>> = {
  straightness: ['⏤', 'STRAIGHTNESS'],
  flatness: ['⏥', 'FLATNESS'],
  roundness: ['○', 'ROUNDNESS'],
  cylindricity: ['⌭', 'CYLINDRICITY'],
  profile_line: ['⌒', 'PROFILE-LINE'],
  profile_surface: ['⌓', 'PROFILE-SURFACE'],
  angularity: ['∠', 'ANGULARITY'],
  perpendicularity: ['⟂', 'PERPENDICULARITY'],
  parallelism: ['∥', 'PARALLELISM'],
  position: ['⌖', 'POSITION'],
  concentricity: ['◎', 'CONCENTRICITY'],
  coaxiality: ['◎', 'COAXIALITY'],
  symmetry: ['⌯', 'SYMMETRY'],
  circular_runout: ['↗', 'CIRCULAR-RUNOUT'],
  total_runout: ['⌰', 'TOTAL-RUNOUT'],
};

export const ZONE_MODIFIER_TEXT: Readonly<Record<ZoneModifier, readonly [unicode: string, ascii: string]>> = {
  free_state: ['Ⓕ', '(F)'],
  tangent_plane: ['Ⓣ', '(T)'],
  statistical: ['Ⓢt', '(ST)'],
  common_zone: ['CZ', 'CZ'],
  each_radial_element: ['ERE', 'ERE'],
  line_element: ['LE', 'LE'],
  not_convex: ['NC', 'NC'],
  any_cross_section: ['ACS', 'ACS'],
  major_diameter: ['MD', 'MD'],
  minor_diameter: ['LD', 'LD'],
  pitch_diameter: ['PD', 'PD'],
  separate_requirement: ['SEP REQT', 'SEP REQT'],
  reciprocity: ['Ⓡ', '(R)'],
  all_around: ['ALL AROUND', 'ALL AROUND'],
  all_over: ['ALL OVER', 'ALL OVER'],
};

/** Symbol of a characteristic. */
export const characteristicSymbol = (characteristic: GeometricCharacteristic, ascii = false): string =>
  CHARACTERISTIC_SYMBOLS[characteristic][ascii ? 1 : 0];

/** Number without float noise, document precision up to 10 significant digits. */
export const formatNumber = (value: number): string => String(Number(value.toPrecision(10)));

const material = (condition: 'MMC' | 'LMC' | 'RFS', ascii: boolean): string =>
  condition === 'MMC' ? (ascii ? '(M)' : 'Ⓜ') : condition === 'LMC' ? (ascii ? '(L)' : 'Ⓛ') : '';

/** Zone text of a geometric tolerance: "Ø0.3 Ⓜ Ⓟ5 Ⓕ UZ 0.1". */
function zoneText(item: GeometricTolerancePmi, ascii: boolean): string {
  const { zone } = item;
  const prefix = zone.spherical === true ? 'SØ' : zone.diametral === true ? 'Ø' : '';
  const parts = [`${prefix}${formatNumber(zone.value)}`];
  const condition = material(item.materialCondition, ascii);
  if (condition !== '') parts.push(condition);
  if (zone.projectedLength !== undefined) parts.push(`${ascii ? '(P)' : 'Ⓟ'}${formatNumber(zone.projectedLength)}`);
  for (const modifier of item.modifiers) parts.push(ZONE_MODIFIER_TEXT[modifier][ascii ? 1 : 0]);
  if (zone.unequallyDisposed !== undefined) parts.push(`UZ ${formatNumber(zone.unequallyDisposed)}`);
  if (zone.maxValue !== undefined) parts.push(`MAX ${formatNumber(zone.maxValue)}`);
  return parts.join(' ');
}

/** "⌖ | Ø0.3 Ⓜ | A | B | C". */
export function fcfText(item: GeometricTolerancePmi, ascii = false): string {
  const datums = item.datums.map(
    (datum) =>
      `${datum.label}${datum.boundary === 'MMB' ? (ascii ? ' (M)' : ' Ⓜ') : datum.boundary === 'LMB' ? (ascii ? ' (L)' : ' Ⓛ') : ''}`,
  );
  return [characteristicSymbol(item.characteristic, ascii), zoneText(item, ascii), ...datums].join(' | ');
}

const signed = (value: number): string => (value === 0 ? '0' : `${value > 0 ? '+' : '-'}${formatNumber(Math.abs(value))}`);

/** Tolerance text after a nominal: "+0.021/0", "±0.1", "6.6–6.9" (limits replace the nominal), "H7 (+0.021/0)", "" for basic. */
function toleranceText(tolerance: PmiTolerance, nominal: string): string {
  switch (tolerance.type) {
    case 'basic':
      return `[${nominal}]`;
    case 'limits':
      return `${formatNumber(tolerance.lower)}–${formatNumber(tolerance.upper)}`;
    case 'fit':
      return `${nominal} ${tolerance.code} (${signed(tolerance.upper)}/${signed(tolerance.lower)})`;
    default:
      return tolerance.upper === -tolerance.lower
        ? `${nominal} ±${formatNumber(tolerance.upper)}`
        : `${nominal} ${signed(tolerance.upper)}/${signed(tolerance.lower)}`;
  }
}

/** Nominal of a size dimension as shown (radius sizeKind shows half the measured diameter). */
export const sizeNominal = (item: SizeDimensionPmi): number | undefined => {
  const measured = item.feature.ofSize?.measured;
  if (item.sizeKind === 'angular' || item.sizeKind === 'curve_length') return item.nominal;
  return measured === undefined ? undefined : item.sizeKind === 'radius' || item.sizeKind === 'spherical_radius' ? measured / 2 : measured;
};

/**
 * Nominal and deviations (document units, degrees for an angle) of a PMI size or location dimension, as a stack-up contributor takes them, or
 * why the item cannot feed a stack (not a dimension, basic, no measured nominal). Limits tolerances become deviations from the measured nominal.
 */
export function toleranceBasis(item: PmiItem): { nominal: number; lower: number; upper: number } | string {
  if (item.kind !== 'size_dimension' && item.kind !== 'location_dimension')
    return `'${item.id}' is a ${item.kind}, not a size or location dimension`;
  const tolerance = item.tolerance;
  if (tolerance.type === 'basic') return `'${item.id}' is a basic dimension and carries no tolerance`;
  const nominal = item.kind === 'size_dimension' ? sizeNominal(item) : item.measured;
  if (nominal === undefined) return `'${item.id}' has no measured nominal (unresolved feature)`;
  return tolerance.type === 'limits'
    ? { nominal, lower: tolerance.lower - nominal, upper: tolerance.upper - nominal }
    : { nominal, lower: tolerance.lower, upper: tolerance.upper };
}

const SIZE_PREFIX: Readonly<Record<SizeDimensionPmi['sizeKind'], string>> = {
  diameter: 'Ø',
  radius: 'R',
  width: '',
  spherical_diameter: 'SØ',
  spherical_radius: 'SR',
  angular: '∠',
  curve_length: '⌒',
};

/** "4X Ø6.6–6.9", "Ø20 +0.021/0", "R5 ±0.1". */
export function sizeText(item: SizeDimensionPmi, ascii = false): string {
  const nominal = sizeNominal(item);
  const prefix = SIZE_PREFIX[item.sizeKind];
  const body =
    item.tolerance.type === 'limits'
      ? `${prefix}${toleranceText(item.tolerance, '')}`
      : toleranceText(item.tolerance, `${prefix}${nominal === undefined ? '?' : formatNumber(nominal)}`);
  const count = item.count > 1 ? `${item.count}X ` : '';
  const modifiers = (item.sizeModifiers ?? []).map((m) => (m === 'E' ? (ascii ? '(E)' : 'Ⓔ') : `(${m})`));
  return [`${count}${body}`, ...modifiers].join(' ');
}

/** Text rendering of any PMI item. */
export function pmiText(item: PmiItem, ascii = false): string {
  switch (item.kind) {
    case 'datum_feature':
      return `[${item.label}]`;
    case 'datum_target':
      return `${item.label}${item.targetNumber}`;
    case 'size_dimension':
      return sizeText(item, ascii);
    case 'location_dimension':
      return item.measure === 'angle'
        ? `${toleranceText(item.tolerance, `${formatNumber(item.measured)}°`)}`
        : toleranceText(item.tolerance, formatNumber(item.measured));
    case 'geometric_tolerance':
      return fcfText(item, ascii);
    case 'surface_texture':
      return `${item.parameter} ${formatNumber(item.value)} ${item.unit === 'um' ? (ascii ? 'um' : 'µm') : ascii ? 'uin' : 'µin'}${
        item.lay === undefined ? '' : ` lay ${item.lay}`
      }${item.process === undefined ? '' : ` ${item.process}`}`;
    case 'note':
      return item.text;
  }
}
