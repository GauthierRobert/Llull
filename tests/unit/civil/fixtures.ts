/** Shared civil test fixtures: a metric document with a surveyed analytic terrain. */

import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

export function metricDocument(): CadDocument {
  return execute(createEmptyDocument(), 'set_units', { units: 'm' }).document;
}

/** Survey text (PENZD) of z = f(x, y) sampled on an n × n grid with `step` spacing. */
export function gridSurvey(f: (x: number, y: number) => number, n = 11, step = 10): string {
  const lines = ['Point,Easting,Northing,Elevation,Code'];
  let number = 1;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = i * step;
      const y = j * step;
      lines.push(`${number++},${x},${y},${f(x, y)},TOPO`);
    }
  }
  return lines.join('\n');
}

/** Metric document with point group `pointGroup-1` and surface `surface-1` of z = f(x, y). */
export function surveyedDocument(
  f: (x: number, y: number) => number = (x) => 100 + x * 0.05,
  n = 11,
  step = 10,
): CadDocument {
  const imported = execute(metricDocument(), 'import_survey_points', {
    text: gridSurvey(f, n, step),
  });
  return execute(imported.document, 'create_surface', {}).document;
}
