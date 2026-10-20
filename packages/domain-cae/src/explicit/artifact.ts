/**
 * The `fe_explicit` artifact built from the `llull-compute explicit` outputs (`result.json` + `fields.f64`) and the summary recorded in the
 * document, recomputed from that artifact on every read (05 §4.1 trust model).
 */

import type { AnalysisCase } from '@core/model/analysis';
import type {
  ExplicitEnergyRow,
  ExplicitExtreme,
  ExplicitResultsSummary,
  ExplicitWallHistory,
  FeExplicitArtifact,
} from '@core/model/explicit';
import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import { explicitMaterial } from './laws';
import { supportedUnits } from './model';
import type { ExplicitJob } from './job';

/** Values per element in `fields.f64`: von Mises, equivalent plastic strain, failed flag, centroid x, y, z. */
const FIELD_STRIDE = 6;

const isNumberList = (value: unknown): value is number[] => Array.isArray(value) && value.every((entry) => typeof entry === 'number');

function energyRows(value: unknown): ExplicitEnergyRow[] | null {
  if (!Array.isArray(value)) return null;
  const rows: ExplicitEnergyRow[] = [];
  for (const row of value) {
    if (!isNumberList(row) || row.length !== 7) return null;
    const [t = 0, kinetic = 0, internal = 0, hourglass = 0, wall = 0, contact = 0, externalWork = 0] = row;
    rows.push({ t, kinetic, internal, hourglass, wall, contact, externalWork });
  }
  return rows;
}

function wallHistories(value: unknown): ExplicitWallHistory[] | null {
  if (!Array.isArray(value)) return null;
  const walls: ExplicitWallHistory[] = [];
  for (const wall of value) {
    if (!isRecord(wall) || typeof wall['name'] !== 'string' || !isNumberList(wall['t']) || !isNumberList(wall['force'])) return null;
    if (wall['t'].length !== wall['force'].length) return null;
    walls.push({ name: wall['name'], t: wall['t'], force: wall['force'] });
  }
  return walls;
}

/**
 * The artifact of one run.
 * @failure result.json not matching the job contract, or a fields array of the wrong length -> explanation string
 */
export function buildExplicitArtifact(
  job: ExplicitJob,
  resultText: string,
  fields: Float64Array,
  version: string,
): FeExplicitArtifact | string {
  let value: unknown;
  try {
    value = JSON.parse(resultText);
  } catch {
    return 'result.json is not JSON';
  }
  if (!isRecord(value)) return 'result.json is not an object';
  const { termination, message, cycles, finalTime, minTimeStep, initialMass, addedMass, device, deterministic } = value;
  const energy = energyRows(value['energy']);
  const walls = wallHistories(value['walls']);
  if (
    (termination !== 'normal' && termination !== 'abnormal') ||
    typeof cycles !== 'number' ||
    typeof finalTime !== 'number' ||
    typeof minTimeStep !== 'number' ||
    typeof initialMass !== 'number' ||
    typeof addedMass !== 'number' ||
    (device !== 'cpu' && device !== 'gpu') ||
    typeof deterministic !== 'boolean' ||
    energy === null ||
    energy.length === 0 ||
    walls === null
  )
    return 'result.json lacks termination, cycles, finalTime, minTimeStep, masses, device, deterministic, energy or walls';
  const hex8 = job.mesh.hex8.length / 8;
  const tet4 = job.mesh.tet4.length / 4;
  const shell4 = job.mesh.shell4.length / 4;
  const count = hex8 + tet4 + shell4;
  if (fields.length !== FIELD_STRIDE * count) return `fields.f64 holds ${fields.length} values, expected ${FIELD_STRIDE * count}`;
  const column = (offset: number): number[] => Array.from({ length: count }, (_, element) => fields[FIELD_STRIDE * element + offset] ?? 0);
  const centroids: number[] = [];
  for (let element = 0; element < count; element++)
    for (let axis = 0; axis < 3; axis++) centroids.push(fields[FIELD_STRIDE * element + 3 + axis] ?? 0);
  return {
    kind: 'fe_explicit',
    inputHash: job.inputHash,
    unitSystem: job.unitSystem,
    solver: { job: 'explicit', name: 'llull-explicit', version, device, deterministic },
    termination,
    message: typeof message === 'string' ? message : '',
    cycles,
    finalTimeS: finalTime,
    minTimeStepS: minTimeStep,
    initialMass,
    addedMass,
    elements: { hex8, tet4, shell4 },
    energy,
    walls,
    vonMises: column(0),
    plasticStrain: column(1),
    failed: column(2),
    centroids,
  };
}

