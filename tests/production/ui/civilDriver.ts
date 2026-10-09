import { expect, type Locator } from '@playwright/test';
import type { DeliverableId, ToolCall } from '../contract';
import type { CivilIntent } from '../civil/intent';
import { BuildingPanel } from './panel';
import { runViaPalette } from './palette';
import type { UiSession } from './session';

/**
 * @layer tests/production/ui
 *
 * Maps each scripted civil tool call to the Civil / Site panel control an engineer uses: the survey
 * file input, the terrain, platform, alignment, manhole and pipe forms, the alignment editor
 * (profile, template, superelevation, report, plan-profile sheet) and the drainage check / sizing
 * row (IDF, outfall level). The command palette is the fallback when no panel control exists; each
 * such detour, and each scripted parameter the panel cannot set, is a `uiGap`.
 */

const asNumbers = (value: unknown): number[] => (Array.isArray(value) ? value.map(Number) : []);
const text = (value: unknown): string => (value === undefined ? '' : String(value));
const points = (value: unknown): string =>
  (Array.isArray(value) ? value : []).map((point) => asNumbers(point).join(',')).join('; ');
const list = (value: unknown): string => asNumbers(value).join(', ');

export class CivilUiDriver {
  readonly gaps = new Set<string>();
  readonly steps = { panel: 0, palette: 0 };
  readonly provided: Record<DeliverableId, string> = {};
  readonly fileNames: Record<string, string> = {};
  private readonly building: BuildingPanel;

  constructor(
    private readonly session: UiSession,
    private readonly intent: CivilIntent,
  ) {
    this.building = new BuildingPanel(session);
  }

  get uiGaps(): string[] {
    return [...this.gaps];
  }

  async perform(call: ToolCall): Promise<string> {
    const paletteBefore = this.steps.palette;
    const summary = await this.route(call);
    if (this.steps.palette === paletteBefore) this.steps.panel += 1;
    if (process.env['PRODUCTION_TRACE'] !== undefined) {
      process.stderr.write(`[ui civil] ${call.tool}: ${summary}\n`);
    }
    return summary;
  }

  private get page(): UiSession['page'] {
    return this.session.page;
  }

  private button(name: string): Locator {
    return this.page.getByRole('button', { name, exact: true });
  }

  private async fill(label: string, value: string): Promise<void> {
    await this.page.getByLabel(label, { exact: true }).fill(value);
  }

  private act(what: string, name: string): Promise<string> {
    return this.session.acting(what, () => this.button(name).click());
  }

  private async openSite(): Promise<void> {
    const panel = this.page.getByTestId('civil-panel');
    if (!(await panel.isVisible())) await this.page.getByRole('tab', { name: /site/i }).click();
    await expect(panel).toBeVisible();
  }

  private async take(id: DeliverableId, name: string): Promise<string> {
    const file = await this.session.download(() => this.button(name).click());
    this.provided[id] = file.text;
    this.fileNames[id] = file.name;
    return file.name;
  }

  private unsupported(tool: string, keys: string[], args: Record<string, unknown>): void {
    for (const key of keys) {
      if (args[key] !== undefined) this.gaps.add(`Civil panel: ${tool} has no field for ${key}.`);
    }
  }

