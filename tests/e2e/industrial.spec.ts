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

  test('I11–I16 — multi-span hall, base plates, cable tray, curved wall, hatched DXF', async ({
    page,
  }) => {
    await openBuilding(page);
    await applyTool(page, 'hall', { spans: '18000, 18000', length: '24000' });
    await expect(status(page)).toContainText('(2 spans)');
    await expect(elementRows(page, 'plate')).toHaveCount(15 + 8);

    await applyTool(page, 'tray', { points: '2000,6000,5000; 30000,6000,5000', system: 'data' });
    await expect(status(page)).toContainText('Added data cable tray CT1');
    await page.getByLabel('Schedule').selectOption('tray');
    const trays = await downloadText(page, () =>
      page.getByRole('button', { name: 'Schedule CSV' }).click(),
    );
    expect(trays.text).toContain('CT1,data,300,60,28');

    await applyTool(page, 'curvedWall', { x1: '40000', xm: '43000', ym: '3000', x2: '46000' });
    await expect(status(page)).toContainText('Added curved wall');

    const dxf = await downloadText(page, () =>
      page.getByRole('button', { name: 'DXF (AutoCAD)' }).click(),
    );
    expect(dxf.text).toContain('A-WALL-PATT');
    expect(dxf.text).toContain('S-COLS-PATT');

    await page.getByLabel('Elevation direction').selectOption('south');
    await page.getByLabel('Section cut position').fill('12000');
    const section = await downloadText(page, () =>
      page.getByRole('button', { name: 'Section sheet' }).click(),
    );
    expect(section.text).toContain('class="poche-steel"');

    const ifc = await downloadText(page, () =>
      page.getByRole('button', { name: 'IFC (BIM)' }).click(),
    );
    for (const entity of ['IFCCABLECARRIERSEGMENT(', 'IFCPLATE(', 'IFCMECHANICALFASTENER(']) {
      expect(ifc.text).toContain(entity);
    }
  });

  test('S13, S14, I17 — wall build-up, door in a curved wall, moment connections', async ({
    page,
  }) => {
    await openBuilding(page);
    await applyTool(page, 'hall', { span: '18000', length: '12000', cladding: 'false' });
    await expect(elementRows(page, 'connection')).toHaveCount(9);
    await page.getByLabel('Schedule').selectOption('connection');
    const schedule = await downloadText(page, () =>
      page.getByRole('button', { name: 'Schedule CSV' }).click(),
    );
    expect(schedule.text.split('\n')[1]).toMatch(/^MC1,eaves,RF1,SC1,25,8×M20,/);

    await applyTool(page, 'wall', { x1: '30000', y1: '0', x2: '36000', y2: '0' });
    await applyTool(page, 'wallLayers', {
      allWalls: 'true',
      layers: '20 render finish; 120 mineral-wool insulation; 200 masonry structure',
    });
    await expect(status(page)).toContainText('3-layer build-up (340 total');
    await expect(page.getByTestId('takeoff-wall.mineral-wool.m3')).toBeVisible();

    await applyTool(page, 'curvedWall', { x1: '40000', xm: '43000', ym: '3000', x2: '46000' });
    const curved = page.locator('[data-testid^="element-row-curvedWall-"]');
    await expect(curved).toHaveCount(1);
    const curvedId = ((await curved.getAttribute('data-testid')) ?? '').replace('element-row-', '');
    await applyTool(page, 'door', { wallId: curvedId });
    await expect(status(page)).toContainText(`in wall W2`);
    const ifc = await downloadText(page, () =>
      page.getByRole('button', { name: 'IFC (BIM)' }).click(),
    );
    for (const entity of ['IFCMATERIALLAYERSETUSAGE(', "'END_PLATE'", 'IFCDOOR(']) {
      expect(ifc.text).toContain(entity);
    }
  });

  test('I18–I19 — frame check, automatic design, welds', async ({ page }) => {
    await openBuilding(page);
    await applyTool(page, 'hall', { span: '24000', length: '30000', cladding: 'false' });
    await page.getByTestId('frame-check').click();
    await expect(page.getByTestId('frame-check-summary')).toContainText('Checked 6 frame(s)');
    await expect(page.getByTestId('frame-check-summary')).toContainText('failure(s)');
    await page.getByTestId('frame-design').click();
    await expect(status(page)).toContainText('Designed 6 frame(s)');
    await page.getByTestId('frame-check').click();
    await expect(page.getByTestId('frame-check-summary')).toContainText('all OK');
    await page.getByLabel('Schedule').selectOption('connection');
    const schedule = await downloadText(page, () =>
      page.getByRole('button', { name: 'Schedule CSV' }).click(),
    );
    expect(schedule.text.split('\n')[1]).toMatch(/,a9 flanges \/ a6 web · \d+\.\d m$/);
  });

  test('I20–I23 — wind and crane combinations, buckling, sway stability, deflections', async ({
    page,
  }) => {
    await openBuilding(page);
    await applyTool(page, 'hall', {
      span: '24000',
      length: '30000',
      cladding: 'false',
      craneRailHeight: '6000',
    });
    await page.getByLabel('Wind pressure qp (kN/m²)').fill('0.7');
    await page.getByTestId('frame-check').click();
    const summary = page.getByTestId('frame-check-summary');
    await expect(summary).toContainText('66 ULS combination(s)');
    await expect(summary).toContainText('qp = 0.7 kN/m²');
    await expect(summary).toContainText('min αcr');
    await expect(
      page.getByTestId('frame-check-row').filter({ hasText: 'deflection' }).first(),
    ).toBeVisible();
    await page.getByTestId('frame-design').click();
    await expect(status(page)).toContainText('Designed 6 frame(s) for 66 ULS combination(s)');
    await page.getByTestId('frame-check').click();
    await expect(summary).toContainText('all OK');
  });

  test('I24–I27 — bracing, foundations and crane runway checks', async ({ page }) => {
    await openBuilding(page);
    await applyTool(page, 'hall', {
      span: '24000',
      length: '30000',
      cladding: 'false',
      craneRailHeight: '6000',
    });
    await page.getByLabel('Wind pressure qp (kN/m²)').fill('0.7');
    const summary = page.getByTestId('frame-check-summary');
    await page.getByTestId('bracing-check').click();
    await expect(summary).toContainText('Bracing check (qp 0.7 kN/m²');
    await expect(summary).toContainText('all OK');
    await page.getByTestId('purlin-check').click();
    await expect(summary).toContainText('Purlin check (qp');
    await expect(summary).toContainText('all OK');
    await page.getByTestId('foundation-check').click();
    await expect(summary).toContainText('Checked 12 footing(s)');
    await page.getByTestId('runway-check').click();
    await expect(summary).toContainText('crane runway beam(s)');
    await expect(summary).toContainText('all OK');
    await page.getByTestId('frame-check-row').first().click();
    await expect(page.getByTestId('frame-check-row').first()).toContainText('CB');
  });

  test('I28–I31 — footing design, anchor bolt plan and DSTV NC files', async ({ page }) => {
    await openBuilding(page);
    await applyTool(page, 'hall', { span: '24000', length: '30000', cladding: 'false' });
    await page.getByLabel('Wind pressure qp (kN/m²)').fill('0.7');
    await page.getByTestId('footing-design').click();
    await expect(status(page)).toContainText('Designed 12 of 12 footing(s)');
    await page.getByLabel('Schedule').selectOption('footing');
    const schedule = await downloadText(page, () =>
      page.getByRole('button', { name: 'Schedule CSV' }).click(),
    );
    expect(schedule.text).toMatch(/H\d+ @ \d+ B1\/B2/);
    const plan = await downloadText(page, () =>
      page.getByRole('button', { name: 'Anchor plan' }).click(),
    );
    expect(plan.name).toMatch(/anchor-plan/);
    expect(plan.text).toContain('A+6000/1');
    const nc = await downloadText(page, () =>
      page.getByRole('button', { name: 'NC files (DSTV)' }).click(),
    );
    expect(nc.name).toMatch(/\.nc1$/);
    expect(nc.text).toMatch(/^ST/m);
    await expect(page.getByTestId('building-export-status')).toContainText('DSTV NC1:');
  });

  test('I38 — a fixed-base crane hall designs lighter than a pinned one', async ({ page }) => {
    await openBuilding(page);
    const hallFields = {
      span: '24000',
      length: '30000',
      cladding: 'false',
      craneRailHeight: '6000',
    };
    await applyTool(page, 'hall', hallFields);
    await page.getByLabel('Wind pressure qp (kN/m²)').fill('0.7');
    await page.getByTestId('frame-design').click();
    await expect(status(page)).toContainText('Designed 6 frame(s)');
    await expect(page.getByTestId('takeoff-member.HEB500.kg')).toBeVisible();

    await openBuilding(page);
    await applyTool(page, 'hall', { ...hallFields, columnBase: 'fixed' });
    await expect(status(page)).toContainText('fixed column bases');
    await page.getByLabel('Wind pressure qp (kN/m²)').fill('0.7');
    await page.getByTestId('frame-design').click();
    await expect(status(page)).toContainText('fixed bases: plate');
    await expect(page.getByTestId('takeoff-member.HEB500.kg')).toHaveCount(0);
    await expect(page.getByTestId('takeoff-member.HEA400.kg')).toBeVisible();
    await page.getByTestId('frame-check').click();
    await expect(page.getByTestId('frame-check-summary')).toContainText('all OK');
    await page.getByTestId('foundation-check').click();
    // Moment bases need wider pads than the generated ones: the check reports the eccentric pressure.
    await expect(page.getByTestId('frame-check-summary')).toContainText('overturning EQU');
  });
});
