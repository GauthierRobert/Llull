/** Design-condition pass of `check_pipe_spec` (§5.6 5): design pressure against the spec's P-T rating, design temperature against its limits. */

import { findRatingTable, ratingAt } from '../../catalog/ptRating';
import { finding, type CheckContext, type SpecFinding } from './finding';

/** Design conditions: pressure in bar gauge, temperature in degC. */
export interface DesignConditions {
  readonly pressureBar: number;
  readonly temperatureC: number;
}

export interface DesignOutcome {
  readonly findings: readonly SpecFinding[];
  readonly data: Readonly<Record<string, unknown>>;
}

const round4 = (value: number): number => Math.round(value * 1e4) / 1e4;

export function designFindings({ spec }: CheckContext, design: DesignConditions): DesignOutcome {
  const findings: SpecFinding[] = [];
  const limits = spec.designLimits;
  const base = { designBar: design.pressureBar, temperatureC: design.temperatureC };
  if (
    (limits?.minTemperatureC !== undefined && design.temperatureC < limits.minTemperatureC) ||
    (limits?.maxTemperatureC !== undefined && design.temperatureC > limits.maxTemperatureC)
  )
    findings.push(
      finding(
        spec.id,
        'design',
        'PSC_TEMPERATURE_LIMIT',
        'fail',
        [spec.id],
        ['designLimits'],
        `design temperature ${design.temperatureC} degC is outside the limits of spec ${spec.id} (${limits?.minTemperatureC ?? '-inf'} to ${limits?.maxTemperatureC ?? 'inf'} degC)`,
        { temperatureC: design.temperatureC },
      ),
    );
  const { system, materialGroup, class: ratingClass } = spec.rating;
  const table = materialGroup === undefined ? undefined : findRatingTable(system, materialGroup);
  if (table === undefined || ratingClass === undefined) {
    findings.push(
      finding(
        spec.id,
        'design',
        'PSC_CATALOG_ROW_MISSING',
        'not_run',
        [spec.id],
        ['rating'],
        `no bundled rating table for ${system} group ${materialGroup ?? '(none)'} class ${ratingClass ?? '(none)'}: the design pressure was NOT checked`,
      ),
    );
    return { findings, data: { ...base, checked: false } };
  }
  const rating = ratingAt(table, ratingClass, design.temperatureC);
  if (!rating.ok) {
    findings.push(
      finding(spec.id, 'design', rating.code, 'fail', [spec.id], ['rating'], rating.message, { temperatureC: design.temperatureC }),
    );
    return { findings, data: { ...base, checked: false, tableId: table.id } };
  }
  const margin = round4(rating.ratingBar - design.pressureBar);
  if (design.pressureBar > rating.ratingBar)
    findings.push(
      finding(
        spec.id,
        'design',
        'PSC_PT_RATING_EXCEEDED',
        'fail',
        [spec.id],
        ['rating'],
        `design ${design.pressureBar} bar at ${design.temperatureC} degC exceeds the ${system} class ${ratingClass} rating ${round4(rating.ratingBar)} bar (margin ${margin} bar)`,
        { designBar: design.pressureBar, ratingBar: round4(rating.ratingBar), marginBar: margin },
      ),
    );
  if (!rating.verified)
    findings.push(
      finding(
        spec.id,
        'design',
        'PSC_DATA_UNVERIFIED',
        'warn',
        [table.id],
        ['rating'],
        `the rating rows used from ${table.id} are not grade A`,
      ),
    );
  return {
    findings,
    data: {
      ...base,
      checked: true,
      tableId: table.id,
      class: ratingClass,
      ratingBar: round4(rating.ratingBar),
      marginBar: margin,
      method: rating.method,
      verified: rating.verified,
    },
  };
}
