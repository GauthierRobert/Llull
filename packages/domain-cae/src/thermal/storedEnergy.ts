/** Stored thermal energy of a temperature field (transient heat balance, PHY-03 §5.5): E = integral of rho * enthalpy(T) dV. */

import { nodalWeights, elementVolume, type MeshIndex } from './meshGeometry';
import { valueAt, type PropertyTable } from './material';

export type Enthalpy = (temperature: number) => number;

/**
 * Volumetric enthalpy H(T) = integral of rho(tau) cp(tau) d tau from the lowest table temperature, for tables that the solver reads
 * piecewise-linearly with end values held (exact: Simpson on each interval between table temperatures, where the product is quadratic).
 */
export function enthalpyFunction(density: PropertyTable, specificHeat: PropertyTable): Enthalpy {
  const product = (temperature: number): number => valueAt(density, temperature, 0) * valueAt(specificHeat, temperature, 0);
  const breaks = [...new Set([...density.points, ...specificHeat.points].map(([t]) => t))].sort((a, b) => a - b);
  const first = breaks[0];
  const last = breaks[breaks.length - 1];
  if (first === undefined || last === undefined) return (temperature) => product(0) * temperature;
  const simpson = (a: number, b: number): number => ((b - a) / 6) * (product(a) + 4 * product((a + b) / 2) + product(b));
  const cumulative = breaks.reduce<number[]>(
    (sums, t, i) => [...sums, i === 0 ? 0 : (sums[i - 1] ?? 0) + simpson(breaks[i - 1] ?? t, t)],
    [],
  );
  return (temperature) => {
    if (temperature <= first) return product(first) * (temperature - first);
    if (temperature >= last) return (cumulative[cumulative.length - 1] ?? 0) + product(last) * (temperature - last);
    const upper = breaks.findIndex((t) => t >= temperature);
    const lower = breaks[upper - 1] ?? first;
    return (cumulative[upper - 1] ?? 0) + simpson(lower, temperature);
  };
}

/** Energy (unit-system energy) each node carries: the node's quadrature weights times the enthalpy of its part; nodes of other parts are absent. */
export function nodalEnergy(
  index: MeshIndex,
  enthalpies: ReadonlyMap<string, Enthalpy>,
  temperature: (node: number) => number,
): Map<number, number> {
  const energy = new Map<number, number>();
  for (const element of index.elements.values()) {
    const enthalpy = enthalpies.get(element.entityId);
    if (enthalpy === undefined) continue;
    const weights = nodalWeights(element, elementVolume(index, element));
    element.nodes.forEach((node, i) => energy.set(node, (energy.get(node) ?? 0) + (weights[i] ?? 0) * enthalpy(temperature(node))));
  }
  return energy;
}
