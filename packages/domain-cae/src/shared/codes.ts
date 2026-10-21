/** 05 §7.1 / PHY-03 / PHY-04 remediation texts for the codes the set-up commands emit. */

import { tableRejection } from '@core/commands/noop';

const REMEDIATION: Readonly<Record<string, string>> = {
  FEA_ANALYSIS_NOT_FOUND: 'list the analyses with describe_analysis (no analysisId), or create one with create_analysis',
  FEA_ANALYSIS_TYPE_UNSUPPORTED:
    'use static, modal, buckling, heat_steady, heat_transient, thermo_static, coupled_temperature_displacement or nonlinear_static',
  FEA_ANALYSIS_IN_USE: 'delete or re-point the analyses that read this one first',
  FEA_PARAM_NOT_APPLICABLE: 'drop the parameter or choose an analysisType that uses it',
  FEA_PARAM_INVALID: 'correct the value to the range given in the parameter description',
  DYN_BASIS_MISSING: 'pass modes (1-100, e.g. enough to pass 1.5 x the top of the excitation band) or fMaxHz',
  DYN_PROBE_QUANTITY:
    'random_response probes read a_x/y/z, u_x/y/z_rel, s_xx/yy/zz; frequency_response probes u_x/y/z, s_xx/yy/zz; other cases no dynamic quantity',
  FEA_UNITS_MISMATCH: 'drop unitSystem (it follows the document unit) or fix the quantity unit',
  FEA_FACTOR_INVALID: 'every factor must be >= 1 and every extra factor needs a non-empty justification',
  FEA_PART_NOT_IN_ANALYSIS: 'add the entity first with set_part_idealization',
  FEA_PART_INVALID: 'pass the id of an existing 3D solid with idealization solid, shell or plane_stress',
  FEA_KERNEL_OCC_REQUIRED: 'start the host with the exact OCC kernel (--kernel occt-native); boxes and sheet-metal parts need none',
  FEA_MIDSURFACE_NOT_THIN: 'raise maxThickness to the wall thickness, or keep the solid idealization',
  FEA_MIDSURFACE_NOT_A_PLATE: 'a shell needs one thin side: keep the solid idealization for bars and blocks',
  FEA_MIDSURFACE_NO_PAIRS: 'check maxThickness against the wall thickness, or keep the solid idealization',
  FEA_MIDSURFACE_COVERAGE: 'fix the geometry, raise maxThickness, lower midsurfaceMinCoverage with care, or keep the solid idealization',
  FEA_MIDSURFACE_THICKNESS_VARIES: 'give thickness explicitly (one section per part), or split the part',
  FEA_MIDSURFACE_FAILED: 'check the sheet-metal part (rule thickness, bends joining two flats) or keep the solid idealization',
  FEA_PLANE_STRESS_NOT_XY: 'model the section on the plane z = 0 and point sourceFacesNear at that face',
  FEA_COMPOSITE_INVALID: 'name a composite part laid up on this entity, with plies, lamina materials and rosettes (06 CMP commands)',
  FEA_COMPOSITE_ZONES_UNSUPPORTED: 'create_laminate_sections and pass laminateSectionId (one uniform section per analysed part)',
  FEA_COMPOSITE_CORE_UNSUPPORTED: 'sandwich cores are not written: analyse the skins, or keep the solid idealization',
  FEA_TARGET_UNRESOLVED:
    'give an existing 3D entityId and at least one point in facesNear / edgesNear / pointsNear on the intended topology',
  FEA_CONSTRAINT_NOT_FOUND: 'list constraints with describe_analysis',
  FEA_CONSTRAINT_INVALID: 'fixed / pinned / symmetry need a target; displacement also needs dofs with finite values',
  FEA_ITEM_NOT_FOUND: 'list the constraints, loads, probes and thermal / explicit records with describe_analysis (or analysis_report)',
  FEA_LOAD_NOT_FOUND: 'list loads with describe_analysis',
  FEA_LOAD_INVALID: 'force needs target + vector, pressure needs target + magnitude, gravity needs vector and no target',
  FEA_MESH_CONTROLS_INVALID: 'order must be 1 or 2, sizes > 0, minSize <= globalSize, refinement size <= globalSize',
  FEA_PROBE_NOT_FOUND: 'list probes with describe_analysis',
  FEA_PROBE_INVALID: 'give a finite point [x, y, z] in document units and a supported quantity',
  TMC_REFERENCE_TEMPERATURE_MISSING: 'pass referenceTemperature { value, unit } (the stress-free temperature; there is no default)',
  THM_UNITS_MISMATCH: 'give { value, unit } with a temperature unit (degC, K, degF)',
};

/** `codedRejection` with the remediation registered for `code`. */
export const refuseCode = tableRejection(REMEDIATION);
