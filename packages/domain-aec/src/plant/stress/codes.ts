/** Stable `PST_*` codes of the pipe stress commands (07 PST §7, AF-11) with their one-line remediation. */

import { tableRejection } from '@core/commands/noop';

const REMEDIATION: Readonly<Record<string, string>> = {
  PST_PARAM_INVALID: 'Fix the parameter named in the error paths (units are stated in each parameter description).',
  PST_MATERIAL_NOT_FOUND: 'Create the material first (create_material) or use table "carbon-steel-c1" / meanCtePerK.',
  PST_MATERIAL_NO_DATA: 'define_property_model with property thermalStrain (preferred) or cte on the material, or pass meanCtePerK.',
  PST_TEMPERATURE_OUT_OF_TABLE: 'Use temperatures inside the stated range or extend the material table; llull never extrapolates.',
  PST_MODEL_NOT_FOUND: 'Create the model first with create_stress_model, or take the id from the plant stress listing in the document.',
  PST_NO_PIPES: 'Give pipeIds (building pipes or 02 RTE run ids) or a lineId that has runs.',
  PST_PIPE_NOT_FOUND: 'A referenced pipe or run was deleted or no longer derives: update_stress_model with the current scope.',
  PST_SUPPORT_NOT_FOUND: 'Name a pipe support on the model pipes (building_schedule kind pipeSupport) or give a pipeId and atMm.',
  PST_CONDITIONS_MISSING: 'set_pipe_operating_conditions first (material, temperatures, pressures).',
  PST_LOADCASE_INVALID: 'Fix the load cases named in the error paths; set_stress_load_cases with preset "b31.3-default" gives a valid set.',
  PST_POINT_OFF_PIPE: 'Place the support, restraint or force within one outside diameter of the pipe centreline, or give pipeId and atMm.',
  PST_WALL_UNKNOWN: 'Bind the pipe to a spec (assign_pipe_spec) or give wallMm in set_pipe_operating_conditions.',
  PST_BEND_TOO_TIGHT: 'Lengthen the leg, reduce elbowRadiusFactor, or lower the bend radius of the run.',
  PST_BRANCH_UNSUPPORTED:
    'Tees and branches arrive with M5: model each header or branch as its own stress model, or end the pipes at the junction.',
  PST_COMPONENT_UNSUPPORTED: 'Reducers and branches arrive with M5: analyse the straight reducer-free runs separately.',
  PST_RESTRAINT_OBLIQUE:
    'A lateral guide needs a pipe along a horizontal global axis or a vertical one; add a translational restraint on an axis instead.',
  PST_UNSTABLE: 'Add an anchor or a guide at the listed node (add_pipe_support type anchor, or add_stress_restraint).',
  PST_MODEL_TOO_LARGE: 'Analyse fewer pipes at once or raise maxElementLengthMm.',
  PST_NONLINEAR_NOT_CONVERGED: 'Remove the gap or one-way action at the listed restraints, or make them two-way, then re-run.',
  PST_ANALYSIS_FAILED: 'See the cause in the message; the document is unchanged.',
  PST_RESULTS_STALE: 'Run record_pipe_stress_results again after the edit; an approval covers one fixed set of results.',
  PST_RESULTS_FAILING: 'Fix the overstress (see check_pipe_stress) and record again; a failing model cannot be approved.',
  PST_RESULTS_INCOMPLETE: 'Add the missing sustained and expansion load cases, then record again.',
  PST_NOT_RECORDED: 'Run record_pipe_stress_results before approve_pipe_stress.',
  PST_CORROSION_EXCEEDS_WALL: 'Lower corrosionAllowanceMm below the wall thickness, or use a pipe with a thicker wall.',
  PST_HUMAN_GATE: 'A qualified reviewer signs in the desktop app; an agent cannot approve stress results.',
};

/** The remediation sentence of a registered code (findings carry it like a refusal does). */
export const remediationOf = (code: string): string => REMEDIATION[code] ?? FINDING_REMEDIATION[code] ?? 'see the command description';

const FINDING_REMEDIATION: Readonly<Record<string, string>> = {
  PST_STRESS_NOT_FINITE: 'Check the wall, corrosion allowance and loads named in the message; a non-finite stress never passes.',
  PST_SUSTAINED_OVERSTRESS: 'Add supports near the node (shorter span) or reduce the weight.',
  PST_EXPANSION_OVERSTRESS: 'Add flexibility (loop or offset), or move guides and line stops.',
  PST_OCCASIONAL_OVERSTRESS: 'Add guides or restraints for the occasional direction.',
  PST_SUPPORT_LIFTOFF: 'Move or add a support, or use a hanger or spring.',
  PST_DISPLACEMENT_LIMIT: 'Check clearances at the listed nodes.',
  PST_CASE_INCOMPLETE: 'Add a sustained (SUS) and an expansion (EXP) load case; preset b31.3-default does it.',
  PST_SIF_EDITION: 'Give the B31J values (a later milestone) or have a qualified engineer confirm.',
  PST_MATERIAL_UNVERIFIED: 'Use a sourced thermal strain model (a signed material record).',
  PST_DISCONNECTED: 'Connect the runs or analyse the systems separately; each needs its own restraints.',
  PST_COMPONENT_AS_PIPE: 'Valve weight and stiffness are not modelled: a later milestone.',
  PST_SHARP_CORNERS: 'Give elbowRadiusFactor 1.5 (long radius) for bends with SIFs.',
  PST_RESTRAINT_OVERRIDDEN: 'Two restraints act on the same degree of freedom; the later one is used.',
  PST_INSTALL_TEMP_DEFAULTED: 'Set installTempC explicitly.',
  PST_CYCLES_DEFAULTED: 'Set cycles explicitly.',
  PST_FRICTION_DEFAULTED: 'Set frictionCoefficient explicitly (0.3 steel on steel, 0.1 PTFE).',
  PST_CORROSION_DEFAULTED: 'Set corrosionAllowanceMm explicitly.',
};

export const refuse = tableRejection(REMEDIATION);

/** Non-hideable warning raised when the edition requires ASME B31J and only the appendix D value is available (07 PST §5.7). */
export const SIF_EDITION_WARNING = {
  code: 'PST_SIF_EDITION',
  message: 'this edition requires ASME B31J factors (tables not public); the code appendix D value is used and may under-state the SIF',
  remediation: 'Give the B31J values with rule "user" (userSif) or have a qualified engineer confirm.',
} as const;
