import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { Scenario } from './contract';
import { gradeContext, gradeScenario } from './grade';
import { SCENARIOS, chainOf } from './scenarios';

/**
 * @layer tests/production
 *
 * Fast in-process run of every production scenario's scripted calls (no transport): the
 * engineering-office acceptance criteria hold, with exactly the scripted known issues failing.
 * The same scripts run through the real /mcp endpoint in server/tests/production.
 */

function run(scenario: Scenario, doc: CadDocument): CadDocument {
  return scenario.script.reduce((current, call) => {
    const result = execute(current, call.tool, call.args);
    const readOnly = call.tool.startsWith('check_');
    if (!readOnly) expect(result.document, `${call.tool}: ${result.summary}`).not.toBe(current);
    return result.document;
  }, doc);
}

describe('production scenarios (in-process scripted driver)', () => {
  for (const scenario of SCENARIOS) {
    it(scenario.id, () => {
      let baseline = createEmptyDocument();
      let document = baseline;
      for (const step of chainOf(scenario)) {
        baseline = document;
        document = run(step, document);
      }
      const report = gradeScenario(scenario, 'scripted', gradeContext(document, baseline));
      const failing = report.checks.filter((c) => !c.pass).map((c) => `${c.id}: ${c.detail}`);
      expect(report.regressions, failing.join('\n')).toEqual([]);
      expect(report.fixed, 'known issues now passing — remove them from knownIssues').toEqual([]);
    });
  }
});
