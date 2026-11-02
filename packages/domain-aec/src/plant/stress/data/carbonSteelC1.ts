/**
 * Carbon steel mean thermal expansion from 70 degF (B31.3 Table C-1 'carbon steel' group as quoted by PSI materials.csv [S3]; the 400 degF row
 * is also quoted by an AutoPIPE note [S8] -> grade A). Transcribed from validation/data/thermal_expansion_carbon_steel.json. Facts only; the
 * table is not extrapolated (07 PST TR-PST-10). Strain between two temperatures is the difference of the strains from the 70 degF reference.
 */

export const CARBON_STEEL_C1_ID = 'carbon-steel-c1';
export const REFERENCE_F = 70;

/** [temperature degF, mean alpha from 70 degF in 1/degF, source, grade]. */
export const CARBON_STEEL_ROWS: readonly (readonly [number, number, string, 'A' | 'B'])[] = [
  [200, 6.38e-6, 'S3 PSI materials.csv', 'B'],
  [300, 6.6e-6, 'S3', 'B'],
  [400, 6.82e-6, 'S3 + S8 (AutoPIPE note quoting B31.3 Table C-1: 2.70 in/100 ft at 400 degF)', 'A'],
  [500, 7.02e-6, 'S3', 'B'],
  [600, 7.23e-6, 'S3', 'B'],
  [700, 7.44e-6, 'S3', 'B'],
  [800, 7.65e-6, 'S3', 'B'],
  [900, 7.84e-6, 'S3', 'B'],
];

export const TABLE_SOURCE = 'S3 PSI materials.csv (GPL-3.0, values read); 400 degF row confirmed by S8; reference 70 degF';
