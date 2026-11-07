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
    'Only 90 degree tees on straight header pipe are modelled: move the branch off the bend or the pipe end, or model the Y / cross junction as separate models.',
  PST_COMPONENT_UNSUPPORTED: 'Move the valve, flange or reducer onto straight pipe between two nodes (not across a bend).',
  PST_COMPONENT_NOT_FOUND:
    'Name an inline valve or reducer of an RTE run of the model (piping_takeoff lists them), or a declared record id.',
  PST_DISPLACEMENT_NOT_ANCHORED:
    'An imposed displacement moves an anchor: add an anchor at that node (add_stress_restraint kind anchor) or place it on an existing anchor.',
  PST_SIF_NOT_FOUND: 'Pass the id returned by set_sif_override (data.overrideId).',
  PST_UNSTABLE: 'Add an anchor or a guide at the listed node (add_pipe_support type anchor, or add_stress_restraint).',
  PST_MODEL_TOO_LARGE: 'Analyse fewer pipes at once or raise maxElementLengthMm.',
  PST_NONLINEAR_NOT_CONVERGED: 'Remove the gap or one-way action at the listed restraints, or make them two-way, then re-run.',
  PST_ANALYSIS_FAILED: 'See the cause in the message; the document is unchanged.',
  PST_RESULTS_STALE: 'Run record_pipe_stress_results again after the edit; an approval covers one fixed set of results.',
  PST_RESULTS_FAILING: 'Fix the overstress (see check_pipe_stress) and record again; a failing model cannot be approved.',
  PST_RESULTS_INCOMPLETE: 'Add the missing sustained and expansion load cases, then record again.',
  PST_NOT_RECORDED: 'Run record_pipe_stress_results before approve_pipe_stress.',
  PST_CORROSION_EXCEEDS_WALL: 'Lower corrosionAllowanceMm below the wall thickness, or use a pipe with a thicker wall.',
  PST_CURSOR_STALE: 'Start again without a cursor: the model, a pipe or a support changed since the first page.',
  PST_TABLE_INVALID: 'Fix the table rows named in the error paths (minN below maxN, one row per series and size).',
  PST_SPRING_TABLE_MISSING: 'import_spring_table first (vendor sizes, rates, load ranges, travel), then name its tableId.',
  PST_SPRING_NO_SIZE: 'Import a table with a size that holds the hot load and travel, or allow the constant-effort fallback.',
  PST_SPRING_NOT_FOUND: 'Pass the id returned by select_spring_hangers (data.springs[].id).',
  PST_SPRING_VARIABILITY: 'Use a lower spring rate, a larger size, or a constant-effort hanger; 0.15 applies near rotating equipment.',
  PST_NOZZLE_OVERLOAD:
    'Reduce the nozzle load: add flexibility, move supports or anchors, or use a limit that applies (confirm the rule with the equipment vendor).',
  PST_NOZZLE_LIMIT_MISSING: 'Pass the limit table (api610 table + orientation) or userLimits for the standard.',
  PST_HUMAN_GATE: 'A qualified reviewer signs in the desktop app; an agent cannot approve stress results.',
};

/** The remediation sentence of a registered code (findings carry it like a refusal does). */
export const remediationOf = (code: string): string => REMEDIATION[code] ?? FINDING_REMEDIATION[code] ?? 'see the command description';

const FINDING_REMEDIATION: Readonly<Record<string, string>> = {
  PST_STRESS_NOT_FINITE: 'Check the wall, corrosion allowance and loads named in the message; a non-finite stress never passes.',
  PST_SUSTAINED_OVERSTRESS: 'Add supports near the node (shorter span) or reduce the weight.',
  PST_EXPANSION_OVERSTRESS: 'Add flexibility (loop or offset), or move guides and line stops.',
  PST_OCCASIONAL_OVERSTRESS: 'Add guides or restraints for the occasional direction.',
  PST_HYDROTEST_OVERSTRESS:
    'Support the line for the water-filled weight (temporary supports) or lower the test pressure; check the stated hydrotest allowable.',
  PST_SIF_OVERRIDE:
    'A user SIF replaces the code value at that node: keep its source note current and have a qualified engineer confirm it.',
  PST_SIF_PLANE_UNKNOWN:
    'Place the override on a bend or a tee (where the plane is known) or give equal in-plane and out-of-plane factors.',
  PST_SUPPORT_LIFTOFF: 'Move or add a support, or use a hanger or spring.',
  PST_DISPLACEMENT_LIMIT: 'Check clearances at the listed nodes.',
  PST_CASE_INCOMPLETE: 'Add a sustained (SUS) and an expansion (EXP) load case; preset b31.3-default does it.',
  PST_SIF_EDITION: 'Give the B31J values (a later milestone) or have a qualified engineer confirm.',
  PST_MATERIAL_UNVERIFIED: 'Use a sourced thermal strain model (a signed material record).',
  PST_DISCONNECTED: 'Connect the runs or analyse the systems separately; each needs its own restraints.',
  PST_TEE_FITTING_ASSUMED:
    'set_stress_component with branchPipeId and the fitting (welding_tee, weldolet, reinforced_tee, unreinforced_tee).',
  PST_COMPONENT_WEIGHT_MISSING: 'set_stress_component with weightKg (catalogue weight of the valve or flange).',
  PST_REDUCER_SIF:
    'A reducer has no code factor in a read source: take the manufacturer or B31J value and confirm with a qualified engineer.',
  PST_NOZZLE_LIMIT_UNVERIFIED: 'Check the resultant and cumulative limits with the equipment vendor; the table values are caller-supplied.',
  PST_SPRING_CONSTANT_EFFORT:
    'No variable spring of the table fits: size a constant-effort hanger from the vendor for the stated load and travel.',
  PST_SPRING_LOAD_DEVIATION: 'Re-run select_spring_hangers (the stiffer system changed the travel) or check the spring table values.',
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
