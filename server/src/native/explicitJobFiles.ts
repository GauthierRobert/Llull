/**
 * `llull-compute explicit` job folder of an explicit case (contract: solver/crates/llull-explicit/src/job.rs). Values are in the case unit
 * system (consistent units; the solver does not convert). Index conventions: node `n` owns `nodes[3n..3n+3]`; hex8 elements first, then tet4.
 */

import { endianness } from 'node:os';
import type { ExplicitJob } from '@cae/index';
import { f64Bytes } from './computeJob';

export type ExplicitDevice = 'cpu' | 'gpu' | 'auto';

/** Most cycles a job may take before it stops with an abnormal termination (named guard against a collapsing time step). */
const MAX_CYCLES = 50_000_000;

function u32Bytes(values: readonly number[]): Buffer {
  if (endianness() !== 'LE') throw new Error('llull-compute job files are little-endian; this platform is not');
  const array = Uint32Array.from(values);
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

/** The files of the job folder (`job.json` + the binary arrays). */
export function explicitJobFiles(job: ExplicitJob, device: ExplicitDevice): Record<string, Buffer | string> {
  const { spec, mesh } = job;
  const files: Record<string, Buffer | string> = {
    'nodes.f64': f64Bytes(Float64Array.from(mesh.nodes)),
    'elmat.u32': u32Bytes(job.elementMaterial),
    'velocity.f64': f64Bytes(Float64Array.from(job.initialVelocity)),
  };
  if (mesh.hex8.length > 0) files['hex8.u32'] = u32Bytes(mesh.hex8);
  if (mesh.tet4.length > 0) files['tet4.u32'] = u32Bytes(mesh.tet4);
  files['job.json'] = JSON.stringify({
    version: 1,
    nodes: 'nodes.f64',
    ...(mesh.hex8.length > 0 ? { hex8: 'hex8.u32' } : {}),
    ...(mesh.tet4.length > 0 ? { tet4: 'tet4.u32' } : {}),
    elementMaterial: 'elmat.u32',
    initialVelocity: 'velocity.f64',
    materials: job.materials.map((material) => ({
      density: material.density,
      youngsModulus: material.E,
      poisson: material.nu,
      ...(material.johnsonCook !== undefined
        ? {
            johnsonCook: {
              a: material.johnsonCook.A,
              b: material.johnsonCook.B,
              n: material.johnsonCook.n,
              c: material.johnsonCook.C,
              referenceRate: material.johnsonCook.referenceRate,
              m: material.johnsonCook.m,
              meltK: material.johnsonCook.meltK,
              transitionK: material.johnsonCook.transitionK,
            },
          }
        : {}),
    })),
    gravity: job.gravity,
    walls: job.walls,
    controls: {
      endTime: spec.endTimeS,
      historyInterval: spec.historyIntervalS,
      timeStepScale: spec.timeStepScale.value,
      ...(spec.minTimeStepS !== undefined ? { minTimeStep: spec.minTimeStepS } : {}),
      hourglassCoefficient: spec.hourglassCoefficient.value,
      bulkLinear: spec.bulkViscosity.linear.value,
      bulkQuadratic: spec.bulkViscosity.quadratic.value,
      ...(spec.massScaling.mode === 'selective'
        ? { massScaling: { targetTimeStep: spec.massScaling.targetTimeStepS, maxAddedMassRatio: spec.massScaling.maxAddedMassRatio } }
        : {}),
      maxCycles: MAX_CYCLES,
    },
    device,
  });
  return files;
}
