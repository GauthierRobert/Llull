/**
 * Steady-state heat loss of a pipe per metre (02 RTE §5.10): series thermal resistances of the inside film, the steel wall, the insulation and the
 * outside film (Incropera [R9]; ISO 12241 calculation rules [S34]). Pure.
 *
 * Optional refinements (CAT-FU), both off by default (then the closed form below is the answer, unchanged):
 *  - radiation: the outside film becomes h_o = h_conv + h_r with the linearised exchange with the ambient (a black-body-like surround at T_a),
 *    h_r = eps sigma (T_s + T_a)(T_s^2 + T_a^2) (kelvin), so that h_r (T_s - T_a) = eps sigma (T_s^4 - T_a^4) exactly; T_s is the outer surface temperature.
 *  - temperature-dependent insulation conductivity, linear k(T) = k_ref + b (T - T_ref): the radial layer has the exact flux with the conductivity at the mean
 *    of its two surface temperatures, k_m = k_ref + b ((T_1 + T_2) / 2 - T_ref) (a linear k gives a linear-in-T flux integral).
 *    T_s and the layer temperatures depend on Q', so the answer is the fixed point of the resistances (successive substitution, until the surface temperatures move less than 1 micro-kelvin).
 *
 *   Q' = (Ti - Ta) / [ 1/(h_i pi D0) + ln(D1/D0)/(2 pi k_s) + ln(D2/D1)/(2 pi k_ins) + 1/(h_o pi D2) ]
 *
 * D0 = inside diameter, D1 = outside diameter, D2 = D1 + 2 t_ins (D2 = D1 bare). Diameters in metres inside the formula; inputs in mm.
 */

interface HeatLossInput {
  readonly fluidTempC: number;
  readonly ambientTempC: number;
  readonly outsideDiameterMm: number;
  readonly wallMm: number;
  /** 0 = bare pipe. */
  readonly insulationThicknessMm: number;
  readonly steelConductivityWmK: number;
  /** Required when insulationThicknessMm > 0. */
  readonly insulationConductivityWmK: number;
  readonly outsideFilmWm2K: number;
  /** null = the inside film resistance is neglected (h_i -> infinity). */
  readonly insideFilmWm2K: number | null;
  /** Surface emissivity (0 to 1]: the outside film is then convection only and radiation is added. Absent = outsideFilmWm2K is the whole film. */
  readonly emissivity?: number;
  /** dk/dT of the insulation, W/(m K^2), with the temperature `conductivityRefTempC` at which `insulationConductivityWmK` holds. */
  readonly conductivitySlopeWmK2?: number;
  readonly conductivityRefTempC?: number;
}

interface HeatLossResult {
  /** Present with an emissivity: the convective and radiative parts of the outside film at the solved surface temperature, W/(m2 K). */
  readonly outsideFilm?: { readonly convectionWm2K: number; readonly radiationWm2K: number };
  /** Present with a conductivity slope: the conductivity at the mean temperature of the insulation, W/(m K). */
  readonly insulationConductivityMeanWmK?: number;
  /** Heat flowing out of the pipe per metre (negative = the pipe gains heat), W/m. */
  readonly heatLossWPerM: number;
  /** Outer surface temperature (of the insulation, or of the bare pipe), degC. */
  readonly surfaceTempC: number;
  /** Temperature of the steel wall outer surface, degC. */
  readonly steelOuterTempC: number;
  /** Resistances per metre of pipe, K m / W. */
  readonly resistances: {
    readonly inside: number;
    readonly steel: number;
    readonly insulation: number;
    readonly outside: number;
    readonly total: number;
  };
  readonly diametersMm: { readonly inside: number; readonly outside: number; readonly envelope: number };
}

const round = (value: number, digits: number): number => Math.round(value * 10 ** digits) / 10 ** digits;

/** Stefan-Boltzmann constant, W/(m2 K4) (CODATA 2018, exact since the 2019 SI). */
export const STEFAN_BOLTZMANN = 5.670374419e-8;
const KELVIN = 273.15;
const ITERATIONS = 200;
const TOLERANCE_K = 1e-6;

