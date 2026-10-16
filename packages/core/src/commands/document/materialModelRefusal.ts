/** Refusals of the PHY-02 commands: stable code, ids / paths and a remediation (TECHNICAL_SPEC §7.1, AF-11). */

import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { commandError, rejection } from '../noop';

export const MATL_REMEDIATION: Readonly<Record<string, string>> = {
  MAT_RECORD_NOT_FOUND: 'create the material first with create_material (its name is the material id)',
  MAT_PROVENANCE_MISSING: 'give source.citation (and locator / url / accessed)',
  MAT_PREFERRED_CONFLICT: 'drop preferred on one of them (remove_material_model or replace)',
  PROP_RANGE_INVALID: 'give data min ≤ max, equation ⊇ data, and a unit of the variable dimension (T in K, equivalentPlasticStrain in 1 …)',
  MATL_MODEL_NOT_FOUND: 'list the models of the material (describe_scene) or add the model first with add_material_model',
  MATL_MODEL_EXISTS: 'pass replace: true or a new id',
  MATL_MODEL_IN_USE: 'edit or remove the constitutive set that lists it first',
  MATL_LAW_PARAMS_INVALID: 'follow `llull describe add_material_model`: finite parameters of the right unit dimension, none missing',
  MATL_ELASTIC_NOT_POSITIVE_DEFINITE: 'check ν_ij against √(E_i/E_j) and the signs of E and G',
  MATL_POISSON_BOUND: 'give −1 < ν < 0.5',
  MATL_HARDENING_MODULUS_KIND_MISSING: "say 'plastic' (slope vs plastic strain) or 'tangent' (slope vs total strain)",
  MATL_CURVE_MEASURE_MISSING: 'state true / engineering stress and plastic / total strain',
  MATL_HARDENING_CURVE_INVALID: 'fix the curve: first point at plastic strain 0, strictly increasing strain, at least 2 points',
  MATL_HYPERELASTIC_INITIAL_MODULUS: 'check the signs of C10 / μ_i',
  MATL_HYPERELASTIC_UNSTABLE: 'refit (e.g. Yeoh), add test modes, or narrow the stretch validity',
  MAT_VALUE_UNVERIFIED: 'use verified bases and sourced, reviewed models',
  MATL_PRONY_INVALID: 'fix the series: every g > 0, Σg < 1, every τ > 0',
  MATL_CREEP_PARAMS_INVALID: 'give A > 0, n > 0, m > −1',
  MATL_COMBINATION_INVALID: 'change the set so it follows the combination rules of `llull describe define_constitutive_set`',
  MATL_SHIFT_OUT_OF_RANGE: 'stay at or above Tg / Tr',
  PROP_MODEL_NOT_FOUND: 'define the property model first with define_property_model',
};

/** Rejection with `MATL_*` remediation (or the one a passed-through failure carries). */
export const matlRefusal = (
  doc: CadDocument,
  command: string,
  code: string,
  message: string,
  ids: readonly string[] = [],
  path?: string,
  remediation?: string,
): CommandResult =>
  rejection(
    doc,
    `${command}: ${code} — ${message}; no-op.`,
    commandError(code, remediation ?? MATL_REMEDIATION[code] ?? 'see the command description', ids, path !== undefined ? [path] : []),
  );
