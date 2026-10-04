import type { UiSession } from './session';

/**
 * @layer tests/production/ui
 *
 * Building panel controls: "Add element" tool forms, levels list, project information form.
 * Fields keep their value between submissions (as for a human), so only changed ones are retyped.
 */

type FieldValues = Record<string, string>;

export class BuildingPanel {
  private tool = '';
  private typed: FieldValues = {};

  constructor(private readonly session: UiSession) {}

  /** Pick an "Add element" tool, set its fields (selects by value) and press its Add button. */
  async applyTool(toolId: string, fields: FieldValues, selects: FieldValues = {}): Promise<string> {
    const { page } = this.session;
    if (this.tool !== toolId) {
      await page.getByTestId('building-tool-select').selectOption(toolId);
      this.tool = toolId;
      this.typed = {};
    }
    for (const [key, value] of Object.entries(selects)) {
      if (this.typed[key] === value) continue;
      await page.getByTestId(`tool-field-${key}`).selectOption(value);
      this.typed[key] = value;
    }
    for (const [key, value] of Object.entries(fields)) {
      if (this.typed[key] === value) continue;
      await page.getByTestId(`tool-field-${key}`).fill(value);
      this.typed[key] = value;
    }
    return this.session.acting(`tool ${toolId}`, () => page.getByTestId('tool-submit').click());
  }

  /** Levels list: click a level to make it the active one (new elements and exports use it). */
  async activateLevel(levelId: string): Promise<void> {
    const row = this.session.page.getByTestId(`level-row-${levelId}`);
    if ((await row.getAttribute('aria-current')) === 'true') return;
    await this.session.acting(`activate ${levelId}`, () =>
      row.getByRole('button', { name: /^Activate level/ }).click(),
    );
  }

  async addLevel(name: string, height: number): Promise<string> {
    const { page } = this.session;
    await page.getByLabel('New level name').fill(name);
    await page.getByLabel('New level height').fill(String(height));
    return this.session.acting(`add level ${name}`, () =>
      page.getByRole('button', { name: 'Add level', exact: true }).click(),
    );
  }

  /** True once the project information form is shown (it needs a building model). */
  projectFormVisible(): Promise<boolean> {
    return this.session.page.getByTestId('project-name').isVisible();
  }

  async setProjectInfo(info: Record<string, string>): Promise<string> {
    const { page } = this.session;
    for (const [key, value] of Object.entries(info)) {
      await page.getByTestId(`project-${key}`).fill(value);
    }
    return this.session.acting('project information', () =>
      page.getByRole('button', { name: 'Save project info' }).click(),
    );
  }

  /** Clash section: run the check and read its own result line. */
  async checkClashes(): Promise<string> {
    const { page } = this.session;
    await page.getByTestId('clash-check').click();
    return (await page.getByTestId('clash-summary').textContent()) ?? '';
  }
}
