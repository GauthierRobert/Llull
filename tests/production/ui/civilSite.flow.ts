import { createEmptyDocument } from '@core/model/types';
import { civilSiteIntent } from '../civil/intent';
import { civilSite } from '../scenarios/civilSite';
import { CivilUiDriver } from './civilDriver';
import { saveProject } from './exports';
import type { UiRun } from './grading';
import type { UiSession } from './session';

/**
 * @layer tests/production/ui
 *
 * civil-site-development through the UI: from an empty app, the engineer fills the project title
 * block (Building panel), then works down the Civil / Site panel — survey file, terrain, pad and
 * balance, road (spirals, profile, template, superelevation, report), manholes and pipes, IDF sizing
 * and HGL check — downloads the plan-profile sheet and the LandXML, and saves the project.
 */
export async function civilSiteFlow(session: UiSession): Promise<UiRun> {
  await session.start();
  const driver = new CivilUiDriver(session, civilSiteIntent);
  for (const call of civilSite.script) await driver.perform(call);
  const saved = await saveProject(session);
  return {
    scenario: civilSite,
    session,
    baseline: createEmptyDocument(),
    saved,
    provided: driver.provided,
    fileNames: driver.fileNames,
    uiGaps: driver.uiGaps,
    steps: driver.steps,
  };
}
