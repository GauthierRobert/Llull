import { expect, test, type Page } from '@playwright/test';
import { applyTool, downloadText, elementRows, openBuilding, status } from './buildingHelpers';

/**
 * End-to-end: an industrial (factory builder) workflow in the real app, covering
 * docs/INDUSTRIAL_PLAN.md I1–I10.
 */

/** A 24 × 36 m portal-frame hall with a 10 t crane, generated from the panel form. */
async function hall(page: Page): Promise<void> {
  await applyTool(page, 'hall', { span: '24000', length: '36000', craneRailHeight: '5000' });
  await expect(status(page)).toContainText('Added portal-frame hall 24.0 × 36.0 m');
}

test.describe('industrial workflow', () => {
  test('I1–I5 — portal-frame hall with crane runway, footings and cladding', async ({ page }) => {
    await openBuilding(page);
    await hall(page);
    await expect(status(page)).toContainText(/steel members \(\d+\.\d t\)/);
    await expect(elementRows(page, 'member').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Select Steel SC1', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Select Steel CB1', exact: true })).toBeVisible();
    await expect(elementRows(page, 'footing')).toHaveCount(14 + 6);
    await expect(elementRows(page, 'panel')).toHaveCount(6);

    await applyTool(page, 'member', {
      role: 'brace',
      profile: 'CHS76.1x3.6',
      x1: '0',
      y1: '0',
      z1: '0',
      x2: '0',
      y2: '6000',
      z2: '5000',
    });
    await expect(status(page)).toContainText(/Added brace BR\d+ .* CHS76\.1x3\.6/);
    await applyTool(page, 'footing', { underColumns: 'false', x: '12000', y: '18000' });
    await expect(status(page)).toContainText('Added 1 pad footing');
    await applyTool(page, 'member', { profile: 'HEB300', z1: '9000', z2: '9000' });
    const mark = /Added beam (SB\d+)/.exec((await status(page).textContent()) ?? '')?.[1] ?? '';
    const row = page.getByRole('button', { name: `Select Steel ${mark}`, exact: true });
    await row.click();
    await expect(page.locator('li', { has: row })).toHaveClass(/panel__row--selected/);
    await page.keyboard.press('Control+z');
    await expect(row).toHaveCount(0);
  });

  test('I6–I7 — equipment, pipes and clash detection', async ({ page }) => {
    await openBuilding(page);
    await hall(page);
    await applyTool(page, 'equipment', { name: 'Press', x: '0', y: '12000' });
    await expect(status(page)).toContainText('Added equipment EQ1 "Press"');
    await applyTool(page, 'equipment', { name: 'Lathe', x: '12000', y: '20000' });
    await applyTool(page, 'pipe', {
      points: '6000,2000,4000; 6000,30000,4000',
      service: 'cooling water',
    });
    await expect(status(page)).toContainText('Added cooling water pipe PL1');

    await page.getByTestId('clash-check').click();
    await expect(page.getByTestId('clash-summary')).toContainText(/[1-9]\d* hard/);
    const pressClash = page.getByTestId('clash-row').filter({ hasText: 'EQ1' }).first();
    await expect(pressClash).toContainText('Hard');
    await pressClash.click();
    await expect(page.getByRole('button', { name: 'Select Equipment EQ1' })).toBeVisible();

    await page.getByRole('button', { name: 'Delete Equipment EQ1' }).click();
    await page.getByTestId('clash-check').click();
    await expect(page.getByTestId('clash-summary')).toHaveText('No clashes found.');
  });

  test('I8 — steel tonnage, schedules and IFC members', async ({ page }) => {
    await openBuilding(page);
    await hall(page);
    await expect(page.getByTestId('takeoff-member.HEA400.kg')).toContainText('kg');
    await expect(page.getByTestId('takeoff-member.paint.m2')).toContainText('m²');
    await expect(page.getByTestId('takeoff-footing.concrete.m3')).toBeVisible();

    await page.getByLabel('Schedule').selectOption('member');
    const schedule = await downloadText(page, () =>
      page.getByRole('button', { name: 'Schedule CSV' }).click(),
    );
    expect(schedule.name).toBe('member-schedule.csv');
    expect(schedule.text.split('\n')[0]).toBe(
      'Mark,Role,Profile,Length (mm),Mass (kg),Grade,Level,Note',
    );
    expect(schedule.text).toContain('HEA400');

    const ifc = await downloadText(page, () =>
      page.getByRole('button', { name: 'IFC (BIM)' }).click(),
    );
    for (const entity of ['IFCCOLUMN(', 'IFCMEMBER(', 'IFCFOOTING(', 'IFCISHAPEPROFILEDEF(']) {
      expect(ifc.text).toContain(entity);
    }
  });

  test('I9 — elevation and section sheets', async ({ page }) => {
    await openBuilding(page);
    await page.getByRole('button', { name: 'Steel hall' }).click();
    await expect(status(page)).toContainText('Added portal-frame hall');

    await page.getByLabel('Elevation direction').selectOption('east');
    const elevation = await downloadText(page, () =>
      page.getByRole('button', { name: 'Elevation sheet' }).click(),
    );
    expect(elevation.name).toMatch(/East_elevation_A3_1-\d+\.svg$/);
    expect(elevation.text).toContain('<title>East elevation</title>');
    expect(elevation.text).toContain('id="title-block"');

    await page.getByLabel('Section cut position').fill('12000');
    await page.getByRole('checkbox', { name: 'Hide cladding' }).check();
    const section = await downloadText(page, () =>
      page.getByRole('button', { name: 'Section sheet' }).click(),
    );
    expect(section.text).toContain('Section at x = 12000, viewed from east');
    expect(section.text).toContain('class="section"');
    await expect(page.getByTestId('building-export-status')).toContainText('visible face');
  });
});
