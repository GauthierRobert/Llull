/**
 * Vocabulary tables between the 03 model and the 04 XCH `ExchangePmi` v2 transport (modifiers, material requirement, fit class, size kinds).
 * What the STEP writer refuses (04 §13.2: projected / non-uniform zones, maximum values, datum modifiers with values, dimension qualifiers, between,
 * all-around / all-over, IT0 / IT1) is never sent: it is reported as lost with the writer's reason, so one such attribute cannot abort an export.
 */

import type { ExchangePmi } from '../../geometry/kernelExchange';
import type { SizeDimensionPmi, SizeKind, ZoneModifier } from '../../model/pmi';

type Tolerance = ExchangePmi['tolerances'][number];
type Dimension = ExchangePmi['dimensions'][number];
export type ToleranceModifier = NonNullable<Tolerance['modifiers']>[number];
export type DimensionModifier = NonNullable<Dimension['modifiers']>[number];
export type DimensionType = Dimension['type'];
type SizeModifier = NonNullable<SizeDimensionPmi['sizeModifiers']>[number];

/** Zone modifiers the writer carries. all_around / all_over are read-only in OCC 7.9.2. */
export const ZONE_TO_TRANSPORT: Readonly<Partial<Record<ZoneModifier, ToleranceModifier>>> = {
  free_state: 'free_state',
  tangent_plane: 'tangent_plane',
  statistical: 'statistical_tolerance',
  common_zone: 'common_zone',
  each_radial_element: 'each_radial_element',
  line_element: 'line_element',
  not_convex: 'not_convex',
  any_cross_section: 'any_cross_section',
  major_diameter: 'major_diameter',
  minor_diameter: 'minor_diameter',
  pitch_diameter: 'pitch_diameter',
  separate_requirement: 'separate_requirement',
  reciprocity: 'reciprocity_requirement',
};

/** Read direction: every transport modifier the model has a zone modifier for (the two material requirements are handled as the material condition). */
export const ZONE_FROM_TRANSPORT: Readonly<Partial<Record<ToleranceModifier, ZoneModifier>>> = {
  ...Object.fromEntries(Object.entries(ZONE_TO_TRANSPORT).map(([model, transport]) => [transport, model])),
  all_around: 'all_around',
  all_over: 'all_over',
};

/** Why a zone modifier is not written. */
export const ZONE_NOT_WRITTEN: Readonly<Partial<Record<ZoneModifier, string>>> = {
  all_around: 'the STEP writer does not write all-around (read-only)',
  all_over: 'the STEP writer does not write all-over (read-only)',
};

/** ISO 14405-1 codes with a transport modifier (E and GC have none). */
export const SIZE_MODIFIER_TO_TRANSPORT: Readonly<Partial<Record<SizeModifier, DimensionModifier>>> = {
  LP: 'two_point_size',
  LS: 'local_size_defined_by_sphere',
  GG: 'least_squares_association',
  GX: 'maximum_inscribed_association',
  GN: 'minimum_circumscribed_association',
  CC: 'circumference_diameter',
  CA: 'area_diameter',
  CV: 'volume_diameter',
  SX: 'maximum_size',
  SN: 'minimum_size',
  SA: 'average_size',
  SM: 'median_size',
  SD: 'mid_range_size',
  SR: 'range_of_sizes',
};

export const SIZE_MODIFIER_FROM_TRANSPORT: Readonly<Partial<Record<DimensionModifier, SizeModifier>>> = Object.fromEntries(
  Object.entries(SIZE_MODIFIER_TO_TRANSPORT).map(([code, transport]) => [transport, code]),
);

export const SIZE_TO_TRANSPORT: Readonly<Record<SizeKind, DimensionType>> = {
  diameter: 'size_diameter',
  radius: 'size_radius',
  width: 'size_thickness',
  spherical_diameter: 'size_spherical_diameter',
  spherical_radius: 'size_spherical_radius',
  angular: 'size_angular',
  curve_length: 'size_curve_length',
};

export const SIZE_FROM_TRANSPORT: Readonly<Partial<Record<DimensionType, SizeKind>>> = Object.fromEntries(
  Object.entries(SIZE_TO_TRANSPORT).map(([kind, transport]) => [transport, kind]),
);

const FIT_CODE = /^([A-Za-z]{1,2})(\d{1,2})$/;

/** ISO 286 class of a fit code ("H7" = hole H, IT7; "js6" = shaft JS, IT6), or why it cannot be written. */
export function classOfFit(code: string): { hole: boolean; variance: string; grade: string } | string {
  const match = FIT_CODE.exec(code);
  if (match === null) return `fit code '${code}' is not a letter-grade class (H7)`;
  const [, letters = '', digits = ''] = match;
  const grade = Number(digits);
  if (grade < 2 || grade > 18) return `the STEP writer cannot write grade IT${grade} (IT0 and IT1 collide with IT01)`;
  return { hole: letters === letters.toUpperCase(), variance: letters.toUpperCase(), grade: `IT${grade}` };
}

/** Fit code of a read class ("H7", "js6"), or null when the grade is not a plain IT number. */
export function fitCodeOf(cls: { hole: boolean; variance: string; grade: string }): string | null {
  const grade = /^IT(\d{1,2})$/.exec(cls.grade)?.[1];
  return grade === undefined ? null : `${cls.hole ? cls.variance.toUpperCase() : cls.variance.toLowerCase()}${grade}`;
}
