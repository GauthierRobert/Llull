import { readFileSync } from 'node:fs';
import { expect, type Locator, type Page } from '@playwright/test';

/**
 * @layer tests/production/ui
 *
 * One browser session on the real app (offline mode, no llull server): console-error watch,
 * "did the command work" feedback read from the status bar, and file downloads read back from disk.
 */

/** Offline mode probes the optional llull server (architecture L6); a refused probe is expected. */
const OPTIONAL_SERVER = 'http://localhost:3001';
/** Summary prefixes / phrases of commands that changed nothing (not words inside a success). */
const REFUSED = /^\S+ (failed|rejected):|^No entity|not found\b|kernel not available|^Nothing to/i;

export interface Downloaded {
  name: string;
  text: string;
}

export class UiSession {
  readonly problems: string[] = [];
  /** Off while the app boots: the reload that clears storage aborts the first wasm download. */
  private watching = false;

  constructor(readonly page: Page) {
    page.on('console', (message) => {
      if (!this.watching || message.type() !== 'error') return;
      if (message.location().url.startsWith(OPTIONAL_SERVER)) return;
      this.problems.push(`console: ${message.text()}`);
    });
    page.on('pageerror', (error) => {
      if (this.watching) this.problems.push(`pageerror: ${error.message}`);
    });
  }

  /** Fresh app, empty document, Building panel open. */
  async start(): Promise<void> {
    await this.page.goto('/');
    await this.page.evaluate(() => window.localStorage.clear());
    await this.page.reload();
    const showPanel = this.page.getByRole('button', { name: 'Show browser panel' });
    if (await showPanel.isVisible()) await showPanel.click();
    await this.page.getByRole('tab', { name: 'Building' }).click();
    await expect(this.page.getByTestId('building-panel')).toBeVisible();
    this.watching = true;
  }

  /** "Open project" with a project file picked from disk. */
  async openProject(file: string): Promise<void> {
    await this.page.locator('[aria-label="Project file"] input[type="file"]').setInputFiles(file);
    await expect(this.page.getByLabel(/^Last command: Loaded document/)).toBeVisible({
      timeout: 120_000,
    });
  }

  /** Click out of any field and press Esc: the palette leaves its result selected. */
  async deselect(): Promise<void> {
    await this.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await this.page.keyboard.press('Escape');
    await expect(this.page.getByLabel('Selection: None')).toBeVisible();
  }

  private status(): Locator {
    return this.page.locator('.status-summary');
  }

  async summary(): Promise<string> {
    return (
      (await this.status()
        .textContent({ timeout: 1000 })
        .catch(() => null)) ?? ''
    );
  }

  /**
   * Run a UI action that dispatches a command and return the summary it produced.
   * @failure the command refused (summary says so) or a panel error shows -> throws
   */
  async acting(what: string, action: () => Promise<void>): Promise<string> {
    const before = await this.summary();
    await action();
    const reacted = await this.page
      .waitForFunction(
        (previous) =>
          (document.querySelector('.status-summary')?.textContent ?? '') !== previous ||
          document.querySelector('.panel__error') !== null,
        before,
        { timeout: 4000 },
      )
      .then(() => true)
      .catch(() => false);
    const panelError = this.page.locator('.panel__error');
    if ((await panelError.count()) > 0) {
      throw new Error(`${what}: form error "${await panelError.first().textContent()}"`);
    }
    if (!reacted) throw new Error(`${what}: the app showed no result (status still "${before}")`);
    const after = await this.summary();
    if (REFUSED.test(after)) throw new Error(`${what}: ${after}`);
    return after;
  }

  /** Click something that triggers a browser download and read the file. */
  async download(trigger: () => Promise<void>): Promise<Downloaded> {
    const [download] = await Promise.all([this.page.waitForEvent('download'), trigger()]);
    const file = await download.path();
    return { name: download.suggestedFilename(), text: readFileSync(file, 'utf8') };
  }
}
