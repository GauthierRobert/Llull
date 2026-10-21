/**
 * Public reference data shipped as presets of `add_reference_data` (FR-FPR-77, §11 Q9): Rotax 912 and Lycoming O-320 curves, all read from
 * manufacturer documents (some digitised from graphs, with the reading error as uncertainty). Sources and grades:
 * docs/physics/21-functional-prototype/validation/sources.md, research note E sec. 5. No data of the user's own engine is shipped.
 */

import type { ReferenceData } from '@core/model/prototype';

export const REFERENCE_PRESET_NAMES = [
  'rotax_912uls_full_throttle',
  'rotax_912is_power_table',
  'o320a_full_throttle',
  'o320b_full_throttle',
  'rotax_912_static_rpm_window',
] as const;
export type ReferencePresetName = (typeof REFERENCE_PRESET_NAMES)[number];

/** kW per mechanical horsepower (bhp). */
const KW_PER_BHP = 0.7457;
/** Reading error of a digitised torque or power graph: +-1 N·m / +-1 kW [E sec. 5]. */
const READING_ERROR = 1;

type Preset = Omit<ReferenceData, 'id'>;

const rotaxUlsTorque: readonly (readonly [number, number])[] = [
  [2500, 99],
  [3000, 107],
  [3500, 114.5],
  [4000, 119],
  [4500, 124],
  [5000, 127.5],
  [5100, 128],
  [5500, 124.5],
  [5800, 121],
];

/** 912 iS take-off / continuous power table [rpm, kW] (OM-912 i): manufacturer table values, allowed 1.5 % tolerance on its inconsistencies. */
const rotaxIsPower: readonly (readonly [number, number])[] = [
  [4300, 34.5],
  [4800, 44.9],
  [5000, 51.8],
  [5500, 69.0],
  [5800, 73.5],
];

const o320aBhp: readonly (readonly [number, number])[] = [
  [2200, 128],
  [2600, 146],
  [2700, 150],
  [2800, 152],
];
const o320bBhp: readonly (readonly [number, number])[] = [
  [2200, 138],
  [2400, 146],
  [2600, 155],
  [2700, 160],
  [2800, 163],
];

const lycomingSource = (curve: string): string =>
  `Lycoming O-320 Series Operator's Manual 60297-30, full-throttle power curve ${curve} at standard sea level, digitised (bhp x ${KW_PER_BHP} kW/bhp) [E-R6][C-R20]`;

export const REFERENCE_PRESETS: Readonly<Record<ReferencePresetName, Preset>> = {
  rotax_912uls_full_throttle: {
    quantity: 'brake_torque_Nm',
    condition: { throttle: 'full', altitudeM: 0, note: 'Rotax 912 ULS / S full throttle, 1352 cm3, ISA sea level' },
    points: rotaxUlsTorque.map(([rpm, value]) => ({ rpm, value, uncertainty: READING_ERROR })),
    source:
      'BRP-Rotax OM-912 Ed.4 Rev.1 (2023) Fig. 4 full-throttle torque curve, digitised, +-1 N·m reading error [E-R2]; peak 128 N·m at 5100 rpm and 121 N·m at 5800 rpm agree with the datasheet [E-R1]',
    grade: 'B',
    digitised: true,
    calibrationRpm: [5800],
    bandRel: 0.05,
  },
  rotax_912is_power_table: {
    quantity: 'brake_power_kW',
    condition: {
      throttle: 'full',
      altitudeM: 0,
      note: 'Rotax 912 iS, ECO / POWER table at 974 hPa, 5800 rpm take-off (5 min), 5500 max continuous',
    },
    points: rotaxIsPower.map(([rpm, value]) => ({ rpm, value, uncertainty: 0.015 * value })),
    source:
      'BRP-Rotax OM-912 i Ed.2 Rev.1 (2019) power-setting table, re-paired from the rpm / power / torque columns [E-R3]; some pairs do not close, so 1.5 % reading tolerance',
    grade: 'B',
    digitised: false,
    calibrationRpm: [5800],
    bandRel: 0.05,
  },
  o320a_full_throttle: {
    quantity: 'brake_power_kW',
    condition: { throttle: 'full', altitudeM: 0, note: 'Lycoming O-320-A / -E, CR 7.0, full rich, 25 deg BTC, 80/87 fuel' },
    points: o320aBhp.map(([rpm, bhp]) => ({ rpm, value: bhp * KW_PER_BHP, uncertainty: READING_ERROR })),
    source: lycomingSource('9540-B'),
    grade: 'B',
    digitised: true,
    calibrationRpm: [2700],
    bandRel: 0.05,
  },
  o320b_full_throttle: {
    quantity: 'brake_power_kW',
    condition: { throttle: 'full', altitudeM: 0, note: 'Lycoming O-320-B / -D, CR 8.5, 25 deg BTC, 91/96 fuel' },
    points: o320bBhp.map(([rpm, bhp]) => ({ rpm, value: bhp * KW_PER_BHP, uncertainty: READING_ERROR })),
    source: lycomingSource('11259'),
    grade: 'B',
    digitised: true,
    calibrationRpm: [2700],
    bandRel: 0.05,
  },
  rotax_912_static_rpm_window: {
    quantity: 'static_rpm',
    condition: {
      throttle: 'full',
      altitudeM: 0,
      note: 'fixed-pitch propeller, static full throttle; value = window centre, not a measurement',
    },
    points: [{ value: 5450, min: 5100, max: 5800 }],
    source:
      'E-Props manual HEP-ROTAX9-2020: fixed-pitch static rpm window 5100-5800 rpm, level flight 5500 [F-R22]; take-off rpm above 5200 at full throttle [E-R5]',
    grade: 'B',
    digitised: false,
    calibrationRpm: [],
    bandRel: 0.05,
  },
};
