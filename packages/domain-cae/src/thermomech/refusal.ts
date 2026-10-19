/** Refusals of the PHY-04 commands: stable code, ids, paths and the remediation texts. */

import { tableRejection } from '@core/commands/noop';

const REMEDIATION: Readonly<Record<string, string>> = {
  FEA_ANALYSIS_NOT_FOUND: 'list the analyses with describe_analysis (no analysisId), or create one with create_analysis',
  THM_CASE_TYPE: 'use a thermo_static analysis here (create_analysis analysisType thermo_static); heat_* cases use the thermal commands',
  THM_UNITS_MISMATCH: 'give { value, unit } with a temperature unit (degC, K, degF)',
  TMC_REFERENCE_TEMPERATURE_MISSING:
    'set_reference_temperature { analysisId, value, unit } (the stress-free temperature; there is no default)',
  TMC_FIELD_SOURCE_INVALID:
    'reference a solved heat_* analysis, a finite time or "last", a valid expression in x, y, z, or a table artifact hash',
  TMC_FIELD_INVALID: 'fix the expression or the source so every mesh node gets a finite temperature',
  TMC_FIELD_TABLE_UNMATCHED:
    're-export the table so every mesh node has a row within 1e-6 of the model size, or use a thermal_result field',
  TMC_THERMAL_RESULT_STALE: 're-solve the thermal case (fea_solve), then this one',
  TMC_MESH_MISMATCH:
    'mesh both cases with the same parts and mesh controls, or set the field with mapping "interpolate" to map between different meshes',
  TMC_MAPPING_PROJECTED:
    'nodes outside the thermal mesh took the value at the nearest point: mesh the thermal case over the whole mechanical geometry, or review the mapped field',
  TMC_HUMAN_GATE: 'hand over to the qualified reviewer: a human signature verified by the signing port is required',
  TMC_FIT_INPUTS_CHANGED: 'recompute the fit (fit_at_temperature), then disposition the new row',
  FEA_RESULTS_MISSING: 'run fea_mesh and fea_solve on the analysis so the results artifact exists in the store',
  FEA_RESULTS_STALE: 're-solve the analysis (fea_solve); results of changed inputs are never read',
  FEA_PARAM_INVALID: 'see the parameter descriptions of the command',
  TMC_CTE_BASIS_UNKNOWN:
    "state the basis with set_temperature_field { analysisId, cteBasis: { <materialId>: { kind: 'secant', referenceTemperature } or { kind: 'instantaneous' } } }, or define a thermalStrain property model",
  TMC_MATERIAL_NO_CTE:
    'assign a material to the part and define_property_model with property thermalStrain (preferred) or cte on it (basis and source required)',
  TMC_MATERIAL_UNVERIFIED:
    'replace the typical / unstated CTE, E or nu by a verified, sourced define_property_model value; results stay flagged until then',
  TMC_PROPERTY_OUT_OF_RANGE:
    'define the CTE / E / nu model over the temperatures reached (define_property_model with a validity range covering the reference and field temperatures)',
  TMC_ELASTIC_NOT_TEMPERATURE_DEPENDENT:
    'define_property_model for E (and nu) against T over the temperatures reached (table1d or polynomial with a validity range covering the field); the deck then writes *ELASTIC rows E, nu, T',
  TMC_THERMAL_CATEGORY_UNSET:
    'add_fea_load with loadCase set to the thermal load case name and category limit or ultimate, per the programme rule',
  TMC_CTE_ORTHO_ELASTIC_ISOTROPIC:
    'review the result: only the CTE is orthotropic (E and nu come from the 05 isotropic elastic cards); stiffness anisotropy is not modelled',
  TMC_TRANSIENT_START_DEFAULTED:
    'set_initial_temperature { analysisId, value, unit } if the body does not start at the reference temperature',
  TMC_TRANSIENT_PREHEAT:
    'review the start state: the pre-heating step makes the thermal stress of reference -> start temperature; use the reference temperature as the start temperature for a stress-free start',
  TMC_SPEC_TEMPERATURE_MISSING:
    'give the temperature the drawing limits apply at, e.g. specTemperature = { value: 20, unit: "degC" } (there is no default)',
  TMC_STACKUP_INVALID: 'give 1 to 50 uniquely named contributors and consistent spec limits (lowerSpecLimit <= upperSpecLimit)',
  TMC_STACKUP_WC_EXCEEDED:
    'the worst case leaves the spec limits while the RSS stays inside: tighten tolerances or accept the statistical risk through a qualified review',
  TMC_STACKUP_OUT_OF_SPEC:
    'the gap leaves the spec limits even in RSS: change materials, tolerances or the spec limits; hand the row to a human reviewer',
  TMC_CTE_ORTHO_INCOMPLETE:
    'define_property_model with property cte (or thermalStrain) for every missing direction 1 / 2 / 3, or remove the direction from the models for an isotropic CTE',
  TMC_ORIENTATION_REQUIRED:
    'set_material_orientation { analysisId, entityId, axis1, axis2 } with the material directions in the document frame, or un-rotate the part',
  TMC_ORIENTATION_INVALID:
    'give an analysis part id and two non-zero, non-parallel vectors axis1 / axis2 (or neither, to remove the orientation)',
  TMC_COUPLED_UNSUPPORTED:
    'remove the cavity radiation, thermal contacts and h(T) tables (and, for a steady-state step, the amplitudes: set_thermal_step endTimeS makes the case transient) from the coupled case, or run a heat_* case then a thermo_static case',
};

/** `codedRejection` with the remediation registered for `code`; document unchanged. */
export const refuseTmc = tableRejection(REMEDIATION);

/** Remediation text of a code (for check items). */
export const remediationOf = (code: string): string => REMEDIATION[code] ?? 'see the description of check_thermo_mechanical';
