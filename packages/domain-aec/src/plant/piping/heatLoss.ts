/**
 * Steady-state heat loss of a pipe per metre (02 RTE §5.10): series thermal resistances of the inside film, the steel wall, the insulation and the
 * outside film (Incropera [R9]; ISO 12241 calculation rules [S34]). Radiation and temperature-dependent conductivity are not modelled. Pure.
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
}

interface HeatLossResult {
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

/** The heat loss of one metre of pipe. Inputs are assumed valid (positive conductivities and films, wall < OD / 2): the command checks them. */
export function heatLossPerMetre(input: HeatLossInput): HeatLossResult {
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
