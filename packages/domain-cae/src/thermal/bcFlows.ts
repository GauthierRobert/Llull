/** Heat flow through each thermal BC from a solved temperature field (PHY-03 §5.5), in W, positive INTO the part. */

import type { FeMeshArtifact, ThermalBcRecord, ThermalSetup, UnitSystem } from '@core/model/analysis';
import { STEFAN_BOLTZMANN } from '@lib/thermalClosedForms';
import { systemToSi } from '@lib/thermalUnits';
import { analysisLengthMetres } from '../shared/defaults';
import { amplitudeAt } from './amplitude';
import { elementVolume, faceNodes, integrateFace, nodalWeights, type MeshIndex } from './meshGeometry';
import { absoluteZeroOf, inScale, siOf } from './quantities';

export interface FlowInputs {
  readonly thermal: ThermalSetup;
  readonly mesh: FeMeshArtifact;
  readonly index: MeshIndex;
  readonly unitSystem: UnitSystem;
  /** Volume of each part (analysis length unit cubed). */
  readonly volumes: ReadonlyMap<string, number>;
  /** Face node lists of each face BC, from `mesh.faceSets.B_<id>`. */
  readonly faces: ReadonlyMap<string, readonly (readonly number[])[]>;
}

export interface StepFields {
  readonly time: number;
  /** Nodal temperature (case scale). */
  readonly temperature: (node: number) => number;
  /** Nodal reaction heat flux RFL (unit system). */
  readonly reaction: (node: number) => number;
}

/** Face node lists of every face BC of the case. */
export function bcFaces(thermal: ThermalSetup, mesh: FeMeshArtifact, index: MeshIndex): Map<string, (readonly number[])[]> {
  const faces = new Map<string, (readonly number[])[]>();
  for (const id of thermal.bcOrder) {
    const key = `B_${id}`;
    const pairs = Object.hasOwn(mesh.faceSets, key) ? (mesh.faceSets[key] ?? []) : [];
    const lists: (readonly number[])[] = [];
    for (const [elementId, label] of pairs) {
      const element = index.elements.get(elementId);
      const nodes = element === undefined ? null : faceNodes(element, label);
      if (nodes !== null) lists.push(nodes);
    }
    faces.set(id, lists);
  }
  return faces;
}

const fourth = (x: number): number => x * x * x * x;

/** Amplitude factor of a record at `time` (1 without an amplitude). */
function factorOf(thermal: ThermalSetup, record: ThermalBcRecord, time: number): number {
  const amplitude =
    record.amplitude === undefined || !Object.hasOwn(thermal.amplitudes, record.amplitude)
      ? undefined
      : thermal.amplitudes[record.amplitude];
  return amplitude === undefined ? 1 : amplitudeAt(amplitude.points, time);
}

/**
 * Heat flow (W) of one BC at one result time: prescribed temperature = sum of RFL over its nodes; film = integral h (T_sink - T) dA;
 * radiation = integral e sigma (theta_sink^4 - theta^4) dA on absolute temperature; surface flux = q A; generation = q''' V (or the total);
 * concentrated flux = Q per node. Applied values are scaled by the amplitude at `time` (steady: factor 1).
 */
export function bcFlowW(inputs: FlowInputs, record: ThermalBcRecord, step: StepFields, steady: boolean): number {
  const { thermal, unitSystem } = inputs;
  const bc = record.bc;
  const length = analysisLengthMetres(unitSystem);
  const factor = steady ? 1 : factorOf(thermal, record, step.time);
  const scale = thermal.temperatureScale;
  const zero = absoluteZeroOf(scale);
  const faces = inputs.faces.get(record.id) ?? [];
  const nodes = (): readonly number[] => {
    const key = `B_${record.id}`;
    return Object.hasOwn(inputs.mesh.nodeSets, key) ? (inputs.mesh.nodeSets[key] ?? []) : [];
  };
  const faceSum = (g: (temperature: number) => number): number =>
    faces.reduce((sum, face) => sum + integrateFace(inputs.index, face, step.temperature, g).integral, 0) * length * length;
  switch (bc.kind) {
    case 'temperature':
      return nodes().reduce((sum, node) => sum + systemToSi('power', step.reaction(node), unitSystem), 0);
    case 'film': {
      if (!('value' in bc.filmCoefficient)) return 0;
      const h = siOf('film', bc.filmCoefficient);
      const sink = inScale(bc.sinkTemperature, scale) * factor;
      return faceSum((temperature) => h * (sink - temperature));
    }
    case 'radiation': {
      const sink = inScale(bc.sinkTemperature, scale) * factor - zero;
      const emissivity = typeof bc.emissivity === 'number' ? bc.emissivity : 0;
      return faceSum((temperature) => emissivity * STEFAN_BOLTZMANN * (fourth(sink) - fourth(temperature - zero)));
    }
    case 'surface_flux':
      return siOf('flux', bc.value) * factor * faceSum(() => 1);
    case 'concentrated_flux':
      return siOf('power', bc.value) * factor * nodes().length;
    case 'heat_generation': {
      if (bc.mode === 'total') return siOf('power', bc.value) * factor;
      return siOf('generation', bc.value) * factor * (inputs.volumes.get(bc.entityId) ?? 0) * length ** 3;
    }
  }
}

