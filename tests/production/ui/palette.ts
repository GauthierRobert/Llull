import { expect } from '@playwright/test';
import { humanizeName } from '@ui/components/commandPalette/paramForm';
import type { UiSession } from './session';

/**
 * @layer tests/production/ui
 *
 * Ctrl+K command palette: search a command, fill its generated form, Run. How an engineer reaches
 * a registry command (or a parameter) that no panel form offers.
 */

/** Text a generated form control takes for a param value (lists comma-separated, objects as JSON). */
function formText(value: unknown): string {
  if (Array.isArray(value) && value.every((item) => typeof item === 'number')) {
    return value.join(', ');
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export async function runViaPalette(
  session: UiSession,
  command: string,
  params: Record<string, unknown>,
): Promise<string> {
  const { page } = session;
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: 'Search commands' }).fill(command);
  await page.keyboard.press('Enter');
  await expect(dialog.locator('.palette-form__tool')).toHaveText(command);
  for (const [key, value] of Object.entries(params)) {
    const label = humanizeName(key);
    const field = dialog.locator('.palette-field').filter({
      has: page.locator('label', { hasText: new RegExp(`^${label}(\\*|optional)?$`) }),
    });
    const control = field.locator('input, textarea, select');
    const tag = await control.evaluate((element) => element.tagName);
    if (tag === 'SELECT') await control.selectOption(String(value));
    else await control.fill(formText(value));
  }
  return session.acting(`palette ${command}`, () =>
    dialog.getByRole('button', { name: /^Run/ }).click(),
  );
}
