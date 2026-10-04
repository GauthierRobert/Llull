import { createEmptyDocument } from '@core/model/types';
import { extractionBuilding } from '../scenarios/extractionBuilding';
import { extractionIntent } from '../scenarios/extractionIntent';
import { levelId } from '../plant/intent';
import { UiDriver } from './driver';
import { exportPackage, saveProject } from './exports';
import type { UiRun } from './grading';
import type { UiSession } from './session';

/**
 * @layer tests/production/ui
 *
 * desmet-extraction-building through the UI: from an empty app, the engineer creates the project,
 * levels, grid, steel, gratings, equipment, openings, stairs and lines with the Building panel
 * (command palette where a panel form lacks a field), issues the package and saves the project.
 */

export async function extractionBuildingFlow(session: UiSession): Promise<UiRun> {
  await session.start();
  const driver = new UiDriver(session);
  for (const call of extractionBuilding.script) await driver.perform(call);

  const levelIds = extractionIntent.levels.map((_, index) => levelId(index));
  const { provided, fileNames } = await exportPackage(
    session,
    { levelIds, activate: (id) => driver.activateLevel(id) },
    driver.gaps,
  );
  const saved = await saveProject(session);
  return {
    scenario: extractionBuilding,
    session,
    baseline: createEmptyDocument(),
    saved,
    provided,
    fileNames,
    uiGaps: driver.uiGaps,
    steps: driver.steps,
  };
}
