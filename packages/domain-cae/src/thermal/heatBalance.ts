/** Per-BC heat flows and the heat balance of a solved heat_* case (PHY-03 §5.5, TR-THM-31). */

import type { FeMeshArtifact, FeResultsArtifact, ThermalResultsSummary } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { systemToSi } from '@lib/thermalUnits';
import type { ThermalCase } from './access';
import { bcFaces, bcFlowW, nodalLoadsW, type FlowInputs, type StepFields } from './bcFlows';
import { caseTemperatureRange, partMaterials, propertyTable } from './material';
import { partVolumes, type MeshIndex } from './meshGeometry';
import { inScale } from './quantities';
import { enthalpyFunction, nodalEnergy, type Enthalpy } from './storedEnergy';

type Step = FeResultsArtifact['steps'][number];

/** Nodal accessor of the first component of `name` in `step`; NaN where the node has no value. */
export function nodal(step: Step, name: string): (node: number) => number {
  const field = Object.hasOwn(step.fields, name) ? step.fields[name] : undefined;
  return (node) =>
    field !== undefined && Object.hasOwn(field.values, String(node)) ? (field.values[String(node)]?.[0] ?? Number.NaN) : Number.NaN;
}

/** Enthalpy functions of the parts of a transient case; parts whose cp or density cannot be read are left out. */
function partEnthalpies(doc: CadDocument, found: ThermalCase): Map<string, Enthalpy> {
  const { analysisCase, thermal } = found;
  const required = caseTemperatureRange(thermal);
  const map = new Map<string, Enthalpy>();
  for (const part of partMaterials(doc, analysisCase)) {
    if (part.material === null) continue;
    const request = {
      materialName: part.materialId,
      material: part.material,
      documentUnit: doc.units,
      scale: thermal.temperatureScale,
      unitSystem: analysisCase.unitSystem,
      required,
    };
    const density = propertyTable({ ...request, property: 'density' });
    const heat = propertyTable({ ...request, property: 'cp' });
    if (!('code' in density) && !('code' in heat)) map.set(part.entityId, enthalpyFunction(density, heat));
  }
  return map;
}

export interface FlowsAndBalance {
  readonly flows: ThermalResultsSummary['bcHeatFlowsW'];
  readonly balance: ThermalResultsSummary['heatBalance'];
}

/**
 * Flows of every BC at every result time and the balance at the last one. A prescribed temperature's flow is the sum of RFL over its nodes
 * minus the loads (generation, fluxes, film, radiation) applied at those same nodes, which CalculiX's reaction (conduction only) leaves in,
 * plus (transient) the energy rate of those nodes themselves, which it also leaves out. Stored power is the energy change of the whole body since the previous result time (the initial temperature for the first).
 * Measured on ccx 2.21 with results written at every increment: constant boundaries balance to 1e-3; a boundary driven by an amplitude
 * (NAFEMS T3) leaves about 6 % that the solver's treatment of the prescribed nodes does not close. With several increments per result
 * interval the end-of-interval flows no longer match the energy change over it (the residual grows): write results at every increment to
 * judge a transient balance.
 */
export function flowsAndBalance(
  doc: CadDocument,
  found: ThermalCase,
  mesh: FeMeshArtifact,
  index: MeshIndex,
  steps: readonly Step[],
  timeOf: (step: Step) => number,
): FlowsAndBalance {
  const { analysisCase, thermal } = found;
  const steady = analysisCase.type === 'heat_steady';
  const unitSystem = analysisCase.unitSystem;
  const inputs: FlowInputs = { thermal, mesh, index, unitSystem, volumes: partVolumes(index), faces: bcFaces(thermal, mesh, index) };
  const records = thermal.bcOrder.flatMap((id) =>
    Object.hasOwn(thermal.bcs, id) && thermal.bcs[id] !== undefined ? [thermal.bcs[id]] : [],
  );
  const enthalpies = steady ? new Map<string, Enthalpy>() : partEnthalpies(doc, found);
  const initial = thermal.initialTemperature;
  const energies = steps.map((step) => (enthalpies.size === 0 ? null : nodalEnergy(index, enthalpies, nodal(step, 'NDTEMP'))));
  const start =
    initial !== undefined && enthalpies.size > 0 ? nodalEnergy(index, enthalpies, () => inScale(initial, thermal.temperatureScale)) : null;
  const total = (energy: Map<number, number>): number => [...energy.values()].reduce((sum, value) => sum + value, 0);

  const flows: ThermalResultsSummary['bcHeatFlowsW'][number][] = [];
  const rows: number[][] = [];
  let storedW = 0;
  steps.forEach((step, k) => {
    const fields: StepFields = { time: step.time, temperature: nodal(step, 'NDTEMP'), reaction: (node) => nodal(step, 'RFL')(node) || 0 };
    const before = k === 0 ? start : energies[k - 1];
    const now = energies[k];
    const dt = step.time - (k === 0 ? 0 : (steps[k - 1]?.time ?? 0));
    const rate = (nodes: readonly number[]): number =>
      before == null || now == null || !(dt > 0)
        ? 0
        : systemToSi('power', nodes.reduce((sum, node) => sum + ((now.get(node) ?? 0) - (before.get(node) ?? 0)), 0) / dt, unitSystem);
    const applied = new Map<number, number>();
    for (const record of records)
      for (const [node, watts] of nodalLoadsW(inputs, record, fields, steady)) applied.set(node, (applied.get(node) ?? 0) + watts);
    records.forEach((record, i) => {
      const key = `B_${record.id}`;
      const nodes = record.bc.kind === 'temperature' && Object.hasOwn(mesh.nodeSets, key) ? (mesh.nodeSets[key] ?? []) : [];
      const absorbed = nodes.reduce((sum, node) => sum + (applied.get(node) ?? 0), 0);
      const value = bcFlowW(inputs, record, fields, steady) - absorbed + rate(nodes);
      flows.push({ bcId: record.id, timeS: timeOf(step), valueW: value });
      (rows[k] ??= [])[i] = value;
    });
    if (k === steps.length - 1 && before != null && now != null && dt > 0)
      storedW = systemToSi('power', (total(now) - total(before)) / dt, unitSystem);
  });
  const lastRow = rows[rows.length - 1] ?? [];
  const inW = lastRow.filter((v) => v > 0).reduce((a, b) => a + b, 0);
  const outW = -lastRow.filter((v) => v < 0).reduce((a, b) => a + b, 0);
  const last = steps[steps.length - 1];
  const residualRel = Math.abs(inW - outW - storedW) / Math.max(inW, outW, 1e-30);
  return { flows, balance: { inW, outW, storedW, residualRel, timeS: last === undefined ? 0 : timeOf(last) } };
}
