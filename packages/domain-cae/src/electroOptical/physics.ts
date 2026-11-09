/** Closed forms of the electro-optical checks (PHY-15 §5.2), pure; the same expressions as validation/generate_eop_reference.py. */

/** Exact SI constants (2019 redefinition): J/K, J s, m/s. */
const BOLTZMANN = 1.380649e-23;
const PLANCK = 6.62607015e-34;
const LIGHT = 299792458;

/** Stefan-Boltzmann constant sigma = 2 pi^5 k^4 / (15 h^3 c^2), W/(m^2 K^4), from the exact constants. */
export const STEFAN_BOLTZMANN = (2 * Math.PI ** 5 * BOLTZMANN ** 4) / (15 * PLANCK ** 3 * LIGHT ** 2);

/** Bulk resistance R = rho L / A (ohm, ohm m, m, m^2). */
export const bulkResistance = (resistivity: number, length: number, area: number): number => (resistivity * length) / area;

/** Equilibrium temperature of a flat plate, K: alpha S cos(theta) = n eps sigma T^4 (n radiating faces; no conduction, albedo or planet IR). */
export const equilibriumTemperature = (alpha: number, flux: number, incidenceRad: number, epsilon: number, faces: 1 | 2): number =>
  ((alpha * flux * Math.cos(incidenceRad)) / (faces * epsilon * STEFAN_BOLTZMANN)) ** 0.25;
