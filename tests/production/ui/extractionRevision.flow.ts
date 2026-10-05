import { execute } from '@core/commands/registry';
import { serializeDocument } from '@core/commands/persistence';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { Scenario } from '../contract';
import { writeArtifact } from '../report';
import { extractionBuilding } from '../scenarios/extractionBuilding';
import { extractionRevision } from '../scenarios/extractionRevision';
import { UiDriver } from './driver';
import { exportPackage, saveProject } from './exports';
import type { UiRun } from './grading';
import type { UiSession } from './session';

/**
 * @layer tests/production/ui
 *
 * desmet-extraction-revision-b through the UI: the colleague's issued rev A project (built in
 * Node by running the building scenario's calls) is opened with "Open project"; the engineer
 * applies the change order with the same controls (the uprated extractor in the equipment editor),
 * re-issues the package and saves.
 */

function runScript(scenario: Scenario, from: CadDocument): CadDocument {
  return scenario.script.reduce((doc, call) => execute(doc, call.tool, call.args).document, from);
}

export async function extractionRevisionFlow(session: UiSession): Promise<UiRun> {
  const baseline = runScript(extractionBuilding, createEmptyDocument());
  const revA = writeArtifact(
    'ui',
    extractionRevision.id,
    'rev-a-issued-project.json',
    serializeDocument(baseline),
  );

  await session.start();
  await session.openProject(revA);
  const driver = new UiDriver(session);
  const levels = Object.values(baseline.building?.levels ?? {});
  driver.startFromProject(levels);
  for (const call of extractionRevision.script) await driver.perform(call);

  const { provided, fileNames } = await exportPackage(session, baseline.building?.levelOrder ?? []);
  const saved = await saveProject(session);
  return {
    scenario: extractionRevision,
    session,
    baseline,
    saved,
    provided,
    fileNames,
    uiGaps: driver.uiGaps,
    steps: driver.steps,
  };
}
