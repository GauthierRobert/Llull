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

/** Vacuum permeability N/A^2, the classical 4 pi 1e-7 (the CODATA 2018 value differs by 5.5e-10 relative, far below the checks' tolerances). */
export const MU_0 = 4 * Math.PI * 1e-7;

/** Skin depth, m: delta = sqrt(rho / (pi f mu0 mur)) = sqrt(2 rho / (omega mu)). */
export const skinDepth = (resistivity: number, frequencyHz: number, mur: number): number =>
  Math.sqrt(resistivity / (Math.PI * frequencyHz * MU_0 * mur));

/** Absorption loss of a conducting sheet, dB: A = 20 log10(e) t / delta (the field decays as exp(-t / delta)); reflection loss not included. */
export const absorptionLossDb = (thickness: number, depth: number): number => (20 * Math.LOG10E * thickness) / depth;

/** Normal-incidence reflectance R = ((n1 - n2)^2 + k^2) / ((n1 + n2)^2 + k^2) at an interface (k = extinction coefficient of medium 2, 0 for a lossless one). */
export const normalReflectance = (n1: number, n2: number, k = 0): number => ((n1 - n2) ** 2 + k ** 2) / ((n1 + n2) ** 2 + k ** 2);

/** Transmittance of a lossless slab with incoherent multiple reflections: T = (1 - R) / (1 + R). */
export const slabTransmittance = (reflectance: number): number => (1 - reflectance) / (1 + reflectance);
