import { test } from '@playwright/test';
import { resetReports } from './report';
import { installDefaultPlugins } from '@app/plugins';
import { extractionBuildingFlow } from './ui/extractionBuilding.flow';
import { extractionRevisionFlow } from './ui/extractionRevision.flow';
import { pipeRackFlow } from './ui/pipeRack.flow';
import { civilSiteFlow } from './ui/civilSite.flow';
import { gradeUiRun } from './ui/grading';
import { UiSession } from './ui/session';

/**
 * @layer tests/production
 *
 * Production-scenario UI gate: each scenario is driven through the real app in Chromium (offline
 * mode) the way an engineer works, the downloads are graded by the same criteria as the scripted
 * and agent drivers, and the knownIssues.ui ratchet applies.
 *
 *   npm run production:ui
 *
 * The revision scenario starts from the rev A project built in Node (the colleague's issued file)
 * and opened through "Open project", so it does not depend on the first test.
 */

installDefaultPlugins();
test.beforeAll(() => resetReports('ui'));

test.describe('production scenarios (UI driver)', () => {
  test('desmet-extraction-building', async ({ page }) => {
    gradeUiRun(await extractionBuildingFlow(new UiSession(page)));
  });

  test('desmet-extraction-revision-b', async ({ page }) => {
    gradeUiRun(await extractionRevisionFlow(new UiSession(page)));
  });

  test('desmet-pipe-rack', async ({ page }) => {
    gradeUiRun(await pipeRackFlow(new UiSession(page)));
  });

  test('civil-site-development', async ({ page }) => {
    gradeUiRun(await civilSiteFlow(new UiSession(page)));
  });
});