/** Share of each node of a face in a constant integrand over it (linear triangle: A/3 each; quadratic: the mid-side nodes A/3, corners 0). */
function faceNodeShares(index: MeshIndex, nodes: readonly number[]): number[] {
  const { area } = integrateFace(
    index,
    nodes,
    () => 0,
    () => 1,
  );
  return nodes.map((_, i) => (nodes.length === 3 || i >= 3 ? area / 3 : 0));
}

/**
 * Heat (W, positive into the part) the load BC `record` applies at each node, as the solver assembles it: faces by the node shares of the face
 * (film and radiation evaluated at the nodal temperature), generation by the element quadrature weights, point flux at its nodes.
 * Temperature BCs apply no load.
 */
export function nodalLoadsW(inputs: FlowInputs, record: ThermalBcRecord, step: StepFields, steady: boolean): Map<number, number> {
  const { thermal, unitSystem, index } = inputs;
  const bc = record.bc;
  const loads = new Map<number, number>();
  const add = (node: number, watts: number): void => void loads.set(node, (loads.get(node) ?? 0) + watts);
  const length = analysisLengthMetres(unitSystem);
  const factor = steady ? 1 : factorOf(thermal, record, step.time);
  const scale = thermal.temperatureScale;
  const zero = absoluteZeroOf(scale);
  const faceLoads = (perArea: (temperature: number) => number): void => {
    for (const face of inputs.faces.get(record.id) ?? []) {
      const shares = faceNodeShares(index, face);
      face.forEach((node, i) => add(node, (shares[i] ?? 0) * length * length * perArea(step.temperature(node))));
    }
  };
  switch (bc.kind) {
    case 'film': {
      if (!('value' in bc.filmCoefficient)) return loads;
      const h = siOf('film', bc.filmCoefficient);
      const sink = inScale(bc.sinkTemperature, scale) * factor;
      faceLoads((temperature) => h * (sink - temperature));
      break;
    }
    case 'radiation': {
      const sink = inScale(bc.sinkTemperature, scale) * factor - zero;
      const emissivity = typeof bc.emissivity === 'number' ? bc.emissivity : 0;
      faceLoads((temperature) => emissivity * STEFAN_BOLTZMANN * (fourth(sink) - fourth(temperature - zero)));
      break;
    }
    case 'surface_flux':
      faceLoads(() => siOf('flux', bc.value) * factor);
      break;
    case 'concentrated_flux':
      for (const node of Object.hasOwn(inputs.mesh.nodeSets, `B_${record.id}`) ? (inputs.mesh.nodeSets[`B_${record.id}`] ?? []) : [])
        add(node, siOf('power', bc.value) * factor);
      break;
    case 'heat_generation': {
      const volume = inputs.volumes.get(bc.entityId) ?? 0;
      const density =
        bc.mode === 'total' ? (volume > 0 ? siOf('power', bc.value) / (volume * length ** 3) : 0) : siOf('generation', bc.value);
      for (const element of index.elements.values()) {
        if (element.entityId !== bc.entityId) continue;
        const weights = nodalWeights(element, elementVolume(index, element));
        element.nodes.forEach((node, i) => add(node, density * factor * (weights[i] ?? 0) * length ** 3));
      }
      break;
    }
    case 'temperature':
      break;
  }
  return loads;
}
