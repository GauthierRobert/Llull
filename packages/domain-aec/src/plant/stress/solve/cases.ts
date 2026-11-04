/** Load case definitions (07 PST §3, §5.5): validation and the B31.3 default set. */

import type { LoadCaseDef, OperatingConditions, StressModel } from '../model/schema';

/** The B31.3 default set from the primitives the conditions define: L1 SUS (W + P1), L2 OPE (W + T1 + P1), L3 EXP (L2 - L1). Null without a T1. */
export function defaultLoadCases(conditions: OperatingConditions): LoadCaseDef[] | null {
  if (!conditions.temperatures.some((entry) => entry.name === 'T1')) return null;
  const pressure = conditions.pressures.some((entry) => entry.name === 'P1') ? ['P1'] : [];
  return [
    { name: 'L1', type: 'SUS', basic: ['W', ...pressure] },
    { name: 'L2', type: 'OPE', basic: ['W', 'T1', ...pressure] },
    {
      name: 'L3',
      type: 'EXP',
      combine: [
        { case: 'L2', factor: 1 },
        { case: 'L1', factor: -1 },
      ],
    },
  ];
}

/** Problems of a set of load cases against the forces of the model: [path, message]; empty when valid. */
export function loadCaseProblems(
  cases: readonly LoadCaseDef[],
  forces: StressModel['forces'],
  displacements: StressModel['displacements'] = [],
): [string, string][] {
  const problems: [string, string][] = [];
  const names = new Set<string>();
  cases.forEach((loadCase, index) => {
    const path = `cases.${index}`;
    if (names.has(loadCase.name)) problems.push([`${path}.name`, `duplicate case name ${loadCase.name}`]);
    names.add(loadCase.name);
    if (loadCase.type === 'EXP') {
      if ((loadCase.combine ?? []).length === 0)
        problems.push([`${path}.combine`, `EXP case ${loadCase.name} needs combine terms (for example OPE - SUS)`]);
      if (loadCase.basic !== undefined)
        problems.push([`${path}.basic`, `EXP case ${loadCase.name} combines cases; it has no primitive loads`]);
    } else {
      if ((loadCase.basic ?? []).length === 0)
        problems.push([`${path}.basic`, `${loadCase.type} case ${loadCase.name} needs primitive loads (W, T1, P1, F1 ...)`]);
      if (loadCase.combine !== undefined)
        problems.push([`${path}.combine`, `${loadCase.type} case ${loadCase.name} is solved from primitives; only EXP combines`]);
      for (const primitive of loadCase.basic ?? [])
        if (primitive.startsWith('F') && !forces.some((force) => force.name === primitive))
          problems.push([`${path}.basic`, `case ${loadCase.name}: no force ${primitive} (pass it in forces)`]);
        else if (primitive.startsWith('D') && !displacements.some((moved) => moved.name === primitive))
          problems.push([`${path}.basic`, `case ${loadCase.name}: no imposed displacement ${primitive} (pass it in displacements)`]);
    }
  });
  cases.forEach((loadCase, index) => {
    for (const term of loadCase.combine ?? []) {
      const target = cases.find((candidate) => candidate.name === term.case);
      if (target === undefined) problems.push([`cases.${index}.combine`, `${loadCase.name} combines unknown case ${term.case}`]);
      else if (target.type === 'EXP')
        problems.push([`cases.${index}.combine`, `${loadCase.name} combines the EXP case ${term.case}; combine OPE / SUS / OCC cases`]);
    }
  });
  return problems;
}
