import type { DeliverableId } from '../contract';
import { parseCsv } from '../oracle/csv';
import type { Locator } from '@playwright/test';
import type { UiSession } from './session';

/**
 * @layer tests/production/ui
 *
 * Issue the coordination package through the Building panel's Deliverables and Quantities
 * sections: every file is the one the browser downloaded. Per-level files are issued by picking
 * the level in the "Export level" selector (the active level is not touched).
 */

export type Provided = Record<DeliverableId, string>;

const SCHEDULES = ['member', 'equipment', 'pipe'] as const;

/** The "Takeoff CSV" download as the `{ lines }` shape the criteria read (key, unit, quantity). */
function takeoffJson(csv: string): string {
  const [, ...rows] = parseCsv(csv);
  const lines = rows
    .filter((row) => row.length >= 4)
    .map((row) => ({ key: row[0] ?? '', unit: row[3] ?? '', quantity: Number(row[2]) }));
  return JSON.stringify({ lines });
}

export async function exportPackage(
  session: UiSession,
  levelIds: readonly string[],
): Promise<{ provided: Provided; fileNames: Record<string, string> }> {
  const { page } = session;
  const provided: Provided = {};
  const fileNames: Record<string, string> = {};
  const take = async (id: DeliverableId, trigger: () => Promise<void>): Promise<void> => {
    const file = await session.download(trigger);
    provided[id] = file.text;
    fileNames[id] = file.name;
  };
  const button = (name: string): Locator => page.getByRole('button', { name, exact: true });

  await take('ifc', () => button('IFC (BIM)').click());
  for (const levelId of levelIds) {
    await page.getByLabel('Export level').selectOption(levelId);
    await take(`dxf:${levelId}`, () => button('DXF (AutoCAD)').click());
    await take(`plan:${levelId}`, () => button('Plan sheet').click());
  }
  await page.getByLabel('Elevation direction').selectOption('south');
  await take('elevation:south', () => button('Elevation sheet').click());
  for (const kind of SCHEDULES) {
    await page.getByLabel('Schedule', { exact: true }).selectOption(kind);
    await take(`schedule:${kind}`, () => button('Schedule CSV').click());
  }
  const takeoff = await session.download(() => button('Takeoff CSV').click());
  provided['takeoff'] = takeoffJson(takeoff.text);
  fileNames['takeoff'] = takeoff.name;
  return { provided, fileNames };
}

/** Top bar "Save": the project file the office archives. */
export async function saveProject(session: UiSession): Promise<string> {
  await session.deselect();
  const file = await session.download(() =>
    session.page.getByRole('button', { name: 'Save project to a JSON file' }).click(),
  );
  return file.text;
}
