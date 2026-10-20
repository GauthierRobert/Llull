/**
 * Sourced ASD library (AF-30). GEVS component random levels as quoted by two secondary sources (validation/sources.md S4: Vibration
 * Research application note quoting GSFC-STD-7000B Table 2.4-3, and wobbl modal.py): grade B until a human reads Table 2.4-3 itself, so
 * every case driven by them is `unverified` (VC-DYN-43).
 */

import type { DynamicSource } from '@core/model/structuralDynamics';
import type { AsdPoint } from './math/psd';

export interface LibrarySpectrum {
  readonly points: readonly AsdPoint[];
  readonly unit: 'g2/Hz';
  readonly source: DynamicSource;
}

const GEVS_SOURCE =
  'GSFC-STD-7000B Table 2.4-3 (components, 22.7 kg or less) as quoted by Vibration Research (https://vibrationresearch.com/?p=20548) and wobbl modal.py; table not read directly';

export const SPECTRUM_LIBRARY: Readonly<Record<'gevs_component_qual' | 'gevs_component_accept', LibrarySpectrum>> = {
  gevs_component_qual: {
    points: [
      [20, 0.026],
      [50, 0.16],
      [800, 0.16],
      [2000, 0.026],
    ],
    unit: 'g2/Hz',
    source: {
      citation: `${GEVS_SOURCE}; qualification level, 14.1 g rms`,
      grade: 'B',
      url: 'https://standards.nasa.gov/standard/GSFC/GSFC-STD-7000',
    },
  },
  gevs_component_accept: {
    points: [
      [20, 0.013],
      [50, 0.08],
      [800, 0.08],
      [2000, 0.013],
    ],
    unit: 'g2/Hz',
    source: {
      citation: `${GEVS_SOURCE}; acceptance level (qualification - 3 dB), 10.0 g rms`,
      grade: 'B',
      url: 'https://standards.nasa.gov/standard/GSFC/GSFC-STD-7000',
    },
  },
};

export const LIBRARY_NAMES = Object.keys(SPECTRUM_LIBRARY) as (keyof typeof SPECTRUM_LIBRARY)[];
