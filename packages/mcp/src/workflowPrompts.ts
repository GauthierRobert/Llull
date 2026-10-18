/**
 * Workflow prompts for the analysis, dynamics and piping toolsets: which tools, in which order, with the
 * parameters that matter. Every backticked name is a real tool or parameter (guarded by tests/unit/mcp-tools.test.ts).
 */
import { conversation, type McpPromptDescriptor, type PromptTemplate } from './promptTypes';

const briefArgument = (example: string): NonNullable<McpPromptDescriptor['arguments']> => [
  { name: 'brief', description: example, required: false },
];

const feaStaticCheck: PromptTemplate = {
  descriptor: {
    name: 'fea_static_check',
    description:
      'Workflow for a linear static finite-element check of one solid: analysis set-up, constraint, load, mesh, solve, stress plot and ' +
      'margins. Results are computed by llull and are not approved.',
    arguments: briefArgument('The check, e.g. "cantilever bracket box-1 loaded 500 N at the tip".'),
  },
  buildMessages({ brief = 'a bracket fixed at one end and loaded at the other' }) {
    return conversation(
      `Run a static FEA check on ${brief} in llull.`,
      `**Static FEA workflow (enable the analysis toolset first: \`enable_toolset\` { toolset: "analysis" })**\n\n` +
        `1. Part: the solid must exist and have a material (\`assign_material\`); then \`create_analysis\` { name, analysisType: "static" } and \`set_part_idealization\` to add the solid to it.\n` +
        `2. Support: \`add_fea_constraint\` { analysisId, name, kind: "fixed", target: { entityId, facesNear: [[x, y, z]] } } — facesNear points pick the nearest face.\n` +
        `3. Load: \`add_fea_load\` { analysisId, name, kind: "force", target, vector | magnitude } (or "pressure" / "gravity").\n` +
        `4. Mesh and solve: \`fea_mesh\` { analysisId }, then \`fea_solve\` { analysisId }; read the summary for convergence and warnings.\n` +
        `5. Look: \`render_fea_results\` { analysisId, field } for the stress or displacement plot; \`fea_report\` for the numbers.\n` +
        `6. Verify: \`check_analysis\` { analysisId }, \`compute_margins\` against an allowable, and a hand estimate with \`compare_to_expected\`.\n\n` +
        `Say that the results are computed by llull, are NOT approved, and depend on mesh density: refine with \`set_mesh_controls\` and re-solve to check convergence.`,
    );
  },
};

const dynamicsSimulation: PromptTemplate = {
  descriptor: {
    name: 'dynamics_simulation',
    description:
      'Workflow for a rigid-body dynamics simulation: bodies, joints, motor or load, gravity, simulate and plot. Read-back is computed by llull.',
    arguments: briefArgument('The mechanism, e.g. "pendulum arm swinging under gravity".'),
  },
  buildMessages({ brief = 'a pendulum arm swinging under gravity' }) {
    return conversation(
      `Simulate ${brief} in llull.`,
      `**Dynamics workflow (enable the assembly toolset first: \`enable_toolset\` { toolset: "assembly" })**\n\n` +
        `1. Geometry: model each part as a solid first (\`add_box\`, \`add_cylinder\`, ...).\n` +
        `2. Bodies: \`add_rigid_body\` { entityIds, name, density | massKg, fixed } — one fixed body is the ground.\n` +
        `3. Joints: \`add_body_joint\` { kind: "revolute" | "prismatic", child, parent, anchor, axis }; omit \`parent\` to pin to the world.\n` +
        `4. Drive: \`add_motor\` { joint, kind: "speed", rpm } or add \`add_spring\` / \`add_propeller\`; \`set_gravity\` { gravity } if it is not the default.\n` +
        `5. Check: \`inspect_dynamics\` { mobility: true } for degrees of freedom before simulating.\n` +
        `6. Run: \`simulate_motion\` { duration, timestep } and read the summary; \`plot_simulation\` { quantities } for curves; \`render_motion\` for the frames.\n\n` +
        `Keep durations short at first (a few seconds, small \`timestep\`) and only increase them once the mechanism behaves.`,
    );
  },
};

const pipingHydraulics: PromptTemplate = {
  descriptor: {
    name: 'piping_hydraulics',
    description: 'Workflow for a pipe run and its pressure drop: add the run, check supports, compute hydraulics (Darcy-Weisbach).',
    arguments: briefArgument('The pipe, e.g. "DN100 water line, 40 m, 60 m3/h".'),
  },
  buildMessages({ brief = 'a DN100 water line carrying 60 m3/h' }) {
    return conversation(
      `Size and check the pressure drop of ${brief} in llull.`,
      `**Piping workflow (enable the piping toolset first: \`enable_toolset\` { toolset: "piping" })**\n\n` +
        `1. Run: \`add_pipe_run\` { points: [[x, y, z], ...], dn | diameter, material, service } — document units; note the returned id (e.g. "pipe-1").\n` +
        `2. Supports: \`add_pipe_support\` along the run, then \`check_pipe_supports\` for span and load findings.\n` +
        `3. Hydraulics: \`pipe_hydraulics\` { pipeId, flowM3h | massFlowKgS, temperatureC, roughnessMm } — read-only; give exactly one flow. It reports velocity, friction, bend losses, static head and total pressure drop.\n` +
        `4. Iterate: if velocity or drop is out of range, change \`dn\` / \`diameter\` of the run and call \`pipe_hydraulics\` again.\n\n` +
        `Results are computed by llull with stated correlations and are NOT approved for design.`,
    );
  },
};

export const WORKFLOW_TEMPLATES: ReadonlyArray<PromptTemplate> = [feaStaticCheck, dynamicsSimulation, pipingHydraulics];
