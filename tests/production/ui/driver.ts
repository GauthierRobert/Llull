import type { ToolCall } from '../contract';
import { BuildingPanel } from './panel';
import { runViaPalette } from './palette';
import type { UiSession } from './session';

/**
 * @layer tests/production/ui
 *
 * Maps each scripted tool call to the control an engineer uses: Building panel forms first; the
 * command palette when no panel form carries a needed field. Every such detour is a `uiGap`.
 * No document is injected and no command is executed in the page.
 */

const GAP = {
  levelElevation:
    "Levels list 'Add level' form has only name + height (no elevation): levels can only stack on the top one.",
  projectBeforeBuilding:
    'Project information form is hidden until a building model exists: set_project_info on an empty document is reachable only through the command palette.',
  equipmentTag:
    "'Machine / equipment' form has no Tag field (tags auto-number EQ1, EQ2…): a process tag such as E-301 is reachable only through the command palette (add_equipment).",
  slabMaterial:
    "'Slab / roof' form has no Material field (grating, steel…) and always uses the default: material is reachable only through the command palette (add_slab).",
  stepEdit:
    'No panel edits an existing element or a history step (History rows are read-only, nothing edits equipment size/weight): the only identity-preserving change is the command palette edit_step_params with hand-typed JSON and a step id.',
  unmapped: (tool: string): string =>
    `No panel control for ${tool}: reachable only through the command palette.`,
} as const;

const asNumbers = (value: unknown): number[] => (Array.isArray(value) ? value.map(Number) : []);
const text = (value: unknown): string => String(value);
const degrees = (radians: number): string => String((radians * 180) / Math.PI);
const route = (points: unknown): string =>
  (Array.isArray(points) ? points : []).map((point) => asNumbers(point).join(',')).join('; ');

export class UiDriver {
  readonly gaps = new Set<string>();
  /** Tool calls done through a panel form vs the command palette. */
  readonly steps = { panel: 0, palette: 0 };
  private readonly panel: BuildingPanel;
  private levelTop = 0;

  constructor(private readonly session: UiSession) {
    this.panel = new BuildingPanel(session);
  }

  get uiGaps(): string[] {
    return [...this.gaps];
  }

  /** Levels already in the opened project (a revision starts from an issued model). */
  startFromProject(levels: ReadonlyArray<{ elevation: number; height: number }>): void {
    this.levelTop = Math.max(0, ...levels.map((level) => level.elevation + level.height));
  }

  clashCheck(): Promise<string> {
    return this.panel.checkClashes();
  }

  activateLevel(levelId: string): Promise<void> {
    return this.panel.activateLevel(levelId);
  }

  async perform(call: ToolCall): Promise<string> {
    const paletteBefore = this.steps.palette;
    const started = Date.now();
    const summary = await this.route(call);
    if (this.steps.palette === paletteBefore) this.steps.panel += 1;
    if (process.env['PRODUCTION_TRACE'] !== undefined) {
      process.stderr.write(`[ui ${Date.now() - started}ms] ${call.tool}: ${summary}\n`);
    }
    return summary;
  }

  private palette(command: string, args: Record<string, unknown>): Promise<string> {
    this.steps.palette += 1;
    return runViaPalette(this.session, command, args);
  }

  private async route(call: ToolCall): Promise<string> {
    const args = call.args;
    switch (call.tool) {
      case 'set_project_info':
        return this.setProjectInfo(args);
      case 'add_level':
        return this.addLevel(args);
      case 'add_grid_system':
        return this.panel.applyTool('grid', {
          xSpacings: asNumbers(args['xSpacings']).join(', '),
          ySpacings: asNumbers(args['ySpacings']).join(', '),
        });
      case 'add_steel_member':
        return this.onLevel(args, () => {
          const [start, end] = [asNumbers(args['start']), asNumbers(args['end'])];
          return this.panel.applyTool(
            'member',
            {
              x1: text(start[0]),
              y1: text(start[1]),
              z1: text(start[2]),
              x2: text(end[0]),
              y2: text(end[1]),
              z2: text(end[2]),
            },
            { role: text(args['role']), profile: text(args['profile']) },
          );
        });
      case 'add_slab':
        this.gaps.add(GAP.slabMaterial);
        return this.palette('add_slab', args);
      case 'add_equipment':
        if (args['mark'] !== undefined) this.gaps.add(GAP.equipmentTag);
        return this.palette('add_equipment', args);
      case 'add_slab_opening':
        return this.addSlabOpening(args);
      case 'add_stair':
        return this.onLevel(args, () => {
          const start = asNumbers(args['start']);
          return this.panel.applyTool('stair', {
            x: text(start[0]),
            y: text(start[1]),
            direction: degrees(Number(args['angle'] ?? 0)),
            width: text(args['width']),
          });
        });
      case 'add_pipe_run':
        return this.onLevel(args, () =>
          this.panel.applyTool('pipe', {
            points: route(args['points']),
            diameter: text(args['diameter']),
            service: text(args['service']),
          }),
        );
      case 'check_clashes':
        return this.panel.checkClashes();
      case 'edit_step_params':
        this.gaps.add(GAP.stepEdit);
        return this.palette('edit_step_params', args);
      default:
        this.gaps.add(GAP.unmapped(call.tool));
        return this.palette(call.tool, args);
    }
  }

  /** Panel tools place elements on the active level: activate the call's level first. */
  private async onLevel(
    args: Record<string, unknown>,
    action: () => Promise<string>,
  ): Promise<string> {
    if (typeof args['levelId'] === 'string') await this.panel.activateLevel(args['levelId']);
    return action();
  }

  private async setProjectInfo(args: Record<string, unknown>): Promise<string> {
    if (!(await this.panel.projectFormVisible())) {
      this.gaps.add(GAP.projectBeforeBuilding);
      return this.palette('set_project_info', args);
    }
    return this.panel.setProjectInfo(
      Object.fromEntries(Object.entries(args).map(([key, value]) => [key, text(value)])),
    );
  }

  private async addLevel(args: Record<string, unknown>): Promise<string> {
    if (args['elevation'] !== undefined && Number(args['elevation']) !== this.levelTop) {
      this.gaps.add(GAP.levelElevation);
    }
    const height = Number(args['height']);
    const summary = await this.panel.addLevel(text(args['name']), height);
    this.levelTop = Number(args['elevation'] ?? this.levelTop) + height;
    return summary;
  }

  private async addSlabOpening(args: Record<string, unknown>): Promise<string> {
    if (typeof args['stairId'] === 'string') {
      return this.panel.applyTool('slabOpening', {}, { source: 'stair', stairId: args['stairId'] });
    }
    const corners = (Array.isArray(args['boundary']) ? args['boundary'] : []).map(asNumbers);
    const [first, , third] = corners;
    return this.panel.applyTool(
      'slabOpening',
      {
        x1: text(first?.[0]),
        y1: text(first?.[1]),
        x2: text(third?.[0]),
        y2: text(third?.[1]),
      },
      { source: 'rectangle', slabId: text(args['slabId']) },
    );
  }
}