/** Linearised radiation coefficient to the ambient, W/(m2 K), at surface and ambient temperatures in degC. */
const radiationCoefficient = (emissivity: number, surfaceC: number, ambientC: number): number => {
  const [s, a] = [surfaceC + KELVIN, ambientC + KELVIN];
  return emissivity * STEFAN_BOLTZMANN * (s + a) * (s * s + a * a);
};

/**
 * The heat loss of one metre of pipe. Inputs are assumed valid (positive conductivities and films, wall < OD / 2, a conductivity that stays positive over the
 * insulation temperatures): the command checks them. With an emissivity and / or a conductivity slope the result is the fixed point described above.
 */
export function heatLossPerMetre(input: HeatLossInput): HeatLossResult {
  if (input.emissivity === undefined && input.conductivitySlopeWmK2 === undefined) return closedForm(input);
  return refined(input);
}

function refined(input: HeatLossInput): HeatLossResult {
  const emissivity = input.emissivity ?? 0;
  const slope = input.conductivitySlopeWmK2 ?? 0;
  const reference = input.conductivityRefTempC ?? 0;
  const insulated = input.insulationThicknessMm > 0;
  let surface = (input.fluidTempC + input.ambientTempC) / 2;
  let inner = surface;
  let result = closedForm(input);
  let film = { convectionWm2K: input.outsideFilmWm2K, radiationWm2K: 0 };
  let conductivity = input.insulationConductivityWmK;
  for (let step = 0; step < ITERATIONS; step++) {
    film = { convectionWm2K: input.outsideFilmWm2K, radiationWm2K: radiationCoefficient(emissivity, surface, input.ambientTempC) };
    conductivity = input.insulationConductivityWmK + slope * ((inner + surface) / 2 - reference);
    result = closedForm({ ...input, outsideFilmWm2K: film.convectionWm2K + film.radiationWm2K, insulationConductivityWmK: conductivity });
    const [nextSurface, nextInner] = [result.surfaceTempC, result.steelOuterTempC];
    const moved = Math.max(Math.abs(nextSurface - surface), Math.abs(nextInner - inner));
    [surface, inner] = [nextSurface, nextInner];
    if (moved < TOLERANCE_K) break;
  }
  return {
    ...result,
    ...(input.emissivity === undefined ? {} : { outsideFilm: film }),
    ...(input.conductivitySlopeWmK2 === undefined || !insulated ? {} : { insulationConductivityMeanWmK: round(conductivity, 9) }),
  };
}

function closedForm(input: HeatLossInput): HeatLossResult {
  const d0 = (input.outsideDiameterMm - 2 * input.wallMm) / 1000;
  const d1 = input.outsideDiameterMm / 1000;
  const d2 = (input.outsideDiameterMm + 2 * input.insulationThicknessMm) / 1000;
  const inside = input.insideFilmWm2K === null ? 0 : 1 / (input.insideFilmWm2K * Math.PI * d0);
  const steel = Math.log(d1 / d0) / (2 * Math.PI * input.steelConductivityWmK);
  const insulation = input.insulationThicknessMm > 0 ? Math.log(d2 / d1) / (2 * Math.PI * input.insulationConductivityWmK) : 0;
  const outside = 1 / (input.outsideFilmWm2K * Math.PI * d2);
  const total = inside + steel + insulation + outside;
  const q = (input.fluidTempC - input.ambientTempC) / total;
  return {
    heatLossWPerM: round(q, 6),
    surfaceTempC: round(input.ambientTempC + q * outside, 6),
    steelOuterTempC: round(input.ambientTempC + q * (outside + insulation), 6),
    resistances: {
      inside: round(inside, 9),
      steel: round(steel, 9),
      insulation: round(insulation, 9),
      outside: round(outside, 9),
      total: round(total, 9),
    },
    diametersMm: { inside: round(d0 * 1000, 6), outside: round(d1 * 1000, 6), envelope: round(d2 * 1000, 6) },
  };
}
