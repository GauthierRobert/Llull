/** standard_atmosphere: U.S. Standard Atmosphere 1976 state at an altitude, with optional free-stream flight / flow quantities. */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { briefReport, sig } from '../shared/results';
import { atmosphereAt, geometricOf, geopotentialOf, MAX_GEOPOTENTIAL_M, MIN_GEOMETRIC_M, US1976 } from '../shared/atmosphere';
import { refuseAero } from './codes';
import { MIN_TEMPERATURE_K } from '../shared/airState';
import { SPEED_UNITS, speedParam, toMetresPerSecond } from '../shared/speed';

const FT = 0.3048;

/**
 * @affects none; data = { altitude { geometricM, geopotentialM, layer }, temperatureK, pressurePa, densityKgM3, speedOfSoundMS, dynamicViscosityPaS, kinematicViscosityM2S, gravityMS2, ratios, flow?, provenance }
 * @invariant layers, constants and Sutherland law of NASA-TM-X-74335; ΔT shifts temperature at the standard pressure
 * @failure altitude outside -5 km..86 km geometric (84.852 km geopotential) -> AER_ALTITUDE_OUT_OF_RANGE; non-finite / non-positive inputs -> AER_PARAM_INVALID
 */
export const standardAtmosphere = defineCommand({
  name: 'standard_atmosphere',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only air properties of the U.S. Standard Atmosphere 1976 (identical to ICAO ISA up to 32 km) at one altitude: temperature, ' +
    'pressure, density, speed of sound, dynamic and kinematic viscosity (Sutherland), local gravity and ratios to sea level. ' +
    '`altitude` in `altitudeUnit` (m default, ft or km); `altitudeType` geometric (default, height above sea level) or geopotential; range ' +
    '-5 km to 86 km geometric. `temperatureOffsetK` gives an ISA+ΔT day (temperature shifted, pressure kept, density from the gas law). ' +
    'Give `speed` (+ `speedUnit`) to also get Mach, dynamic pressure q = ½ρV², equivalent airspeed and Reynolds number per metre or for ' +
    '`referenceLengthM` (chord, body length). Used by analyze_wing, aero_drag, road_load_power and nozzle_performance (ambient pressure).',
  params: z.object({
    altitude: z.number().describe('Altitude in altitudeUnit; -5000 m .. 86000 m geometric.'),
    altitudeUnit: z.enum(['m', 'ft', 'km']).optional().describe('Unit of altitude: m (default), ft or km.'),
    altitudeType: z
      .enum(['geometric', 'geopotential'])
      .optional()
      .describe('geometric (default): height above mean sea level; geopotential: H = r0 Z / (r0 + Z), r0 6 356 766 m.'),
    temperatureOffsetK: z.number().optional().describe('ISA deviation ΔT in K (e.g. +15 for a hot day). Default 0.'),
    ...speedParam,
    referenceLengthM: z
      .number()
      .optional()
      .describe('Reference length in m for the Reynolds number (chord, body length). Default 1 (per metre).'),
  }),
  run: (doc, params): CommandResult => {
    const unit = params.altitudeUnit ?? 'm';
    const type = params.altitudeType ?? 'geometric';
    const offset = params.temperatureOffsetK ?? 0;
    const metres = params.altitude * (unit === 'ft' ? FT : unit === 'km' ? 1000 : 1);
    const geopotential = type === 'geometric' ? geopotentialOf(metres) : metres;
    const geometric = type === 'geometric' ? metres : geometricOf(metres);
    if (!(geometric >= MIN_GEOMETRIC_M && geopotential <= MAX_GEOPOTENTIAL_M + 0.1))
      return refuseAero(
        doc,
        'standard_atmosphere',
        'AER_ALTITUDE_OUT_OF_RANGE',
        `altitude ${params.altitude} ${unit} (${type}) is outside -5 km..86 km geometric`,
        [],
        ['altitude'],
      );
    if (!Number.isFinite(offset) || US1976.seaLevelTemperatureK + offset <= MIN_TEMPERATURE_K)
      return refuseAero(
        doc,
        'standard_atmosphere',
        'AER_PARAM_INVALID',
        'temperatureOffsetK must be finite and keep T well above 0 K',
        [],
        ['temperatureOffsetK'],
      );
    const reference = params.referenceLengthM ?? 1;
    if (!(reference > 0))
      return refuseAero(doc, 'standard_atmosphere', 'AER_PARAM_INVALID', 'referenceLengthM must be > 0', [], ['referenceLengthM']);
    const speed = params.speed === undefined ? undefined : toMetresPerSecond(params.speed, params.speedUnit ?? 'm/s');
    if (speed !== undefined && !(speed >= 0))
      return refuseAero(doc, 'standard_atmosphere', 'AER_PARAM_INVALID', 'speed must be >= 0', [], ['speed']);
    const state = atmosphereAt(Math.min(geopotential, MAX_GEOPOTENTIAL_M), offset);
    if (!(state.temperatureK > MIN_TEMPERATURE_K))
      return refuseAero(
        doc,
        'standard_atmosphere',
        'AER_PARAM_INVALID',
        `temperatureOffsetK ${offset} gives ${state.temperatureK.toFixed(1)} K at this altitude (floor ${MIN_TEMPERATURE_K} K)`,
        [],
        ['temperatureOffsetK'],
      );
    const sea = atmosphereAt(0);
    const flow =
      speed === undefined
        ? undefined
        : {
            speedMS: sig(speed),
            mach: sig(speed / state.speedOfSoundMS),
            dynamicPressurePa: sig(0.5 * state.densityKgM3 * speed * speed),
            equivalentAirspeedMS: sig(speed * Math.sqrt(state.densityKgM3 / sea.densityKgM3)),
            reynolds: sig((state.densityKgM3 * speed * reference) / state.dynamicViscosityPaS),
            referenceLengthM: reference,
          };
    const data = {
      altitude: {
        geometricM: sig(geometric),
        geopotentialM: sig(geopotential),
        layer: state.layer,
        input: { value: params.altitude, unit, type },
      },
      temperatureK: sig(state.temperatureK),
      temperatureC: sig(state.temperatureK - 273.15),
      pressurePa: sig(state.pressurePa),
      densityKgM3: sig(state.densityKgM3),
      speedOfSoundMS: sig(state.speedOfSoundMS),
      dynamicViscosityPaS: sig(state.dynamicViscosityPaS),
      kinematicViscosityM2S: sig(state.kinematicViscosityM2S),
      gravityMS2: sig(state.gravityMS2),
      ratios: {
        temperature: sig(state.temperatureK / sea.temperatureK),
        pressure: sig(state.pressurePa / sea.pressurePa),
        density: sig(state.densityKgM3 / sea.densityKgM3),
      },
      ...(flow === undefined ? {} : { flow }),
      temperatureOffsetK: offset,
      provenance: {
        model: 'U.S. Standard Atmosphere 1976 (NASA-TM-X-74335), 7 geopotential layers to 84.852 km; ICAO ISA identical to 32 km',
        constants: { ...US1976 },
        notes: [
          'Above 80 km the 1976 kinetic temperature differs from the molecular-scale temperature returned here by < 0.05 %.',
          'ISA+ΔT keeps the standard pressure at the altitude and recomputes density, viscosity and speed of sound.',
        ],
        speedUnits: SPEED_UNITS,
      },
    };
    return briefReport(
      doc,
      `Standard atmosphere at ${sig(geometric)} m (geopotential ${sig(geopotential)} m, layer ${state.layer}${offset !== 0 ? `, ISA${offset > 0 ? '+' : ''}${offset} K` : ''}): ` +
        `T ${data.temperatureK} K, p ${data.pressurePa} Pa, ρ ${data.densityKgM3} kg/m³, a ${data.speedOfSoundMS} m/s, μ ${data.dynamicViscosityPaS} Pa·s` +
        (flow === undefined
          ? '.'
          : `; V ${flow.speedMS} m/s: Mach ${flow.mach}, q ${flow.dynamicPressurePa} Pa, Re ${flow.reynolds} (L ${reference} m).`),
      data,
    );
  },
});
