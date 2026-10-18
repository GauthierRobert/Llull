/** Free-stream air state shared by the aerodynamics commands: the 1976 standard atmosphere at an altitude, or a given density / viscosity. */

import { z } from '@core/commands/schema';
import { atmosphereAt, geopotentialOf, MAX_GEOPOTENTIAL_M, MIN_GEOMETRIC_M, sutherlandViscosity, US1976 } from './atmosphere';

export const airStateParams = {
  altitudeM: z
    .number()
    .optional()
    .describe(
      'Geometric altitude in m for the U.S. Standard Atmosphere 1976 (-5000..86000). Default 0 (sea level) unless densityKgM3 is given.',
    ),
  temperatureOffsetK: z
    .number()
    .optional()
    .describe('ISA temperature deviation ΔT in K at the standard pressure (e.g. 15 for ISA+15). Default 0.'),
  densityKgM3: z.number().optional().describe('Air density in kg/m³ (> 0) instead of the standard atmosphere, e.g. a measured value.'),
  viscosityPaS: z
    .number()
    .optional()
    .describe('Dynamic viscosity in Pa·s with densityKgM3; default Sutherland at 288.15 K + temperatureOffsetK (1.7894e-5 Pa·s).'),
};

export interface AirState {
  readonly densityKgM3: number;
  readonly viscosityPaS: number;
  readonly speedOfSoundMS: number;
  readonly pressurePa: number | null;
  readonly temperatureK: number | null;
  readonly source: string;
  readonly defaulted: boolean;
}

interface AirStateInput {
  readonly altitudeM?: number | undefined;
  readonly temperatureOffsetK?: number | undefined;
  readonly densityKgM3?: number | undefined;
  readonly viscosityPaS?: number | undefined;
}

/**
 * Resolve the air state.
 * @failure altitude and density both given -> AER_AIR_STATE_CONFLICT; altitude out of range -> AER_ALTITUDE_OUT_OF_RANGE; non-positive density / viscosity -> AER_PARAM_INVALID
 */
export function resolveAirState(input: AirStateInput): AirState | { readonly code: string; readonly message: string } {
  const offset = input.temperatureOffsetK ?? 0;
  if (!Number.isFinite(offset) || 288.15 + offset <= 0)
    return { code: 'AER_PARAM_INVALID', message: 'temperatureOffsetK must be finite and keep T > 0 K' };
  if (input.densityKgM3 !== undefined) {
    if (input.altitudeM !== undefined) return { code: 'AER_AIR_STATE_CONFLICT', message: 'altitudeM and densityKgM3 both given' };
    if (!(input.densityKgM3 > 0) || (input.viscosityPaS !== undefined && !(input.viscosityPaS > 0)))
      return { code: 'AER_PARAM_INVALID', message: 'densityKgM3 and viscosityPaS must be > 0' };
    const temperatureK = US1976.seaLevelTemperatureK + offset;
    return {
      densityKgM3: input.densityKgM3,
      viscosityPaS: input.viscosityPaS ?? sutherlandViscosity(temperatureK),
      speedOfSoundMS: Math.sqrt(((US1976.gamma * US1976.gasConstantUniversal) / US1976.molarMassAir) * temperatureK),
      pressurePa: null,
      temperatureK: null,
      source:
        input.viscosityPaS === undefined
          ? 'given density; Sutherland viscosity and speed of sound at 288.15 K + ΔT'
          : 'given density and viscosity',
      defaulted: false,
    };
  }
  const altitude = input.altitudeM ?? 0;
  const geopotential = geopotentialOf(altitude);
  if (!(altitude >= MIN_GEOMETRIC_M && geopotential <= MAX_GEOPOTENTIAL_M + 0.1))
    return { code: 'AER_ALTITUDE_OUT_OF_RANGE', message: `altitude ${altitude} m is outside -5000..86000 m` };
  const state = atmosphereAt(Math.min(geopotential, MAX_GEOPOTENTIAL_M), offset);
  return {
    densityKgM3: state.densityKgM3,
    viscosityPaS: state.dynamicViscosityPaS,
    speedOfSoundMS: state.speedOfSoundMS,
    pressurePa: state.pressurePa,
    temperatureK: state.temperatureK,
    source: `U.S. Standard Atmosphere 1976 at ${altitude} m${offset !== 0 ? `, ISA${offset > 0 ? '+' : ''}${offset} K` : ''}`,
    defaulted: input.altitudeM === undefined,
  };
}

export const isAirState = (value: AirState | { readonly code: string; readonly message: string }): value is AirState =>
  'densityKgM3' in value;
