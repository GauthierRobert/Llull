import { createEmptyDocument } from '@core/model/types';
import { pipeRack } from '../scenarios/pipeRack';
import { pipeRackIntent } from '../scenarios/pipeRackIntent';
import { levelId } from '../plant/intent';
import { UiDriver } from './driver';
import { exportPackage, saveProject } from './exports';
import type { UiRun } from './grading';
import type { UiSession } from './session';

/**
 * @layer tests/production/ui
 *
 * desmet-pipe-rack through the UI: from an empty app, the engineer creates the project, level and
 * grid, the portal bents and bracing as steel members, the nine lines with their line-list data
 * (number, DN, from, to) and the cable tray with the Building panel forms, issues the package and
 * saves the project.
 */

export async function pipeRackFlow(session: UiSession): Promise<UiRun> {
  await session.start();
  const driver = new UiDriver(session);
  for (const call of pipeRack.script) await driver.perform(call);

  const levelIds = pipeRackIntent.levels.map((_, index) => levelId(index));
  const { provided, fileNames } = await exportPackage(session, levelIds);
  const saved = await saveProject(session);
  return {
    scenario: pipeRack,
    session,
    baseline: createEmptyDocument(),
    saved,
    provided,
    fileNames,
    uiGaps: driver.uiGaps,
    steps: driver.steps,
  };
}
