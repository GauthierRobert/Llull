/**
 * U.S. Standard Atmosphere 1976 (NOAA/NASA/USAF, NASA-TM-X-74335), geopotential layers 0..84.852 km (geometric 86 km), plus an ISA
 * temperature offset at constant pressure. Sutherland viscosity, speed of sound with γ 1.4.
 */

/** Defining constants of the 1976 standard (Table 2 / §1.2). */
export const US1976 = {
  seaLevelTemperatureK: 288.15,
  seaLevelPressurePa: 101325,
  standardGravity: 9.80665,
  /** R* J/(kmol·K) as adopted by the 1976 standard (not CODATA). */
  gasConstantUniversal: 8314.32,
  molarMassAir: 28.9644,
  earthRadiusM: 6356766,
  gamma: 1.4,
  sutherlandBeta: 1.458e-6,
  sutherlandS: 110.4,
} as const;

/** Base geopotential altitude (m') and lapse rate (K/m') of each layer (Table 4). */
const LAYERS: ReadonlyArray<readonly [number, number]> = [
  [0, -0.0065],
  [11000, 0],
  [20000, 0.001],
  [32000, 0.0028],
  [47000, 0],
  [51000, -0.0028],
  [71000, -0.002],
];

export const MAX_GEOPOTENTIAL_M = 84852;
export const MIN_GEOMETRIC_M = -5000;

const AIR_GAS_CONSTANT = US1976.gasConstantUniversal / US1976.molarMassAir;

interface LayerBase {
  readonly heightM: number;
  readonly lapse: number;
  readonly temperatureK: number;
  readonly pressurePa: number;
}

/** Base temperature and pressure of every layer, integrated once from sea level (hydrostatic, eq. 33a/b). */
const BASES: readonly LayerBase[] = LAYERS.reduce<LayerBase[]>((bases, [heightM, lapse], index) => {
  if (index === 0) return [{ heightM, lapse, temperatureK: US1976.seaLevelTemperatureK, pressurePa: US1976.seaLevelPressurePa }];
  const below = bases[index - 1] as LayerBase;
  const state = layerState(below, heightM);
  return [...bases, { heightM, lapse, temperatureK: state.temperatureK, pressurePa: state.pressurePa }];
}, []);

function layerState(base: LayerBase, heightM: number): { temperatureK: number; pressurePa: number } {
  const g0M = US1976.standardGravity / AIR_GAS_CONSTANT;
  const dh = heightM - base.heightM;
  if (base.lapse === 0) return { temperatureK: base.temperatureK, pressurePa: base.pressurePa * Math.exp((-g0M * dh) / base.temperatureK) };
  const temperatureK = base.temperatureK + base.lapse * dh;
  return { temperatureK, pressurePa: base.pressurePa * (base.temperatureK / temperatureK) ** (g0M / base.lapse) };
}

/** Geopotential altitude H = r0 Z / (r0 + Z) (eq. 18). */
export const geopotentialOf = (geometricM: number): number => (US1976.earthRadiusM * geometricM) / (US1976.earthRadiusM + geometricM);
/** Geometric altitude Z = r0 H / (r0 - H). */
export const geometricOf = (geopotentialM: number): number => (US1976.earthRadiusM * geopotentialM) / (US1976.earthRadiusM - geopotentialM);

export interface AtmosphereState {
  readonly geometricAltitudeM: number;
  readonly geopotentialAltitudeM: number;
  readonly layer: number;
  readonly temperatureK: number;
  readonly pressurePa: number;
  readonly densityKgM3: number;
  readonly speedOfSoundMS: number;
  readonly dynamicViscosityPaS: number;
  readonly kinematicViscosityM2S: number;
  /** Local gravity g0 (r0/(r0+Z))² (eq. 17). */
  readonly gravityMS2: number;
}

/** Sutherland's law μ = β T^1.5 / (T + S) (eq. 51). */
export const sutherlandViscosity = (temperatureK: number): number =>
  (US1976.sutherlandBeta * temperatureK ** 1.5) / (temperatureK + US1976.sutherlandS);

/**
 * State at a geopotential altitude; `temperatureOffsetK` shifts T at the standard pressure (ISA+ΔT day).
 * @invariant -5 km geometric <= altitude <= 84.852 km geopotential (callers check)
 */
export function atmosphereAt(geopotentialM: number, temperatureOffsetK = 0): AtmosphereState {
  const index = LAYERS.reduce((found, [heightM], candidate) => (geopotentialM >= heightM ? candidate : found), 0);
  const { temperatureK: standardK, pressurePa } = layerState(BASES[index] as LayerBase, geopotentialM);
  const temperatureK = standardK + temperatureOffsetK;
  const densityKgM3 = pressurePa / (AIR_GAS_CONSTANT * temperatureK);
  const dynamicViscosityPaS = sutherlandViscosity(temperatureK);
  const geometricAltitudeM = geometricOf(geopotentialM);
  return {
    geometricAltitudeM,
    geopotentialAltitudeM: geopotentialM,
    layer: index,
    temperatureK,
    pressurePa,
    densityKgM3,
    speedOfSoundMS: Math.sqrt(US1976.gamma * AIR_GAS_CONSTANT * temperatureK),
    dynamicViscosityPaS,
    kinematicViscosityM2S: dynamicViscosityPaS / densityKgM3,
    gravityMS2: US1976.standardGravity * (US1976.earthRadiusM / (US1976.earthRadiusM + geometricAltitudeM)) ** 2,
  };
}
