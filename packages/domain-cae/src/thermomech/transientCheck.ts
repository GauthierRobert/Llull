/** Start-state reminders of a transient coupled case for `check_thermo_mechanical` (PHY-04 M4b). */

import type { AnalysisCase, ThermoMechSetup } from '@core/model/analysis';
import { isTransientCase } from '../thermal/access';
import { inScale } from '../thermal/quantities';
import type { CheckProblem } from './orthoCheck';
import { temperatureIn } from './units';

/**
 * A transient that names no initial temperature starts at the reference temperature; one that starts elsewhere runs a pre-heating step first.
 * @failure TMC_TRANSIENT_START_DEFAULTED, TMC_TRANSIENT_PREHEAT (warnings); nothing for a steady or non-coupled case
 */
export function transientStartProblems(analysisCase: AnalysisCase, setup: ThermoMechSetup): CheckProblem[] {
  const thermal = setup.thermal;
  if (thermal === undefined || !isTransientCase(analysisCase)) return [];
  const ids = [analysisCase.id];
  const initial = thermal.initialTemperature;
  if (initial === undefined)
    return [
      {
        code: 'TMC_TRANSIENT_START_DEFAULTED',
        severity: 'warning',
        message:
          'the transient has no initial temperature: it starts at the reference temperature (set_initial_temperature to start elsewhere)',
        ids,
      },
    ];
  const reference = temperatureIn(setup.referenceTemperature, setup.temperatureScale);
  if (reference === null || Math.abs(inScale(initial, setup.temperatureScale) - reference) <= 1e-9 * Math.max(1, Math.abs(reference)))
    return [];
  return [
    {
      code: 'TMC_TRANSIENT_PREHEAT',
      severity: 'warning',
      message: `the initial temperature differs from the reference temperature: a *STATIC pre-heating step brings every node from ${reference} to ${inScale(initial, setup.temperatureScale)} ${setup.temperatureScale} (thermal strain and stress from the reference) before the transient`,
      ids,
    },
  ];
}
