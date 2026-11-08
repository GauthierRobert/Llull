/** Params schema of a study as the host transport reports it to `record_convergence_study` (never hand-written), and its conversion to the stored form. */

import type { MeshControls } from '@core/model/analysis';
import type { StudyLevel } from '@core/model/convergenceStudy';
import { z } from '@core/commands/schema';
import { feaTargetSchema, toTarget } from '../shared/target';

const meshControlsShape = z
  .object({
    mesher: z.literal('netgen').describe("The mesher: 'netgen'."),
    elementFamily: z
      .enum(['tet', 'tri', 'quad', 'shell_quad', 'shell_tri', 'hex_dominant'])
      .describe('Element family the level was meshed with.'),
    order: z.union([z.literal(1), z.literal(2)]).describe('Element order of the level: 1 or 2.'),
    globalSize: z.number().positive().describe('Global element size of the level, document units.'),
    minSize: z.number().positive().optional().describe('Smallest element size of the level, document units.'),
    refinements: z
      .array(
        z.object({
          target: feaTargetSchema.describe('Refinement target.'),
          size: z.number().positive().describe('Refinement size of the level, document units.'),
        }),
      )
      .describe('Local refinements of the level (sizes scaled with the level).'),
    optimize: z.enum(['default', 'netgen', 'high_order', 'none']).describe('Mesh optimisation pass.'),
    bonding: z.literal('conformal').optional().describe('Present only for conformal bonding of touching parts.'),
    source: z.literal('implicit_field').optional().describe('Present only when implicit bodies were meshed from their field.'),
  })
  .describe('The mesh controls exactly as the level was meshed (the case controls with globalSize and refinement sizes scaled).');

export const studyLevelShape = z.object({
  controls: meshControlsShape,
  elements: z.number().int().positive().describe('Number of tetrahedra of the level mesh.'),
  h: z.number().positive().describe('Representative spacing (volume / elements)^(1/3) of the level, analysis length unit.'),
  value: z.number().describe('The followed quantity at this level, in the quantity unit.'),
  meshHash: z.string().describe('sha256 of the level mesh artifact (fea_mesh).'),
  resultsHash: z.string().describe('sha256 of the level results artifact (fea_solve).'),
  inputHash: z.string().describe('Full input hash of the level (the results artifact inputHash).'),
  solver: z.string().describe('Solver name of the results artifact.'),
  solverVersion: z.string().describe('Solver version of the results artifact.'),
  mesher: z.string().describe('Mesher name of the mesh artifact.'),
  mesherVersion: z.string().describe('Mesher version of the mesh artifact.'),
});

type LevelInput = z.output<typeof studyLevelShape>;

/** The stored level: optional selectors absent (never undefined), refinement targets plain `FeaTarget`s. */
export function toStudyLevel(input: LevelInput, index: number): StudyLevel<MeshControls> {
  const { controls } = input;
  return {
    index,
    controls: {
      mesher: controls.mesher,
      elementFamily: controls.elementFamily,
      order: controls.order,
      globalSize: controls.globalSize,
      refinements: controls.refinements.map((refinement) => ({ target: toTarget(refinement.target), size: refinement.size })),
      optimize: controls.optimize,
      ...(controls.minSize !== undefined ? { minSize: controls.minSize } : {}),
      ...(controls.bonding !== undefined ? { bonding: controls.bonding } : {}),
      ...(controls.source !== undefined ? { source: controls.source } : {}),
    },
    elements: input.elements,
    h: input.h,
    value: input.value,
    meshHash: input.meshHash,
    resultsHash: input.resultsHash,
    inputHash: input.inputHash,
    solver: input.solver,
    solverVersion: input.solverVersion,
    mesher: input.mesher,
    mesherVersion: input.mesherVersion,
  };
}