const TINY = 1e-30;

/** Largest value, 0 for an empty list (no spread: histories can be long). */
const maxOf = (values: readonly number[]): number => values.reduce((largest, value) => Math.max(largest, value), 0);

function extreme(values: readonly number[], centroids: readonly number[], unit: string): ExplicitExtreme {
  let element = 0;
  for (let index = 1; index < values.length; index++) if ((values[index] ?? 0) > (values[element] ?? 0)) element = index;
  return {
    value: values[element] ?? 0,
    unit,
    at: [centroids[3 * element] ?? 0, centroids[3 * element + 1] ?? 0, centroids[3 * element + 2] ?? 0],
    element,
  };
}

/** Energy error of one sample (TR-EXP-40 with the stonewall term). */
export const energyError = (row: ExplicitEnergyRow, initialKinetic: number): number =>
  (row.kinetic + row.internal + row.hourglass + row.wall + row.contact - initialKinetic - row.externalWork) /
  Math.max(Math.abs(initialKinetic + row.externalWork), TINY);

/** Unverified reasons of the current materials of the case (the summary flags them). */
function unverifiedReasons(doc: CadDocument, analysisCase: AnalysisCase): string[] {
  const reasons = Object.keys(analysisCase.parts)
    .sort()
    .flatMap((entityId) => {
      const material = explicitMaterial(doc, analysisCase, entityId);
      return 'code' in material ? [] : material.unverifiedReasons;
    });
  return [...new Set(reasons)];
}

/**
 * The summary the document records for `artifact` (stored under `artifactHash`).
 * @failure a case whose unit system the solver does not support -> explanation string
 */
export function explicitSummary(
  doc: CadDocument,
  analysisCase: AnalysisCase,
  artifact: FeExplicitArtifact,
  artifactHash: string,
): ExplicitResultsSummary | string {
  const units = supportedUnits(analysisCase);
  if (units === null) return `unit system ${analysisCase.unitSystem} is not supported`;
  const first = artifact.energy[0];
  const last = artifact.energy[artifact.energy.length - 1];
  if (first === undefined || last === undefined) return 'the artifact has no energy history';
  const initialKinetic = first.kinetic;
  const errors = artifact.energy.map((row) => energyError(row, initialKinetic));
  const hourglassRatioMax = maxOf(
    artifact.energy.map((row) => (Math.abs(row.internal) > TINY ? row.hourglass / Math.abs(row.internal) : 0)),
  );
  const walls = Object.fromEntries(
    artifact.walls.map((wall) => {
      let impulse = 0;
      let previous = 0;
      wall.t.forEach((time, index) => {
        impulse += (wall.force[index] ?? 0) * (time - previous);
        previous = time;
      });
      return [wall.name, { peakForce: maxOf(wall.force), impulse, forceUnit: units.force }] as const;
    }),
  );
  const reasons = unverifiedReasons(doc, analysisCase);
  return {
    artifactHash,
    inputHash: artifact.inputHash,
    solver: artifact.solver,
    termination: artifact.termination,
    cycles: artifact.cycles,
    finalTimeS: artifact.finalTimeS,
    minTimeStepS: artifact.minTimeStepS,
    elements: artifact.elements,
    energyUnit: units.energy,
    energy: {
      initialKinetic,
      finalKinetic: last.kinetic,
      finalInternal: last.internal,
      finalHourglass: last.hourglass,
      finalWall: last.wall,
      finalContact: last.contact,
      externalWork: last.externalWork,
      errorFinal: errors[errors.length - 1] ?? 0,
      errorMaxAbs: maxOf(errors.map(Math.abs)),
      hourglassRatioMax,
      contactRatioMax: maxOf(
        artifact.energy.map((row) => (Math.abs(row.internal) > TINY ? Math.abs(row.contact) / Math.abs(row.internal) : 0)),
      ),
      addedMassRatio: artifact.initialMass > 0 ? artifact.addedMass / artifact.initialMass : 0,
    },
    maxVonMises: extreme(artifact.vonMises, artifact.centroids, units.stress),
    maxPlasticStrain: extreme(artifact.plasticStrain, artifact.centroids, '-'),
    failedElements: artifact.failed.filter((flag) => flag > 0).length,
    walls,
    unverified: reasons.length > 0,
    unverifiedReasons: reasons,
    reviewRequired: true,
    certificationEvidence: false,
  };
}