  private async route(call: ToolCall): Promise<string> {
    const args = call.args;
    if (call.tool === 'set_project_info') {
      const building = this.page.getByTestId('building-panel');
      if (!(await building.isVisible()))
        await this.page.getByRole('tab', { name: 'Building' }).click();
      await expect(building).toBeVisible();
      return this.building.setProjectInfo(
        Object.fromEntries(Object.entries(args).map(([key, value]) => [key, text(value)])),
      );
    }
    await this.openSite();
    const alignment = this.intent.road.name;
    switch (call.tool) {
      case 'set_units':
        return this.act('work in metres', 'Work in metres');
      case 'import_survey_points':
        await this.page.getByLabel('Survey file').setInputFiles(this.intent.surveyPath);
        await expect(this.page.getByLabel('Survey points text')).not.toHaveValue('');
        await this.page.getByLabel('Survey format').selectOption(text(args['format']));
        await this.page.getByLabel('Survey unit').selectOption(text(args['sourceUnit']));
        await this.fill('Point group name', text(args['name']));
        return this.act('import survey', 'Import points');
      case 'create_surface':
        await this.fill('Surface name', text(args['name']));
        await this.fill('Contour interval', text(args['contourInterval']));
        await this.fill('Major contour every', text(args['majorEvery']));
        return this.act('create surface', 'Create surface');
      case 'surface_report':
        return (
          (await this.page.getByTestId(`civil-row-${text(args['surfaceId'])}`).textContent()) ?? ''
        );
      case 'add_platform':
        await this.fill('Platform outline', points(args['boundary']));
        await this.fill('Platform elevation', text(args['elevation']));
        await this.fill('Cut slope', text(args['cutSlope']));
        await this.fill('Fill slope', text(args['fillSlope']));
        await this.fill('Platform name', text(args['name']));
        return this.act('add platform', 'Add platform');
      case 'balance_platform':
        await this.fill(`Swell factor of ${this.intent.pad.name}`, text(args['swellFactor']));
        return this.act('balance platform', 'Balance');
      case 'add_alignment':
        await this.fill('Alignment points', points(args['points']));
        await this.fill('Curve radii', list(args['radii']));
        await this.fill('Spiral lengths', list(args['spirals']));
        await this.page.getByLabel('Alignment surface').selectOption(text(args['surfaceId']));
        await this.fill('Station interval', text(args['stationInterval']));
        await this.fill('Alignment name', text(args['name']));
        return this.act('add alignment', 'Add alignment');
      case 'set_alignment_profile': {
        const rows = (Array.isArray(args['pvis']) ? args['pvis'] : []).map((pvi) => {
          const { station, elevation, curveLength } = pvi as Record<string, unknown>;
          return [station, elevation, curveLength].filter((v) => v !== undefined).join(', ');
        });
        await this.fill(`Profile PVIs of ${alignment}`, rows.join('\n'));
        return this.act('set profile', 'Set profile');
      }
      case 'set_road_section':
        await this.fill(`Lane width of ${alignment}`, text(args['laneWidth']));
        await this.fill(`Shoulder width of ${alignment}`, text(args['shoulderWidth']));
        await this.fill(`Crossfall (0.025) of ${alignment}`, text(args['crossfall']));
        return this.act('set road section', 'Set road section');
      case 'set_superelevation':
        await this.fill(`Superelevation of ${alignment}`, text(args['maxRate']));
        return this.act('set superelevation', 'Set superelevation');
      case 'alignment_report':
        await this.fill(`Design speed of ${alignment}`, text(args['designSpeedKmh']));
        await this.session.download(() => this.button('Report CSV').click());
        return (
          (await this.page.getByTestId(`civil-alignment-status-alignment-1`).textContent()) ?? ''
        );
      case 'add_manhole': {
        await this.fill('Manhole position', asNumbers(args['location']).join(','));
        await this.fill('Manhole invert', text(args['invertElevation']));
        await this.page.getByLabel('Manhole surface').selectOption(text(args['surfaceId']));
        await this.fill('Manhole catchment ha', text(args['catchmentAreaHa']));
        await this.fill('Manhole runoff c', text(args['runoffCoefficient']));
        await this.fill('Manhole name', text(args['name']));
        return this.act('add manhole', 'Add manhole');
      }
      case 'add_pipe':
        await this.page.getByLabel('Pipe from').selectOption(text(args['fromId']));
        await this.page.getByLabel('Pipe to').selectOption(text(args['toId']));
        await this.fill('Pipe Manning n', text(args['manningN']));
        return this.act('add pipe', 'Add pipe');
      case 'size_drainage_pipes':
        this.unsupported(call.tool, ['minVelocity', 'diameters'], args);
        await this.fillStorm(args);
        return this.act('size pipes', 'Size pipes');
      case 'check_drainage_network':
        this.unsupported(call.tool, ['minCoverM', 'minVelocity'], args);
        await this.fillStorm(args);
        await this.fill('Outfall level', text(args['outfallLevel']));
        await this.button('Check network').click();
        return (await this.page.getByTestId('civil-drainage-status').textContent()) ?? '';
      case 'export_plan_profile_sheet':
        await this.page.getByLabel(`Sheet paper of ${alignment}`).selectOption(text(args['paper']));
        return this.take(
          `plan-profile:${text(args['alignmentId'])}:${text(args['paper'])}`,
          'Plan-profile sheet',
        );
      case 'export_landxml':
        return this.take('landxml', 'LandXML');
      default:
        this.gaps.add(
          `No Civil panel control for ${call.tool}: reachable only through the command palette.`,
        );
        this.steps.palette += 1;
        return runViaPalette(this.session, call.tool, args);
    }
  }

  private async fillStorm(args: Record<string, unknown>): Promise<void> {
    const idf = (args['idf'] ?? {}) as Record<string, unknown>;
    for (const key of ['a', 'b', 'c']) await this.fill(`IDF ${key}`, text(idf[key]));
  }
}
